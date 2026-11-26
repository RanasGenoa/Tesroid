import {
  AUDIO_FLAG,
  assertNever,
  BUFFER_HOLD_CONSTANTS,
  CATCHUP_FLOW_CONSTANTS,
  CHANNEL_ID,
  calculateBufferHoldOccupancy,
  calculateServerRemainingBufferMs,
  createInitialStreamingState,
  encodeMediaFrame,
  encodeServerControlFrame,
  isCurrentStreamEpoch,
  isInputAllowed,
  nextStreamEpoch,
  type PowerState,
  type PrimaryPlaybackMode,
  type StreamingEvent,
  type StreamingState,
  selectQueueKind,
  shouldPauseGeneration,
  shouldSuppressMediaSend,
  transitionStreamingState,
  VIDEO_FLAG,
} from "@tesroid/shared";
import type { Clock, TimerHandle } from "../../infra/index.js";
import type { EncodedMediaPacket } from "../encoder/ports.js";
import type { SessionConnectionId, SessionServicePort } from "../session/ports.js";
import type { SettingsRepository } from "../settings/ports.js";
import type { CatchupPacer } from "./catchup-pacer.js";
import { SocketLiveHysteresis } from "./live-hysteresis.js";
import type {
  BufferedMediaEntry,
  StreamingControlPort,
  StreamingEncoderHooks,
  StreamingPowerHooks,
} from "./ports.js";
import type { MediaRingBuffer } from "./ring-buffer.js";

export interface StreamingControllerDeps {
  readonly clock: Clock;
  readonly settings: SettingsRepository;
  readonly session: SessionServicePort;
  readonly ringBuffer: MediaRingBuffer;
  readonly catchupPacer: CatchupPacer;
  readonly powerHooks: StreamingPowerHooks;
  readonly encoderHooks: StreamingEncoderHooks;
  readonly idleToBufferSeconds?: number;
}

interface PrimaryFeedbackSnapshot {
  readonly streamEpoch: number;
  readonly renderedPtsUs: number;
  readonly videoBufferedMs: number;
  readonly audioBufferedMs: number;
  readonly receivedAtMs: number;
}

interface TransitionOptions {
  readonly suppressPowerHook?: boolean;
  readonly suppressEncoderHook?: boolean;
  readonly holdResumeReason?: "DRAINED" | "INTERACTION" | "RESET" | "LIVE_FALLBACK";
}

function isConfigPacket(packet: EncodedMediaPacket): boolean {
  return packet.mediaType === "video"
    ? (packet.flags & VIDEO_FLAG.CONFIG) !== 0
    : (packet.flags & AUDIO_FLAG.CONFIG) !== 0;
}

function isKeyframePacket(packet: EncodedMediaPacket): boolean {
  return packet.mediaType === "video"
    ? (packet.flags & VIDEO_FLAG.KEYFRAME) !== 0
    : (packet.flags & AUDIO_FLAG.KEYFRAME) !== 0;
}

function toPrimaryPlaybackMode(state: StreamingState): PrimaryPlaybackMode | null {
  switch (state.kind) {
    case "STANDBY":
      return null;
    case "INTERACTIVE":
    case "LIVE":
    case "CATCHUP":
    case "BUFFER_HOLD":
      return state.kind;
    default:
      return assertNever(state);
  }
}

export class StreamingController implements StreamingControlPort {
  private readonly deps: StreamingControllerDeps;
  private readonly idleToBufferMs: number;
  private readonly socketHysteresis = new Map<SessionConnectionId, SocketLiveHysteresis>();
  private readonly unsubscribeSettings: () => void;

  private state: StreamingState = createInitialStreamingState();
  private interactionTimer: TimerHandle | null = null;
  private lastPrimaryFeedback: PrimaryFeedbackSnapshot | null = null;
  private lastSentPrimaryPts: { readonly streamEpoch: number; readonly ptsUs: bigint } | null =
    null;
  private lastInteractionAtMs: number | null = null;

