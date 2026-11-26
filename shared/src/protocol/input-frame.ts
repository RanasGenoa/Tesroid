import type { TouchAction } from "./constants.js";

export interface TouchFrame {
  readonly action: TouchAction;
  readonly pointerId: bigint;
  readonly x: number;
  readonly y: number;
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly pressure: number;
  readonly actionButton: number;
  readonly buttons: number;
}

export interface ResizeFrame {
  readonly width: number;
  readonly height: number;
  readonly dprX100: number;
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function encodeTouchFrame(frame: TouchFrame): Uint8Array {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function decodeTouchFrame(buffer: Uint8Array): TouchFrame {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function encodeResizeFrame(frame: ResizeFrame): Uint8Array {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function decodeResizeFrame(buffer: Uint8Array): ResizeFrame {
  throw new Error("NOT_IMPLEMENTED");
}
