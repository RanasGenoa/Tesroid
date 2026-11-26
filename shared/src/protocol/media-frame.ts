import type { CHANNEL_ID } from "./constants.js";

export type StreamEpoch = number;

export type MediaChannel = typeof CHANNEL_ID.VIDEO | typeof CHANNEL_ID.AUDIO;

export interface MediaFrame {
  readonly channel: MediaChannel;
  readonly flags: number;
  readonly streamEpoch: StreamEpoch;
  readonly ptsUs: bigint;
  readonly payload: Uint8Array;
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function encodeMediaFrame(frame: MediaFrame): Uint8Array {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function decodeMediaFrame(buffer: Uint8Array): MediaFrame {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function isCurrentStreamEpoch(packetEpoch: StreamEpoch, activeEpoch: StreamEpoch): boolean {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function nextStreamEpoch(currentEpoch: StreamEpoch): StreamEpoch {
  throw new Error("NOT_IMPLEMENTED");
}
