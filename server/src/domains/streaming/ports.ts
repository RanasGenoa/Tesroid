import type { PowerState, StreamingEvent, StreamingState } from "@tesroid/shared";
import type { EncodedMediaPacket } from "../encoder/ports.js";
import type { PowerStreamingPort } from "../power/ports.js";
import type { SessionConnectionId } from "../session/ports.js";

export interface BufferedMediaEntry {
  readonly mediaType: "video" | "audio";
  readonly flags: number;
  readonly streamEpoch: number;
  readonly ptsUs: bigint;
  readonly isKeyframe: boolean;
  readonly frameBytes: Uint8Array;
}

export interface StreamingPowerHooks {
  requestHold(targetBufferMs: number): Promise<void>;
  requestResumeFromHold(reason: "DRAINED" | "INTERACTION" | "RESET"): Promise<void>;
}

export interface StreamingEncoderHooks {
  advanceEpochAndReset(): Promise<number>;
}

export interface StreamingControlPort extends PowerStreamingPort {
  getState(): StreamingState;
  dispatchEvent(event: StreamingEvent): void;
  ingestEncodedPacket(packet: EncodedMediaPacket): void;
  handlePrimaryFeedback(
    sessionId: SessionConnectionId,
    streamEpoch: number,
    renderedPtsUs: number,
    videoBufferedMs: number,
    audioBufferedMs: number,
  ): void;
  handleUserInteraction(atMs: number): void;
  handleSessionActivated(
    sessionId: SessionConnectionId,
    streamEpoch: number,
    lastAckPtsUs: bigint | null,
  ): void;
  handleStreamReset(newStreamEpoch: number): void;
  handleSocketRemoved(sessionId: SessionConnectionId): void;
  buildPongPayload(clientTimestampMs: number): Uint8Array;
  broadcastServerStats(stats: {
    readonly encodeFps: number;
    readonly sendBitrateKbps: number;
    readonly audioPps: number;
    readonly powerState: PowerState;
  }): void;
  dispose(): void;
}
