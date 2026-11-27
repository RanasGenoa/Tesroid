import {
  AUDIO_FLAG,
  assertNever,
  CATCHUP_FLOW_CONSTANTS,
  CHANNEL_ID,
  createInitialStreamingState,
  encodeClientControlFrame,
  MAX_UINT32,
  type MediaFrame,
  PROTOCOL_TIMING,
  type PrimarySyncMetadata,
  STREAM_BOUNDS,
  STREAM_EPOCH_INITIAL,
  type StreamingEffect,
  type StreamingEvent,
  type StreamingState,
  selectQueueKind,
  transitionStreamingState,
  VIDEO_FLAG,
} from "@tesroid/shared";
import {
  type ClientClock,
  type ClientTimerHandle,
  createBrowserClock,
  type WsTransportPort,
} from "../transport/ports.js";
import { AudioPlayerPipeline } from "./audio-player.js";
import { StreamEpochGate } from "./epoch-gate.js";
import { CatchupVideoQueue, LiveVideoQueue, type QueuedVideoFrame } from "./frame-queues.js";
import type {
  AudioContextFactory,
  AudioDecoderFactory,
  CanvasElementLike,
  PlaybackControllerPort,
  PlaybackStatsSnapshot,
  VideoDecoderFactory,
  VideoFrameLike,
} from "./ports.js";
import { MasterSyncClock, SYNC_CLOCK_CONSTANTS } from "./sync-clock.js";
import { Canvas2DRenderer, VideoDecoderPipeline } from "./video-decoder.js";

export type SyncPolicy = "NONE" | "DIRECT_LOW_LATENCY" | "MASTER_CLOCK";

export interface PlaybackControllerDeps {
  readonly transport: WsTransportPort;
  readonly onRequestStreamReset: () => void;
  readonly clock?: ClientClock;
  readonly videoDecoderFactory?: VideoDecoderFactory;
  readonly audioDecoderFactory?: AudioDecoderFactory;
  readonly audioContextFactory?: AudioContextFactory;
  readonly onStateChange?: (state: StreamingState) => void;
  readonly initialPrimaryAuthority?: boolean;
}

const STATIC_SCREEN_IDLE_MS = 1_000;
const FPS_WINDOW_MS = 1_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeCloseVideoFrame(frame: VideoFrameLike): void {
  try {
    frame.close();
  } catch {
    // Ignore close errors on already-closed browser frames.
  }
}

// Spec: docs/specs/04-client-playback-avsync.md#2.3
export function selectSyncPolicy(state: StreamingState): SyncPolicy {
  switch (state.kind) {
    case "STANDBY":
      return "NONE";
    case "INTERACTIVE":
      return "DIRECT_LOW_LATENCY";
    case "LIVE":
    case "CATCHUP":
    case "BUFFER_HOLD":
      return "MASTER_CLOCK";
    default:
      return assertNever(state);
  }
}

export class PlaybackController implements PlaybackControllerPort {
  private readonly deps: PlaybackControllerDeps;
  private readonly clock: ClientClock;
  private readonly epochGate = new StreamEpochGate();
  private readonly liveQueue = new LiveVideoQueue();
  private readonly catchupQueue = new CatchupVideoQueue(
    CATCHUP_FLOW_CONSTANTS.ringBufferMaxBytes,
    STREAM_BOUNDS.targetBufferMs.max,
  );
  private readonly syncClock = new MasterSyncClock();
  private readonly renderer: Canvas2DRenderer;
  private readonly videoDecoder: VideoDecoderPipeline;
  private readonly audioPlayer: AudioPlayerPipeline;

  // Single authoritative streaming state (No Boolean Soup).
  private streamingState: StreamingState = createInitialStreamingState();

  private targetFps: number = STREAM_BOUNDS.fps.default;
  private targetBufferMs: number = STREAM_BOUNDS.targetBufferMs.default;
  private isPrimaryAuthority: boolean;
  private audioEnabled = true;
  private disposed = false;

  private interactionTimer: ClientTimerHandle | null = null;
  private renderTimer: ClientTimerHandle | null = null;
  private feedbackTimer: ClientTimerHandle | null = null;