  // Spec: docs/specs/03-streaming-transport.md#2.2
  constructor(deps: StreamingControllerDeps) {
    this.deps = deps;
    const idleSeconds =
      deps.idleToBufferSeconds !== undefined &&
      Number.isFinite(deps.idleToBufferSeconds) &&
      deps.idleToBufferSeconds >= 0
        ? deps.idleToBufferSeconds
        : CATCHUP_FLOW_CONSTANTS.idleToBufferSeconds;
    this.idleToBufferMs = Math.round(idleSeconds * 1_000);

    this.unsubscribeSettings = deps.settings.subscribe((updated) => {
      for (const hysteresis of this.socketHysteresis.values()) {
        hysteresis.updateBitrate(updated.stream.videoBitrate);
      }
    });
  }

  // Spec: docs/specs/03-streaming-transport.md#2.2
  getState(): StreamingState {
    return this.state;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.2
  dispatchEvent(event: StreamingEvent): void {
    this.applyTransition(event);
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  ingestEncodedPacket(packet: EncodedMediaPacket): void {
    if (!isCurrentStreamEpoch(packet.streamEpoch, this.state.streamEpoch)) {
      return;
    }
    if (shouldPauseGeneration(this.state) || shouldSuppressMediaSend(this.state)) {
      return;
    }

    const isConfig = isConfigPacket(packet);
    const frameBytes = encodeMediaFrame({
      channel: packet.mediaType === "video" ? CHANNEL_ID.VIDEO : CHANNEL_ID.AUDIO,
      flags: packet.flags,
      streamEpoch: packet.streamEpoch,
      ptsUs: packet.ptsUs,
      payload: packet.payload,
    });
    const entry: BufferedMediaEntry = {
      mediaType: packet.mediaType,
      flags: packet.flags,
      streamEpoch: packet.streamEpoch,
      ptsUs: packet.ptsUs,
      isKeyframe: isKeyframePacket(packet),
      frameBytes,
    };

    this.deps.ringBuffer.push(entry, isConfig);

    const primary = this.deps.session.getPrimaryAuthority();
    if (primary !== null) {
      const queueKind = selectQueueKind(this.state);
      if (queueKind === "CATCHUP") {
        if (isConfig) {
          primary.transport.sendBinary(frameBytes);
        } else {
          this.deps.catchupPacer.enqueue(entry);
        }
      } else if (queueKind === "LIVE") {
        if (isConfig) {
          primary.transport.sendBinary(frameBytes);
        } else {
          const hysteresis = this.getOrCreateHysteresis(primary.id);
          const decision = hysteresis.evaluatePacket(
            entry.mediaType,
            entry.isKeyframe,
            primary.transport.getBufferedAmount(),
          );
          if (decision.congestionTriggered) {
            this.dispatchEvent({ type: "SOCKET_CONGESTED" });
          }
          if (decision.send) {
            primary.transport.sendBinary(frameBytes);
            this.lastSentPrimaryPts = { streamEpoch: packet.streamEpoch, ptsUs: packet.ptsUs };
          }
        }
      }
    }

    if (packet.mediaType === "video") {
      for (const secondary of this.deps.session.getStreamingSecondaries()) {
        if (isConfig) {
          secondary.transport.sendBinary(frameBytes);
          continue;
        }
        const hysteresis = this.getOrCreateHysteresis(secondary.id);
        const decision = hysteresis.evaluatePacket(
          "video",
          entry.isKeyframe,
          secondary.transport.getBufferedAmount(),
        );
        if (decision.send) {
          secondary.transport.sendBinary(frameBytes);
        }
      }
    }

    if (!isConfig) {
      this.evaluateBufferHoldOccupancy();
    }
  }

  // Spec: docs/specs/03-streaming-transport.md#2.6
  handlePrimaryFeedback(
    sessionId: SessionConnectionId,
    streamEpoch: number,
    renderedPtsUs: number,
    videoBufferedMs: number,
    audioBufferedMs: number,
  ): void {
    const primary = this.deps.session.getPrimaryAuthority();
    if (primary === null || primary.id !== sessionId) {
      return;
    }
    if (!isCurrentStreamEpoch(streamEpoch, this.state.streamEpoch)) {
      return;
    }
    if (!Number.isFinite(renderedPtsUs)) {
      return;
    }

    const nowMs = this.deps.clock.nowMs();
    this.lastPrimaryFeedback = {
      streamEpoch,
      renderedPtsUs,
      videoBufferedMs: Math.max(0, Number.isFinite(videoBufferedMs) ? videoBufferedMs : 0),
      audioBufferedMs: Math.max(0, Number.isFinite(audioBufferedMs) ? audioBufferedMs : 0),
      receivedAtMs: nowMs,
    };

    if (selectQueueKind(this.state) === "CATCHUP") {
      this.deps.catchupPacer.recordProgress({ renderedPtsUs, nowMs });
    }
    this.evaluateBufferHoldOccupancy();
  }

  // Spec: docs/specs/03-streaming-transport.md#2.2
  handleUserInteraction(atMs: number): void {
    if (!isInputAllowed(this.state)) {
      return;
    }
    this.lastInteractionAtMs = atMs;
    const newStreamEpoch =
      this.state.kind === "CATCHUP" || this.state.kind === "BUFFER_HOLD"
        ? nextStreamEpoch(this.state.streamEpoch)
        : this.state.streamEpoch;
    this.applyTransition(
      { type: "USER_INTERACTION", atMs, newStreamEpoch },
      { holdResumeReason: "INTERACTION" },
    );
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  handleSessionActivated(
    sessionId: SessionConnectionId,
    streamEpoch: number,
    lastAckPtsUs: bigint | null,
  ): void {
    this.getOrCreateHysteresis(sessionId);
    const sessionRecord = this.deps.session.getSession(sessionId);
    if (sessionRecord === null || sessionRecord.role === "SECONDARY_STANDBY") {
      return;
    }

    if (sessionRecord.role === "SECONDARY_STREAMING") {
      const videoConfig = this.deps.ringBuffer.getVideoConfig();
      if (videoConfig !== null && videoConfig.streamEpoch === streamEpoch) {
        sessionRecord.transport.sendBinary(videoConfig.frameBytes);
      }
      return;
    }

    this.sendCurrentConfigsToPrimary(sessionRecord.transport, streamEpoch);

    const isIdle =
      this.lastInteractionAtMs === null ||
      this.deps.clock.nowMs() - this.lastInteractionAtMs > this.idleToBufferMs;
    const catchupEntries =
      lastAckPtsUs !== null && isIdle
        ? this.deps.ringBuffer
            .sliceFromKeyframe(lastAckPtsUs, CATCHUP_FLOW_CONSTANTS.keyframeLookbackMaxMs)
            .filter((entry) => entry.streamEpoch === streamEpoch)
        : [];

    if (catchupEntries.length > 0 && catchupEntries[0] !== undefined) {
      const targetBufferMs = this.deps.settings.getCurrent().stream.targetBufferMs;
      this.applyTransition({
        type: "SESSION_ACTIVATED",
        streamEpoch,
        resumeCatchup: {
          targetBufferMs,
          resumePtsUs: Number(catchupEntries[0].ptsUs),
        },
      });
      this.startCatchupDrain(catchupEntries, targetBufferMs);
      return;
    }

    this.applyTransition(
      { type: "SESSION_ACTIVATED", streamEpoch },
      { holdResumeReason: "LIVE_FALLBACK", suppressEncoderHook: true },
    );
  }

  // Spec: docs/specs/03-streaming-transport.md#2.5
  handleStreamReset(newStreamEpoch: number): void {
    this.clearBufferAndQueues();
    if (this.state.kind === "STANDBY") {
      if (this.deps.session.hasActivePrimaryOrActing()) {
        this.applyTransition(
          { type: "SESSION_ACTIVATED", streamEpoch: newStreamEpoch },
          { suppressEncoderHook: true, suppressPowerHook: true },
        );
      }
      return;
    }
    this.applyTransition(
      { type: "STREAM_RESET", newStreamEpoch },
      { suppressEncoderHook: true, suppressPowerHook: true },
    );
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.4
  handleSocketRemoved(sessionId: SessionConnectionId): void {
    this.socketHysteresis.delete(sessionId);
  }

  // Spec: docs/specs/03-streaming-transport.md#2.6
  buildPongPayload(clientTimestampMs: number): Uint8Array {
    const sync = this.deps.session.getPrimarySyncMetadata();
    const latestMediaPtsUs = this.deps.ringBuffer.getStats().latestMediaPtsUs ?? 0n;

    let serverLagMs = 0;
    if (
      this.lastPrimaryFeedback !== null &&
      this.lastPrimaryFeedback.streamEpoch === this.state.streamEpoch &&
      latestMediaPtsUs > 0n
    ) {
      serverLagMs = Math.max(
        0,
        (Number(latestMediaPtsUs) - this.lastPrimaryFeedback.renderedPtsUs) / 1_000,
      );
    }

    const serverRemainingBufferMs =
      this.lastPrimaryFeedback !== null &&
      this.lastPrimaryFeedback.streamEpoch === this.state.streamEpoch
        ? calculateServerRemainingBufferMs(
            serverLagMs,
            this.lastPrimaryFeedback.videoBufferedMs,
            this.lastPrimaryFeedback.audioBufferedMs,
          )
        : 0;

    return encodeServerControlFrame({
      type: "PONG",
      clientTimestampMs,
      serverTimestampMs: this.deps.clock.nowMs(),
      latestMediaPtsUs: Number(latestMediaPtsUs),
      mode: toPrimaryPlaybackMode(this.state),
      serverRemainingBufferMs,
      primaryRenderedPts: sync.primaryRenderedPts,
      primaryFeedbackAgeMs: sync.primaryFeedbackAgeMs,
      primaryTargetBufferMs: sync.primaryTargetBufferMs,
      primaryMode: sync.primaryMode,
    });
  }

  // Spec: docs/specs/08-observability.md#2.1
  broadcastServerStats(stats: {
    readonly encodeFps: number;
    readonly sendBitrateKbps: number;
    readonly audioPps: number;
    readonly powerState: PowerState;
  }): void {
    const frame = encodeServerControlFrame({
      type: "SERVER_STATS",
      stats: {
        timestamp: this.deps.clock.nowMs(),
        encodeFps: stats.encodeFps,
        sendBitrateKbps: stats.sendBitrateKbps,
        audioPps: stats.audioPps,
        powerState: stats.powerState,
      },
    });
    this.broadcastToStreamingSessions(frame);
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  clearBufferAndQueues(): void {
    this.deps.ringBuffer.clear();
    this.deps.catchupPacer.flush();
    for (const hysteresis of this.socketHysteresis.values()) {
      hysteresis.reset();
    }
    this.lastPrimaryFeedback = null;
    this.lastSentPrimaryPts = null;
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  broadcastPowerState(state: PowerState, streamEpoch: number): void {
    const frame = encodeServerControlFrame({
      type: "BROWSER_STATUS",
      powerState: state,
      streamEpoch,
    });
    for (const client of this.deps.session.getAllSessions()) {
      client.transport.sendBinary(frame);
    }

    if (state === "ACTIVE" && this.deps.session.hasActivePrimaryOrActing()) {
      if (
        this.state.kind === "STANDBY" ||
        (this.state.streamEpoch !== streamEpoch && this.state.kind !== "BUFFER_HOLD")
      ) {
        this.applyTransition(
          { type: "SESSION_ACTIVATED", streamEpoch },
          { suppressEncoderHook: true, suppressPowerHook: true },
        );
      }
    }
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  onPowerSleep(): void {
    this.applyTransition(
      { type: "POWER_SLEEP" },
      { suppressPowerHook: true, suppressEncoderHook: true },
    );
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  onPowerHoldEntered(atMs: number): void {
    this.applyTransition({ type: "HOLD_THRESHOLD_REACHED", atMs }, { suppressPowerHook: true });
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  onPowerHoldExited(newStreamEpoch: number): void {
    this.applyTransition(
      { type: "HOLD_DRAINED", newStreamEpoch },
      { suppressPowerHook: true, suppressEncoderHook: true },
    );
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  dispose(): void {
    this.cancelInteractionTimer();
    this.deps.catchupPacer.flush();
    this.unsubscribeSettings();
    this.socketHysteresis.clear();
  }

  private applyTransition(event: StreamingEvent, options?: TransitionOptions): void {
    const prevKind = this.state.kind;
    const { nextState, effects } = transitionStreamingState(this.state, event);
    this.state = nextState;

    const hasPowerResumeEffect = effects.some((effect) => effect.type === "REQUEST_POWER_RESUME");

    for (const effect of effects) {
      switch (effect.type) {
        case "FLUSH_CATCHUP_QUEUE":
          this.deps.catchupPacer.flush();
          break;
        case "ADVANCE_EPOCH_AND_RESET":
          this.clearBufferAndQueues();
          if (!options?.suppressEncoderHook && !hasPowerResumeEffect) {
            void this.deps.encoderHooks.advanceEpochAndReset();
          }
          break;
        case "ARM_INTERACTION_TIMER":
          this.armInteractionTimer(effect.delayMs);
          break;
        case "CANCEL_INTERACTION_TIMER":
          this.cancelInteractionTimer();
          break;
        case "REQUEST_POWER_HOLD":
          if (!options?.suppressPowerHook) {
            void this.deps.powerHooks.requestHold();
          }
          break;
        case "REQUEST_POWER_RESUME":
          if (!options?.suppressPowerHook) {
            void this.deps.powerHooks.requestResumeFromHold(options?.holdResumeReason ?? "RESET");
          }
          break;
        case "ENTER_LIVE_HYSTERESIS":
          break;
        case "BROADCAST_STATE":
          this.broadcastStreamingState(prevKind, nextState);
          break;
        default:
          assertNever(effect);
      }
    }
  }

  private broadcastStreamingState(
    prevKind: StreamingState["kind"],
    nextState: StreamingState,
  ): void {
    this.broadcastToStreamingSessions(
      encodeServerControlFrame({
        type: "STREAM_STATE",
        state: nextState,
      }),
    );

    if (prevKind !== "BUFFER_HOLD" && nextState.kind === "BUFFER_HOLD") {
      this.broadcastToStreamingSessions(
        encodeServerControlFrame({
          type: "BUFFER_HOLD",
          active: true,
          streamEpoch: nextState.streamEpoch,
        }),
      );
    } else if (prevKind === "BUFFER_HOLD" && nextState.kind !== "BUFFER_HOLD") {
      this.broadcastToStreamingSessions(
        encodeServerControlFrame({
          type: "BUFFER_HOLD",
          active: false,
          streamEpoch: nextState.streamEpoch,
        }),
      );
    }
  }

  private broadcastToStreamingSessions(frame: Uint8Array): void {
    const primary = this.deps.session.getPrimaryAuthority();
    if (primary !== null) {
      primary.transport.sendBinary(frame);
    }
    for (const secondary of this.deps.session.getStreamingSecondaries()) {
      secondary.transport.sendBinary(frame);
    }
  }

  private evaluateBufferHoldOccupancy(): void {
    if (this.state.kind === "LIVE" || this.state.kind === "CATCHUP") {
      const feedback =
        this.lastPrimaryFeedback !== null &&
        this.lastPrimaryFeedback.streamEpoch === this.state.streamEpoch
          ? this.lastPrimaryFeedback
          : null;
      const sent =
        this.lastSentPrimaryPts !== null &&
        this.lastSentPrimaryPts.streamEpoch === this.state.streamEpoch
          ? this.lastSentPrimaryPts.ptsUs
          : null;

      const consumedPtsUs = feedback !== null ? BigInt(Math.round(feedback.renderedPtsUs)) : sent;
      const unconsumed = this.deps.ringBuffer.getUnconsumedStats(consumedPtsUs);
      const clientBufferedMs =
        feedback !== null ? Math.max(feedback.videoBufferedMs, feedback.audioBufferedMs) : 0;
      const effectiveDurationMs = Math.max(unconsumed.unconsumedDurationMs, clientBufferedMs);

      const occupancy = calculateBufferHoldOccupancy(
        effectiveDurationMs,
        this.deps.ringBuffer.getMaxSeconds(),
        unconsumed.unconsumedBytes,
        this.deps.ringBuffer.getMaxBytes(),
      );
      if (occupancy >= BUFFER_HOLD_CONSTANTS.triggerOccupancyRatio) {
        this.dispatchEvent({
          type: "HOLD_THRESHOLD_REACHED",
          atMs: this.deps.clock.nowMs(),
        });
      }
      return;
    }

    if (this.state.kind === "BUFFER_HOLD") {
      if (this.deps.session.getPrimaryAuthority() === null) {
        return;
      }
      const sentPtsUs =
        this.lastSentPrimaryPts !== null &&
        this.lastSentPrimaryPts.streamEpoch === this.state.streamEpoch
          ? this.lastSentPrimaryPts.ptsUs
          : null;
      const feedbackPtsUs =
        this.lastPrimaryFeedback !== null &&
        this.lastPrimaryFeedback.streamEpoch === this.state.streamEpoch
          ? BigInt(Math.round(this.lastPrimaryFeedback.renderedPtsUs))
          : null;

      if (sentPtsUs === null && feedbackPtsUs === null) {
        return;
      }

      const consumedPtsUs =
        sentPtsUs !== null && feedbackPtsUs !== null
          ? sentPtsUs > feedbackPtsUs
            ? sentPtsUs
            : feedbackPtsUs
          : (sentPtsUs ?? feedbackPtsUs);
      const unconsumed = this.deps.ringBuffer.getUnconsumedStats(consumedPtsUs);
      const occupancy = calculateBufferHoldOccupancy(
        unconsumed.unconsumedDurationMs,
        this.deps.ringBuffer.getMaxSeconds(),
        unconsumed.unconsumedBytes,
        this.deps.ringBuffer.getMaxBytes(),
      );
      if (occupancy <= BUFFER_HOLD_CONSTANTS.resumeOccupancyRatio) {
        this.applyTransition(
          {
            type: "HOLD_DRAINED",
            newStreamEpoch: nextStreamEpoch(this.state.streamEpoch),
          },
          { holdResumeReason: "DRAINED" },
        );
      }
    }
  }

  private startCatchupDrain(entries: readonly BufferedMediaEntry[], targetBufferMs: number): void {
    this.deps.catchupPacer.start(
      entries,
      targetBufferMs,
      (entry) => {
        if (!isCurrentStreamEpoch(entry.streamEpoch, this.state.streamEpoch)) {
          return true;
        }
        if (shouldSuppressMediaSend(this.state)) {
          return false;
        }
        const primary = this.deps.session.getPrimaryAuthority();
        if (primary === null) {
          return false;
        }

        const profile = this.deps.catchupPacer.getFlowProfile();
        if (primary.transport.getBufferedAmount() > profile.socketGuardBytes) {
          this.deps.catchupPacer.recordSocketStall();
          return false;
        }

        if (
          this.lastPrimaryFeedback !== null &&
          this.lastPrimaryFeedback.streamEpoch === this.state.streamEpoch
        ) {
          const aheadPtsMs = (Number(entry.ptsUs) - this.lastPrimaryFeedback.renderedPtsUs) / 1_000;
          const clientBufferedMs = Math.max(
            this.lastPrimaryFeedback.videoBufferedMs,
            this.lastPrimaryFeedback.audioBufferedMs,
          );
          if (Math.max(aheadPtsMs, clientBufferedMs) > profile.effectiveWindowMs) {
            return false;
          }
        }

        primary.transport.sendBinary(entry.frameBytes);
        this.lastSentPrimaryPts = { streamEpoch: entry.streamEpoch, ptsUs: entry.ptsUs };
        if (this.state.kind === "BUFFER_HOLD") {
          this.evaluateBufferHoldOccupancy();
        }
        return true;
      },
      () => {
        if (this.state.kind === "BUFFER_HOLD") {
          this.evaluateBufferHoldOccupancy();
        } else {
          this.dispatchEvent({ type: "CATCHUP_DRAINED" });
        }
      },
    );
  }

  private sendCurrentConfigsToPrimary(
    transport: { sendBinary(data: Uint8Array): void },
    streamEpoch: number,
  ): void {
    const videoConfig = this.deps.ringBuffer.getVideoConfig();
    if (videoConfig !== null && videoConfig.streamEpoch === streamEpoch) {
      transport.sendBinary(videoConfig.frameBytes);
    }
    const audioConfig = this.deps.ringBuffer.getAudioConfig();
    if (audioConfig !== null && audioConfig.streamEpoch === streamEpoch) {
      transport.sendBinary(audioConfig.frameBytes);
    }
  }

  private getOrCreateHysteresis(sessionId: SessionConnectionId): SocketLiveHysteresis {
    let instance = this.socketHysteresis.get(sessionId);
    if (instance === undefined) {
      instance = new SocketLiveHysteresis(this.deps.settings.getCurrent().stream.videoBitrate);
      this.socketHysteresis.set(sessionId, instance);
    }
    return instance;
  }

  private armInteractionTimer(delayMs: number): void {
    this.cancelInteractionTimer();
    this.interactionTimer = this.deps.clock.setTimeout(() => {
      this.interactionTimer = null;
      this.dispatchEvent({ type: "INTERACTION_TIMEOUT" });
    }, delayMs);
  }

  private cancelInteractionTimer(): void {
    if (this.interactionTimer !== null) {
      this.deps.clock.clearTimeout(this.interactionTimer);
      this.interactionTimer = null;
    }
  }
}
