import { ProtocolError } from "../types/errors.js";
import { CHANNEL_ID, FRAME_SIZE, MAX_UINT32, STREAM_EPOCH_INITIAL } from "./constants.js";

export type StreamEpoch = number;

export type MediaChannel = typeof CHANNEL_ID.VIDEO | typeof CHANNEL_ID.AUDIO;

export interface MediaFrame {
  readonly channel: MediaChannel;
  readonly flags: number;
  readonly streamEpoch: StreamEpoch;
  readonly ptsUs: bigint;
  readonly payload: Uint8Array;
}

const MIN_INT64 = -(1n << 63n);
const MAX_INT64 = (1n << 63n) - 1n;

function isValidMediaChannel(channel: number): channel is MediaChannel {
  return channel === CHANNEL_ID.VIDEO || channel === CHANNEL_ID.AUDIO;
}

function isValidEpoch(epoch: number): boolean {
  return Number.isInteger(epoch) && epoch >= STREAM_EPOCH_INITIAL && epoch <= MAX_UINT32;
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function encodeMediaFrame(frame: MediaFrame): Uint8Array {
  if (!isValidMediaChannel(frame.channel)) {
    throw new ProtocolError("UNKNOWN_CHANNEL", `Unsupported media channel: ${frame.channel}`);
  }
  if (!Number.isInteger(frame.flags) || frame.flags < 0 || frame.flags > 0xff) {
    throw new ProtocolError("INVALID_BINARY_FRAME", `Invalid media flags: ${frame.flags}`);
  }
  if (
    !Number.isInteger(frame.streamEpoch) ||
    frame.streamEpoch < 0 ||
    frame.streamEpoch > MAX_UINT32
  ) {
    throw new ProtocolError("INVALID_BINARY_FRAME", `Invalid streamEpoch: ${frame.streamEpoch}`);
  }
  if (typeof frame.ptsUs !== "bigint" || frame.ptsUs < MIN_INT64 || frame.ptsUs > MAX_INT64) {
    throw new ProtocolError("INVALID_BINARY_FRAME", "Invalid Int64 ptsUs value");
  }

  const output = new Uint8Array(FRAME_SIZE.MEDIA_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  view.setUint8(0, frame.channel);
  view.setUint8(1, frame.flags);
  view.setUint32(2, frame.streamEpoch, false);
  view.setBigInt64(6, frame.ptsUs, false);
  output.set(frame.payload, FRAME_SIZE.MEDIA_HEADER_BYTES);
  return output;
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function decodeMediaFrame(buffer: Uint8Array): MediaFrame {
  if (buffer.byteLength === 0) {
    throw new ProtocolError("FRAME_TOO_SHORT", "Empty media frame");
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const channel = view.getUint8(0);
  if (!isValidMediaChannel(channel)) {
    throw new ProtocolError("UNKNOWN_CHANNEL", `Unknown media channel: ${channel}`);
  }
  if (buffer.byteLength < FRAME_SIZE.MEDIA_HEADER_BYTES) {
    throw new ProtocolError(
      "FRAME_TOO_SHORT",
      `Media frame length ${buffer.byteLength} is shorter than ${FRAME_SIZE.MEDIA_HEADER_BYTES} bytes`,
    );
  }

  return {
    channel,
    flags: view.getUint8(1),
    streamEpoch: view.getUint32(2, false),
    ptsUs: view.getBigInt64(6, false),
    payload: buffer.slice(FRAME_SIZE.MEDIA_HEADER_BYTES),
  };
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function isCurrentStreamEpoch(packetEpoch: StreamEpoch, activeEpoch: StreamEpoch): boolean {
  return isValidEpoch(packetEpoch) && isValidEpoch(activeEpoch) && packetEpoch === activeEpoch;
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function nextStreamEpoch(currentEpoch: StreamEpoch): StreamEpoch {
  if (
    !Number.isInteger(currentEpoch) ||
    currentEpoch < STREAM_EPOCH_INITIAL ||
    currentEpoch >= MAX_UINT32
  ) {
    return STREAM_EPOCH_INITIAL;
  }
  return currentEpoch + 1;
}
