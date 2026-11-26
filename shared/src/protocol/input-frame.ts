import { ProtocolError } from "../types/errors.js";
import {
  CHANNEL_ID,
  FRAME_SIZE,
  MAX_UINT32,
  TOUCH_ACTION,
  TOUCH_EVENT_TYPE,
  type TouchAction,
} from "./constants.js";

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

const MIN_INT32 = -0x8000_0000;
const MAX_INT32 = 0x7fff_ffff;
const MAX_UINT16 = 0xffff;
const MIN_INT64 = -(1n << 63n);
const MAX_INT64 = (1n << 63n) - 1n;

const VALID_TOUCH_ACTIONS = new Set<number>(Object.values(TOUCH_ACTION));

function isTouchAction(action: number): action is TouchAction {
  return VALID_TOUCH_ACTIONS.has(action);
}

function assertIntRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ProtocolError("INVALID_BINARY_FRAME", `Invalid ${label}: ${value}`);
  }
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function encodeTouchFrame(frame: TouchFrame): Uint8Array {
  if (!isTouchAction(frame.action)) {
    throw new ProtocolError("INVALID_BINARY_FRAME", `Invalid touch action: ${frame.action}`);
  }
  if (
    typeof frame.pointerId !== "bigint" ||
    frame.pointerId < MIN_INT64 ||
    frame.pointerId > MAX_INT64
  ) {
    throw new ProtocolError("INVALID_BINARY_FRAME", "Invalid Int64 pointerId");
  }
  assertIntRange(frame.x, MIN_INT32, MAX_INT32, "x");
  assertIntRange(frame.y, MIN_INT32, MAX_INT32, "y");
  assertIntRange(frame.screenWidth, 0, MAX_UINT16, "screenWidth");
  assertIntRange(frame.screenHeight, 0, MAX_UINT16, "screenHeight");
  assertIntRange(frame.pressure, 0, MAX_UINT16, "pressure");
  assertIntRange(frame.actionButton, 0, MAX_UINT32, "actionButton");
  assertIntRange(frame.buttons, 0, MAX_UINT32, "buttons");

  const output = new Uint8Array(FRAME_SIZE.TOUCH_BYTES);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  view.setUint8(0, CHANNEL_ID.TOUCH);
  view.setUint8(1, TOUCH_EVENT_TYPE.TOUCH);
  view.setUint8(2, frame.action);
  view.setBigInt64(3, frame.pointerId, false);
  view.setInt32(11, frame.x, false);
  view.setInt32(15, frame.y, false);
  view.setUint16(19, frame.screenWidth, false);
  view.setUint16(21, frame.screenHeight, false);
  view.setUint16(23, frame.pressure, false);
  view.setUint32(25, frame.actionButton, false);
  view.setUint32(29, frame.buttons, false);
  return output;
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function decodeTouchFrame(buffer: Uint8Array): TouchFrame {
  if (buffer.byteLength === 0) {
    throw new ProtocolError("FRAME_TOO_SHORT", "Empty touch frame");
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const channel = view.getUint8(0);
  if (channel !== CHANNEL_ID.TOUCH) {
    throw new ProtocolError("UNKNOWN_CHANNEL", `Expected touch channel, got ${channel}`);
  }
  if (buffer.byteLength < FRAME_SIZE.TOUCH_BYTES) {
    throw new ProtocolError(
      "FRAME_TOO_SHORT",
      `Touch frame length ${buffer.byteLength} is shorter than ${FRAME_SIZE.TOUCH_BYTES} bytes`,
    );
  }
  if (buffer.byteLength > FRAME_SIZE.TOUCH_BYTES) {
    throw new ProtocolError(
      "INVALID_BINARY_FRAME",
      `Touch frame length ${buffer.byteLength} exceeds ${FRAME_SIZE.TOUCH_BYTES} bytes`,
    );
  }

  const eventType = view.getUint8(1);
  if (eventType !== TOUCH_EVENT_TYPE.TOUCH) {
    throw new ProtocolError("INVALID_BINARY_FRAME", `Invalid touch event type: ${eventType}`);
  }

  const action = view.getUint8(2);
  if (!isTouchAction(action)) {
    throw new ProtocolError("INVALID_BINARY_FRAME", `Invalid touch action: ${action}`);
  }

  return {
    action,
    pointerId: view.getBigInt64(3, false),
    x: view.getInt32(11, false),
    y: view.getInt32(15, false),
    screenWidth: view.getUint16(19, false),
    screenHeight: view.getUint16(21, false),
    pressure: view.getUint16(23, false),
    actionButton: view.getUint32(25, false),
    buttons: view.getUint32(29, false),
  };
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function encodeResizeFrame(frame: ResizeFrame): Uint8Array {
  assertIntRange(frame.width, 0, MAX_UINT16, "width");
  assertIntRange(frame.height, 0, MAX_UINT16, "height");
  assertIntRange(frame.dprX100, 0, MAX_UINT16, "dprX100");

  const output = new Uint8Array(FRAME_SIZE.RESIZE_BYTES);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  view.setUint8(0, CHANNEL_ID.RESIZE);
  view.setUint16(1, frame.width, false);
  view.setUint16(3, frame.height, false);
  view.setUint16(5, frame.dprX100, false);
  return output;
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function decodeResizeFrame(buffer: Uint8Array): ResizeFrame {
  if (buffer.byteLength === 0) {
    throw new ProtocolError("FRAME_TOO_SHORT", "Empty resize frame");
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const channel = view.getUint8(0);
  if (channel !== CHANNEL_ID.RESIZE) {
    throw new ProtocolError("UNKNOWN_CHANNEL", `Expected resize channel, got ${channel}`);
  }
  if (buffer.byteLength < FRAME_SIZE.RESIZE_BYTES) {
    throw new ProtocolError(
      "FRAME_TOO_SHORT",
      `Resize frame length ${buffer.byteLength} is shorter than ${FRAME_SIZE.RESIZE_BYTES} bytes`,
    );
  }
  if (buffer.byteLength > FRAME_SIZE.RESIZE_BYTES) {
    throw new ProtocolError(
      "INVALID_BINARY_FRAME",
      `Resize frame length ${buffer.byteLength} exceeds ${FRAME_SIZE.RESIZE_BYTES} bytes`,
    );
  }

  return {
    width: view.getUint16(1, false),
    height: view.getUint16(3, false),
    dprX100: view.getUint16(5, false),
  };
}
