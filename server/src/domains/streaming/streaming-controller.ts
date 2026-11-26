import type { PowerState, StreamingEvent, StreamingState } from "@tesroid/shared";
import type { Clock } from "../../infra/index.js";
import type { EncodedMediaPacket } from "../encoder/ports.js";
import type { SessionConnectionId, SessionServicePort } from "../session/ports.js";
import type { SettingsRepository } from "../settings/ports.js";
import type { CatchupPacer } from "./catchup-pacer.js";
import type { StreamingControlPort, StreamingEncoderHooks, StreamingPowerHooks } from "./ports.js";
import type { MediaRingBuffer } from "./ring-buffer.js";

export interface StreamingControllerDeps {
  readonly clock: Clock;
  readonly settings: SettingsRepository;
  readonly session: SessionServicePort;
  readonly ringBuffer: MediaRingBuffer;
  readonly catchupPacer: CatchupPacer;
  readonly powerHooks: StreamingPowerHooks;
  readonly encoderHooks: StreamingEncoderHooks;
}

export class StreamingController implements StreamingControlPort {
  // Spec: docs/specs/03-streaming-transport.md#2.2
  constructor(deps: StreamingControllerDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.2
  getState(): StreamingState {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.2
  dispatchEvent(event: StreamingEvent): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  ingestEncodedPacket(packet: EncodedMediaPacket): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.6
  handlePrimaryFeedback(
    sessionId: SessionConnectionId,
    streamEpoch: number,
    renderedPtsUs: number,
    videoBufferedMs: number,
    audioBufferedMs: number,
  ): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.2
  handleUserInteraction(atMs: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  handleSessionActivated(
    sessionId: SessionConnectionId,
    streamEpoch: number,
    lastAckPtsUs: bigint | null,
  ): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.5
  handleStreamReset(newStreamEpoch: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.4
  handleSocketRemoved(sessionId: SessionConnectionId): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.6
  buildPongPayload(clientTimestampMs: number): Uint8Array {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  broadcastServerStats(stats: {
    readonly encodeFps: number;
    readonly sendBitrateKbps: number;
    readonly audioPps: number;
    readonly powerState: PowerState;
  }): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  clearBufferAndQueues(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  broadcastPowerState(state: PowerState, streamEpoch: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  onPowerSleep(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  onPowerHoldEntered(atMs: number, targetBufferMs: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  onPowerHoldExited(newStreamEpoch: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  dispose(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
