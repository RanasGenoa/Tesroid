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
import type { HoldExitReason } from "../power/ports.js";
import type { SessionConnectionId, SessionServicePort } from "../session/ports.js";
import type { SettingsRepository } from "../settings/ports.js";
import type { CatchupPacer } from "./catchup-pacer.js";
import { SocketLiveHysteresis } from "./live-hysteresis.js";
import type { BufferedMediaEntry, StreamingControlPort, StreamingLifecyclePort } from "./ports.js";
import type { MediaRingBuffer } from "./ring-buffer.js";

export interface StreamingControllerDeps {
  readonly clock: Clock;
  readonly settings: SettingsRepository;
  readonly session: SessionServicePort;
  readonly ringBuffer: MediaRingBuffer;
  readonly catchupPacer: CatchupPacer;
  readonly lifecycle: StreamingLifecyclePort;
  readonly idleToBufferSeconds?: number;
}

interface ClientBufferSnapshot {
  readonly streamEpoch: number;
  readonly videoBufferedMs: number;
  readonly audioBufferedMs: number;
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
  private lastClientBuffers: ClientBufferSnapshot | null = null;
  private lastInteractionAtMs: number | null = null;
  private disposed = false;

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
    this.commitTransition(event);
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  ingestEncodedPacket(packet: EncodedMediaPacket): void {
    if (this.disposed) {
      return;
    }
    if (!isCurrentStreamEpoch(packet.streamEpoch, this.state.streamEpoch)) {
      return;
    }
    if (shouldPauseGeneration(this.state)) {
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
    if (this.disposed) {
      return;
    }
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
    const targetBufferMs = this.deps.settings.getCurrent().stream.targetBufferMs;
    this.lastClientBuffers = {
      streamEpoch,
      videoBufferedMs: Math.max(0, Number.isFinite(videoBufferedMs) ? videoBufferedMs : 0),
      audioBufferedMs: Math.max(0, Number.isFinite(audioBufferedMs) ? audioBufferedMs : 0),
    };

    if (selectQueueKind(this.state) === "CATCHUP") {
      this.deps.catchupPacer.recordProgress({ renderedPtsUs, nowMs });
    }

    const confirmedPtsUs = BigInt(Math.round(renderedPtsUs));
    this.evaluateBufferHoldOccupancy(confirmedPtsUs);

    if (isCurrentStreamEpoch(streamEpoch, this.state.streamEpoch)) {
      this.deps.session.recordPrimaryFeedback(
        sessionId,
        streamEpoch,
        renderedPtsUs,
        targetBufferMs,
        toPrimaryPlaybackMode(this.state) ?? "LIVE",
      );
    }
  }

  // Spec: docs/specs/03-streaming-transport.md#2.2
  async handleUserInteraction(atMs: number): Promise<void> {
    if (this.disposed || !isInputAllowed(this.state)) {
      return;
    }
    this.lastInteractionAtMs = atMs;
    const preview = transitionStreamingState(this.state, {
      type: "USER_INTERACTION",
      atMs,
      newStreamEpoch: this.state.streamEpoch,
    });
    if (preview.effects.some((effect) => effect.type === "REQUEST_POWER_RESUME")) {
      await this.deps.lifecycle.requestExitBufferHold("INTERACTION", atMs);
      return;
    }
    if (preview.effects.some((effect) => effect.type === "ADVANCE_EPOCH_AND_RESET")) {
      await this.deps.lifecycle.requestInteractiveEpochReset(atMs);
      return;
    }
    this.commitTransition({
      type: "USER_INTERACTION",
      atMs,
      newStreamEpoch: this.state.streamEpoch,
    });
  }

  // Spec: docs/specs/03-streaming-transport.md#2.2
  completeInteractiveEpochReset(atMs: number, newStreamEpoch: number): void {
    this.commitTransition({
      type: "USER_INTERACTION",
      atMs,
      newStreamEpoch,
    });
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  handleSessionActivated(
    sessionId: SessionConnectionId,
    streamEpoch: number,
    lastAckPtsUs: bigint | null,
  ): void {
    if (this.disposed) {
      return;
    }
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
      // 仕様 02 §2.2: プライマリがライブ端より 300 ms 以上後方を視聴中の参加では、
      // プライマリ確認済み PTS 付近（キーフレーム境界）から追っかけ配送を開始する。
      const anchorPtsUs = this.deps.session.getPrimaryConfirmedPtsUs(streamEpoch);
      const latestMediaPtsUs = this.deps.ringBuffer.getStats().latestMediaPtsUs;
      if (anchorPtsUs !== null && latestMediaPtsUs !== null) {
        const lagMs = Number(latestMediaPtsUs - anchorPtsUs) / 1_000;
        if (lagMs >= CATCHUP_FLOW_CONSTANTS.secondaryJoinCatchupMinLagMs) {
          const joinEntries = this.deps.ringBuffer
            .sliceFromKeyframe(anchorPtsUs, CATCHUP_FLOW_CONSTANTS.keyframeLookbackMaxMs)
            .filter((entry) => entry.streamEpoch === streamEpoch && entry.mediaType === "video");
          for (const entry of joinEntries) {
            sessionRecord.transport.sendBinary(entry.frameBytes);
          }
        }
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
      this.commitTransition({
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

    const preview = transitionStreamingState(this.state, {
      type: "SESSION_ACTIVATED",
      streamEpoch,
    });
    if (preview.effects.some((effect) => effect.type === "REQUEST_POWER_RESUME")) {
      this.dispatchAsyncLifecycle(() => this.deps.lifecycle.requestExitBufferHold("LIVE_FALLBACK"));
      return;
    }
    this.commitTransition({ type: "SESSION_ACTIVATED", streamEpoch });
  }

  // Spec: docs/specs/03-streaming-transport.md#2.5
  handleStreamReset(newStreamEpoch: number): void {
    this.clearBufferAndQueues();
    this.commitTransition({ type: "STREAM_RESET", newStreamEpoch });
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.4
  handleSocketRemoved(sessionId: SessionConnectionId): void {
    this.socketHysteresis.delete(sessionId);
  }

  // Spec: docs/specs/03-streaming-transport.md#2.6
  buildPongPayload(clientTimestampMs: number): Uint8Array {
    const sync = this.deps.session.getPrimarySyncMetadata();
    const latestMediaPtsUs = this.deps.ringBuffer.getStats().latestMediaPtsUs ?? 0n;
    const confirmedPtsUs = this.deps.session.getPrimaryConfirmedPtsUs(this.state.streamEpoch);
    const clientBuffers =
      this.lastClientBuffers !== null &&
      this.lastClientBuffers.streamEpoch === this.state.streamEpoch
        ? this.lastClientBuffers
        : null;

    let serverLagMs = 0;
    if (confirmedPtsUs !== null && latestMediaPtsUs > confirmedPtsUs) {
      serverLagMs = Number(latestMediaPtsUs - confirmedPtsUs) / 1_000;
    }

    const serverRemainingBufferMs =
      confirmedPtsUs !== null && clientBuffers !== null
        ? calculateServerRemainingBufferMs(
            serverLagMs,
            clientBuffers.videoBufferedMs,
            clientBuffers.audioBufferedMs,
          )
        : Math.round(serverLagMs);

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
    this.lastClientBuffers = null;
    this.deps.session.clearPrimaryFeedback();
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
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  onPowerActive(streamEpoch: number): void {
    if (this.deps.session.hasActivePrimaryOrActing()) {
      this.commitTransition({ type: "SESSION_ACTIVATED", streamEpoch });
    }
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  onPowerSleep(): void {
    this.commitTransition({ type: "POWER_SLEEP" });
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  onPowerHoldEntered(atMs: number): void {
    this.commitTransition({ type: "HOLD_THRESHOLD_REACHED", atMs });
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  onPowerHoldExited(newStreamEpoch: number, reason: HoldExitReason, atMs?: number): void {
    if (reason === "INTERACTION") {
      this.commitTransition({
        type: "USER_INTERACTION",
        atMs: atMs ?? this.deps.clock.nowMs(),
        newStreamEpoch,
      });
      return;
    }
    this.commitTransition({ type: "HOLD_DRAINED", newStreamEpoch });
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  dispose(): void {
    this.disposed = true;
    this.cancelInteractionTimer();
    this.deps.catchupPacer.flush();
    this.deps.ringBuffer.clear();
    this.unsubscribeSettings();
    this.socketHysteresis.clear();
    this.lastClientBuffers = null;
  }

  private commitTransition(event: StreamingEvent): void {
    if (this.disposed) {
      return;
    }
    const prevKind = this.state.kind;
    const prevEpoch = this.state.streamEpoch;
    const { nextState, effects } = transitionStreamingState(this.state, event);
    this.state = nextState;

    if (nextState.streamEpoch !== prevEpoch) {
      this.lastClientBuffers = null;
      this.deps.session.clearPrimaryFeedback();
    }

    for (const effect of effects) {
      switch (effect.type) {
        case "FLUSH_CATCHUP_QUEUE":
          this.deps.catchupPacer.flush();
          break;
        case "ADVANCE_EPOCH_AND_RESET":
          this.clearBufferAndQueues();
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

  private evaluateBufferHoldOccupancy(confirmedPtsUsOverride?: bigint): void {
    const primaryConfirmedPtsUs =
      confirmedPtsUsOverride ?? this.deps.session.getPrimaryConfirmedPtsUs(this.state.streamEpoch);
    if (primaryConfirmedPtsUs === null) {
      return;
    }

    const latestGeneratedPtsUs = this.deps.ringBuffer.getStats().latestMediaPtsUs;
    const unconsumedBytes = this.deps.ringBuffer.getUnconsumedBytesAfter(primaryConfirmedPtsUs);
    const occupancy = calculateBufferHoldOccupancy({
      latestGeneratedPtsUs,
      primaryConfirmedPtsUs,
      unconsumedBytes,
      maxSeconds: this.deps.ringBuffer.getMaxSeconds(),
      maxBytes: this.deps.ringBuffer.getMaxBytes(),
    });

    switch (this.state.kind) {
      case "STANDBY":
      case "INTERACTIVE":
        return;
      case "LIVE":
      case "CATCHUP":
        if (occupancy >= BUFFER_HOLD_CONSTANTS.triggerOccupancyRatio) {
          this.dispatchAsyncLifecycle(() => this.deps.lifecycle.requestBufferHold());
        }
        return;
      case "BUFFER_HOLD":
        if (
          this.deps.session.getPrimaryAuthority() !== null &&
          occupancy <= BUFFER_HOLD_CONSTANTS.resumeOccupancyRatio
        ) {
          this.dispatchAsyncLifecycle(() => this.deps.lifecycle.requestExitBufferHold("DRAINED"));
        }
        return;
      default:
        assertNever(this.state);
    }
  }

  private startCatchupDrain(entries: readonly BufferedMediaEntry[], targetBufferMs: number): void {
    if (this.disposed) {
      return;
    }
    this.deps.catchupPacer.start(
      entries,
      targetBufferMs,
      (entry) => {
        if (this.disposed) {
          return false;
        }
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

        const confirmedPtsUs = this.deps.session.getPrimaryConfirmedPtsUs(this.state.streamEpoch);
        const clientBuffers =
          this.lastClientBuffers !== null &&
          this.lastClientBuffers.streamEpoch === this.state.streamEpoch
            ? this.lastClientBuffers
            : null;
        if (confirmedPtsUs !== null && clientBuffers !== null) {
          const aheadPtsMs = (Number(entry.ptsUs) - Number(confirmedPtsUs)) / 1_000;
          const clientBufferedMs = Math.max(
            clientBuffers.videoBufferedMs,
            clientBuffers.audioBufferedMs,
          );
          if (Math.max(aheadPtsMs, clientBufferedMs) > profile.effectiveWindowMs) {
            return false;
          }
        }

        primary.transport.sendBinary(entry.frameBytes);
        return true;
      },
      () => {
        this.dispatchEvent({ type: "CATCHUP_DRAINED" });
      },
    );
  }

  private dispatchAsyncLifecycle(task: () => Promise<void>): void {
    if (this.disposed) {
      return;
    }
    void task().catch(() => undefined);
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
    if (this.disposed) {
      return;
    }
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