  private readonly renderedTimestampsMs: number[] = [];
  private lastRenderedAtMs: number | null = null;
  private lastRenderedPtsUs: number | null = null;
  private lastRenderTimeMs: number | null = null;
  private latestAvDriftMs = 0;
  private droppedFramesDelta = 0;
  private decoderErrorsDelta = 0;

  private lastFeedbackAtMs: number | null = null;
  private lastFeedbackBufferMs = 0;

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  constructor(deps: PlaybackControllerDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? createBrowserClock();
    this.isPrimaryAuthority = deps.initialPrimaryAuthority ?? true;
    this.renderer = new Canvas2DRenderer(this.clock);
    this.videoDecoder = new VideoDecoderPipeline(
      {
        onFrame: (frame, streamEpoch) => {
          this.handleDecodedVideoFrame(frame, streamEpoch);
        },
        onDecoderError: () => {
          this.decoderErrorsDelta += 1;
        },
        onNeedsReset: () => {
          if (!this.disposed && this.isPrimaryAuthority) {
            this.deps.onRequestStreamReset();
          }
        },
      },
      {
        clock: this.clock,
        decoderFactory: deps.videoDecoderFactory,
      },
    );
    this.audioPlayer = new AudioPlayerPipeline({
      clock: this.clock,
      decoderFactory: deps.audioDecoderFactory,
      audioContextFactory: deps.audioContextFactory,
    });
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  attachCanvas(canvas: CanvasElementLike): void {
    this.renderer.attach(canvas);
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  getStreamingState(): StreamingState {
    return this.streamingState;
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  dispatchStreamingEvent(event: StreamingEvent): void {
    if (this.disposed) {
      return;
    }
    const prevQueueKind = selectQueueKind(this.streamingState);
    const { nextState, effects } = transitionStreamingState(this.streamingState, event);
    this.streamingState = nextState;

    for (const effect of effects) {
      this.executeStreamingEffect(effect);
    }

    const nextQueueKind = selectQueueKind(nextState);
    switch (nextQueueKind) {
      case "NONE":
        this.resetPipelinesForEpoch(nextState.streamEpoch);
        this.cancelFeedbackTimer();
        break;
      case "LIVE":
        if (prevQueueKind !== "LIVE") {
          this.catchupQueue.clearAndCloseAll();
        }
        this.ensureFeedbackTimer();
        break;
      case "CATCHUP":
        if (prevQueueKind !== "CATCHUP") {
          this.liveQueue.clearAndCloseAll();
        }
        this.ensureFeedbackTimer();
        break;
      default:
        assertNever(nextQueueKind);
    }

    if (nextState.streamEpoch > this.epochGate.getActiveEpoch()) {
      this.applyEpochReset(nextState.streamEpoch);
    }

    if (nextQueueKind !== "NONE") {
      this.runSyncStep();
    }
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  handleMediaFrame(frame: MediaFrame): void {
    if (this.disposed || selectQueueKind(this.streamingState) === "NONE") {
      return;
    }

    if (frame.channel === CHANNEL_ID.VIDEO) {
      const decision = this.epochGate.evaluateVideoFrame(frame);
      if (decision.epochChanged) {
        this.syncStreamingStateEpoch(frame.streamEpoch);
        this.resetPipelinesForEpoch(frame.streamEpoch);
      }
      if (!decision.accept) {
        return;
      }

      if ((frame.flags & VIDEO_FLAG.CONFIG) !== 0) {
        void this.videoDecoder.configure(frame.payload, frame.streamEpoch);
        return;
      }

      const audioRunning = this.audioPlayer.getPlaybackPtsUs() !== null;
      this.syncClock.recordVideoArrival(this.clock.nowMs(), audioRunning);

      const isKeyframe = (frame.flags & VIDEO_FLAG.KEYFRAME) !== 0;
      const maxQueue = this.videoDecoder.getMaxQueueLimit(this.targetFps);
      if (!isKeyframe && this.videoDecoder.getDecodeQueueSize() >= maxQueue) {
        this.droppedFramesDelta += 1;
        this.epochGate.reset();
        return;
      }

      this.videoDecoder.decode(frame.payload, Number(frame.ptsUs), isKeyframe, frame.streamEpoch);
      return;
    }

    if (frame.channel === CHANNEL_ID.AUDIO) {
      if (!this.audioEnabled) {
        return;
      }

      const decision = this.epochGate.evaluateAudioFrame(frame);
      if (decision.epochChanged) {
        this.syncStreamingStateEpoch(frame.streamEpoch);
        this.resetPipelinesForEpoch(frame.streamEpoch);
      }
      if (!decision.accept) {
        return;
      }

      if ((frame.flags & AUDIO_FLAG.CONFIG) !== 0) {
        void this.audioPlayer.configure(frame.payload, frame.streamEpoch);
        return;
      }

      this.audioPlayer.decode(frame.payload, Number(frame.ptsUs), frame.streamEpoch);
      this.runSyncStep();
    }
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.4
  updatePrimarySyncRef(metadata: PrimarySyncMetadata): void {
    if (this.disposed) {
      return;
    }
    this.syncClock.updateSecondaryPrimaryRef(metadata, this.clock.nowMs());
    if (selectQueueKind(this.streamingState) !== "NONE") {
      this.runSyncStep();
    }
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  recordRttSample(rttMs: number): void {
    if (this.disposed) {
      return;
    }
    this.syncClock.recordRttSample(rttMs);
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  setTargetFps(fps: number): void {
    if (!Number.isFinite(fps)) {
      return;
    }
    this.targetFps = clamp(Math.round(fps), STREAM_BOUNDS.fps.min, STREAM_BOUNDS.fps.max);
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  setTargetBufferMs(targetBufferMs: number): void {
    if (!Number.isFinite(targetBufferMs)) {
      return;
    }
    this.targetBufferMs = clamp(
      Math.round(targetBufferMs),
      STREAM_BOUNDS.targetBufferMs.min,
      STREAM_BOUNDS.targetBufferMs.max,
    );
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  setPrimaryAuthority(isPrimary: boolean): void {
    this.isPrimaryAuthority = isPrimary;
  }

  // Spec: docs/specs/02-session-multidisplay.md#3
  setAudioEnabled(enabled: boolean): void {
    this.audioEnabled = enabled;
    this.audioPlayer.setMuted(!enabled);
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  async unlockAudioOnGesture(): Promise<void> {
    await this.audioPlayer.unlock();
    if (!this.disposed && selectQueueKind(this.streamingState) !== "NONE") {
      this.runSyncStep();
    }
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  resetForNewEpoch(newStreamEpoch: number): void {
    if (
      this.disposed ||
      !Number.isInteger(newStreamEpoch) ||
      newStreamEpoch < STREAM_EPOCH_INITIAL ||
      newStreamEpoch > MAX_UINT32 ||
      newStreamEpoch < this.epochGate.getActiveEpoch()
    ) {
      return;
    }

    if (this.streamingState.kind === "STANDBY") {
      this.syncStreamingStateEpoch(newStreamEpoch);
      this.applyEpochReset(newStreamEpoch);
      return;
    }

    this.dispatchStreamingEvent({ type: "STREAM_RESET", newStreamEpoch });
  }

  // Spec: docs/specs/08-observability.md#2.1
  getStatsSnapshot(): PlaybackStatsSnapshot {
    const nowMs = this.clock.nowMs();
    this.pruneFpsWindow(nowMs);
    const activeQueue = this.getActiveQueue();
    const localVideoBufferedMs = activeQueue !== null ? activeQueue.getMetrics().bufferedMs : 0;
    const droppedFramesDelta = this.droppedFramesDelta;
    const decoderErrorsDelta = this.decoderErrorsDelta;
    this.droppedFramesDelta = 0;
    this.decoderErrorsDelta = 0;

    return {
      renderedFps: this.renderedTimestampsMs.length,
      isStaticScreen:
        this.lastRenderedAtMs !== null && nowMs - this.lastRenderedAtMs >= STATIC_SCREEN_IDLE_MS,
      localVideoBufferedMs,
      localAudioBufferedMs: this.audioEnabled ? this.audioPlayer.getBufferedMs() : 0,
      avDriftMs: this.latestAvDriftMs,
      decodeQueueSize: this.videoDecoder.getDecodeQueueSize(),
      droppedFramesDelta,
      decoderErrorsDelta,
      frameRenderTimeMs: this.lastRenderTimeMs,
      waitingForKeyframe: this.epochGate.isWaitingForKeyframe(),
    };
  }

  // Spec: docs/specs/04-client-playback-avsync.md#3
  dispose(): void {
    this.disposed = true;
    this.cancelInteractionTimer();
    this.cancelRenderTimer();
    this.cancelFeedbackTimer();
    this.liveQueue.clearAndCloseAll();
    this.catchupQueue.clearAndCloseAll();
    this.videoDecoder.dispose();
    this.audioPlayer.dispose();
    this.renderer.dispose();
    this.syncClock.reset();
  }

  getTargetBufferMs(): number {
    return this.targetBufferMs;
  }

  private applyEpochReset(newStreamEpoch: number): void {
    this.epochGate.advanceToEpoch(newStreamEpoch);
    this.resetPipelinesForEpoch(this.epochGate.getActiveEpoch());
  }

  private syncStreamingStateEpoch(newStreamEpoch: number): void {
    if (this.streamingState.streamEpoch >= newStreamEpoch) {
      return;
    }
    this.streamingState = {
      ...this.streamingState,
      streamEpoch: newStreamEpoch,
    };
  }

  private executeStreamingEffect(effect: StreamingEffect): void {
    switch (effect.type) {
      case "FLUSH_CATCHUP_QUEUE":
        this.catchupQueue.clearAndCloseAll();
        break;
      case "ADVANCE_EPOCH_AND_RESET":
        this.applyEpochReset(effect.streamEpoch);
        break;
      case "ARM_INTERACTION_TIMER":
        this.armInteractionTimer(effect.delayMs);
        break;
      case "CANCEL_INTERACTION_TIMER":
        this.cancelInteractionTimer();
        break;
      case "REQUEST_POWER_HOLD":
      case "REQUEST_POWER_RESUME":
      case "ENTER_LIVE_HYSTERESIS":
        break;
      case "BROADCAST_STATE":
        this.deps.onStateChange?.(this.streamingState);
        break;
      default:
        assertNever(effect);
    }
  }

  private getActiveQueue(): LiveVideoQueue | CatchupVideoQueue | null {
    const queueKind = selectQueueKind(this.streamingState);
    switch (queueKind) {
      case "NONE":
        return null;
      case "LIVE":
        return this.liveQueue;
      case "CATCHUP":
        return this.catchupQueue;
      default:
        return assertNever(queueKind);
    }
  }

  private handleDecodedVideoFrame(frame: VideoFrameLike, streamEpoch: number): void {
    const activeQueue = this.getActiveQueue();
    if (this.disposed || activeQueue === null || streamEpoch !== this.epochGate.getActiveEpoch()) {
      safeCloseVideoFrame(frame);
      return;
    }

    activeQueue.push({
      streamEpoch,
      ptsUs: frame.timestamp,
      frame,
      receivedAtMs: this.clock.nowMs(),
    });
    this.droppedFramesDelta += activeQueue.consumeEvictedCount();
    this.runSyncStep();
  }

  private runSyncStep(): void {
    this.cancelRenderTimer();
    const activeQueue = this.getActiveQueue();
    const syncPolicy = selectSyncPolicy(this.streamingState);
    if (this.disposed || activeQueue === null || syncPolicy === "NONE") {
      return;
    }

    const nowMs = this.clock.nowMs();
    const audioPtsUs = this.audioEnabled ? this.audioPlayer.getPlaybackPtsUs() : null;
    if (audioPtsUs !== null) {
      this.syncClock.updateLocalAudioClock(audioPtsUs, nowMs);
    }

    if (activeQueue.peek() === null) {
      this.syncClock.notifyVideoQueueEmpty(nowMs, audioPtsUs !== null);
    }
    const jitter = this.syncClock.getJitterState();
    this.audioPlayer.setAdaptiveDelayMs(jitter.adaptiveDelayMs);
    this.audioPlayer.setHoldForVideoBuffering(jitter.isBuffering);

    if (activeQueue.peek() !== null) {
      switch (syncPolicy) {
        case "DIRECT_LOW_LATENCY":
          this.stepDirectLowLatency(activeQueue, nowMs);
          break;
        case "MASTER_CLOCK":
          this.stepMasterClockSync(activeQueue, nowMs);
          break;
        default:
          assertNever(syncPolicy);
      }
    }

    this.sendFeedbackIfDue(nowMs, audioPtsUs);
  }

  private stepDirectLowLatency(
    activeQueue: LiveVideoQueue | CatchupVideoQueue,
    nowMs: number,
  ): void {
    while (activeQueue.getMetrics().count > 1) {
      const older = activeQueue.shift();
      if (older === null) {
        break;
      }
      safeCloseVideoFrame(older.frame);
      this.droppedFramesDelta += 1;
    }

    const latest = activeQueue.peek();
    if (latest === null) {
      return;
    }
    if (latest.streamEpoch !== this.epochGate.getActiveEpoch()) {
      activeQueue.shift();
      safeCloseVideoFrame(latest.frame);
      return;
    }

    if (this.lastRenderedAtMs !== null) {
      const remaining = SYNC_CLOCK_CONSTANTS.minRenderIntervalMs - (nowMs - this.lastRenderedAtMs);
      if (remaining > 0) {
        this.scheduleRenderTimer(remaining);
        return;
      }
    }

    const item = activeQueue.shift();
    if (item === null) {
      return;
    }
    this.renderQueuedFrame(item, nowMs);
    const master = this.syncClock.getMasterClockSnapshot(nowMs);
    if (master.valid && master.audioPlaybackPtsUs !== null) {
      this.latestAvDriftMs = this.syncClock.computeSignedAvDriftMs(
        item.ptsUs,
        master.audioPlaybackPtsUs,
      );
    }
  }

  private stepMasterClockSync(
    activeQueue: LiveVideoQueue | CatchupVideoQueue,
    nowMs: number,
  ): void {
    while (true) {
      const head = activeQueue.peek();
      if (head === null) {
        break;
      }
      if (head.streamEpoch !== this.epochGate.getActiveEpoch()) {
        activeQueue.shift();
        safeCloseVideoFrame(head.frame);
        continue;
      }

      const evaluation = this.syncClock.evaluateVideoFrame(head.ptsUs, nowMs);
      this.latestAvDriftMs = evaluation.signedDriftMs;

      if (evaluation.action === "DROP_LATE") {
        activeQueue.shift();
        safeCloseVideoFrame(head.frame);
        this.droppedFramesDelta += 1;
        continue;
      }

      if (evaluation.action === "WAIT") {
        this.scheduleRenderTimer(Math.max(1, Math.ceil(evaluation.waitMs)));
        break;
      }

      const item = activeQueue.shift();
      if (item !== null) {
        this.renderQueuedFrame(item, nowMs);
      }
      if (activeQueue.peek() !== null) {
        this.scheduleRenderTimer(SYNC_CLOCK_CONSTANTS.minRenderIntervalMs);
      }
      break;
    }
  }

  private renderQueuedFrame(item: QueuedVideoFrame, nowMs: number): void {
    this.lastRenderTimeMs = this.renderer.renderFrame(item.frame);
    this.lastRenderedAtMs = nowMs;
    this.lastRenderedPtsUs = item.ptsUs;
    this.syncClock.recordFrameRendered(item.ptsUs, nowMs);
    this.renderedTimestampsMs.push(nowMs);
    this.pruneFpsWindow(nowMs);
  }

  private sendFeedbackIfDue(nowMs: number, audioPtsUs: number | null): void {
    if (!this.isPrimaryAuthority || selectQueueKind(this.streamingState) === "NONE") {
      return;
    }

    const renderedPtsUs = audioPtsUs ?? this.lastRenderedPtsUs;
    if (renderedPtsUs === null) {
      return;
    }

    const activeQueue = this.getActiveQueue();
    const videoBufferedMs = activeQueue !== null ? activeQueue.getMetrics().bufferedMs : 0;
    const audioBufferedMs = this.audioEnabled ? this.audioPlayer.getBufferedMs() : 0;
    const maxBufferMs = Math.max(videoBufferedMs, audioBufferedMs);

    const intervalElapsed =
      this.lastFeedbackAtMs === null ||
      nowMs - this.lastFeedbackAtMs >= PROTOCOL_TIMING.feedbackIntervalMs;
    const bufferChangedSignificantly =
      Math.abs(maxBufferMs - this.lastFeedbackBufferMs) >= PROTOCOL_TIMING.feedbackIntervalMs;

    if (!intervalElapsed && !bufferChangedSignificantly) {
      return;
    }

    this.lastFeedbackAtMs = nowMs;
    this.lastFeedbackBufferMs = maxBufferMs;
    this.deps.transport.sendBinary(
      encodeClientControlFrame({
        type: "PLAYBACK_FEEDBACK",
        streamEpoch: this.epochGate.getActiveEpoch(),
        renderedPtsUs: Math.round(renderedPtsUs),
        videoBufferedMs: Math.round(videoBufferedMs),
        audioBufferedMs: Math.round(audioBufferedMs),
      }),
    );
  }

  private resetPipelinesForEpoch(newStreamEpoch: number): void {
    this.cancelRenderTimer();
    this.liveQueue.clearAndCloseAll();
    this.catchupQueue.clearAndCloseAll();
    this.videoDecoder.reset(newStreamEpoch);
    this.audioPlayer.resetForNewEpoch(newStreamEpoch);
    this.syncClock.reset();
    this.renderedTimestampsMs.length = 0;
    this.lastRenderedAtMs = null;
    this.lastRenderedPtsUs = null;
    this.lastRenderTimeMs = null;
    this.latestAvDriftMs = 0;
    this.lastFeedbackAtMs = null;
    this.lastFeedbackBufferMs = 0;
  }

  private pruneFpsWindow(nowMs: number): void {
    const cutoff = nowMs - FPS_WINDOW_MS;
    while (this.renderedTimestampsMs.length > 0 && (this.renderedTimestampsMs[0] ?? 0) <= cutoff) {
      this.renderedTimestampsMs.shift();
    }
  }

  private armInteractionTimer(delayMs: number): void {
    this.cancelInteractionTimer();
    this.interactionTimer = this.clock.setTimeout(() => {
      this.interactionTimer = null;
      this.dispatchStreamingEvent({ type: "INTERACTION_TIMEOUT" });
    }, delayMs);
  }

  private cancelInteractionTimer(): void {
    if (this.interactionTimer !== null) {
      this.clock.clearTimeout(this.interactionTimer);
      this.interactionTimer = null;
    }
  }

  private scheduleRenderTimer(delayMs: number): void {
    this.cancelRenderTimer();
    this.renderTimer = this.clock.setTimeout(() => {
      this.renderTimer = null;
      this.runSyncStep();
    }, delayMs);
  }

  private cancelRenderTimer(): void {
    if (this.renderTimer !== null) {
      this.clock.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
  }

  private ensureFeedbackTimer(): void {
    if (this.feedbackTimer !== null || this.disposed) {
      return;
    }
    this.feedbackTimer = this.clock.setTimeout(() => {
      this.feedbackTimer = null;
      if (this.disposed || selectQueueKind(this.streamingState) === "NONE") {
        return;
      }
      this.runSyncStep();
      this.ensureFeedbackTimer();
    }, PROTOCOL_TIMING.feedbackIntervalMs);
  }

  private cancelFeedbackTimer(): void {
    if (this.feedbackTimer !== null) {
      this.clock.clearTimeout(this.feedbackTimer);
      this.feedbackTimer = null;
    }
  }
}
