export const CHANNEL_ID = {
  VIDEO: 0x01,
  AUDIO: 0x02,
  CONTROL_RESPONSE: 0x03,
  TOUCH: 0x10,
  RESIZE: 0x11,
  AUTH: 0x12,
  CONTROL_COMMAND: 0x13,
  METRICS: 0x14,
  TELEMETRY: 0x15,
} as const;

export type ChannelId = (typeof CHANNEL_ID)[keyof typeof CHANNEL_ID];

export const VIDEO_FLAG = {
  KEYFRAME: 0x01,
  CONFIG: 0x02,
  AVCC: 0x04,
} as const;

export const AUDIO_FLAG = {
  KEYFRAME: 0x01,
  CONFIG: 0x02,
} as const;

export const TOUCH_EVENT_TYPE = {
  TOUCH: 2,
} as const;

export const TOUCH_ACTION = {
  DOWN: 0,
  UP: 1,
  MOVE: 2,
  CANCEL: 3,
  POINTER_DOWN: 5,
  POINTER_UP: 6,
} as const;

export type TouchAction = (typeof TOUCH_ACTION)[keyof typeof TOUCH_ACTION];

export const FRAME_SIZE = {
  MEDIA_HEADER_BYTES: 14,
  RESIZE_BYTES: 7,
  TOUCH_BYTES: 33,
  MAX_TELEMETRY_BYTES: 512 * 1024,
} as const;

export const WS_CLOSE_CODE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  POLICY_VIOLATION: 1008,
  SESSION_SUPERSEDED: 4000,
  SESSION_CONFLICT: 4009,
} as const;

export type WsCloseCode = (typeof WS_CLOSE_CODE)[keyof typeof WS_CLOSE_CODE];

export const TERMINAL_WS_CLOSE_CODES = [
  WS_CLOSE_CODE.POLICY_VIOLATION,
  WS_CLOSE_CODE.SESSION_SUPERSEDED,
  WS_CLOSE_CODE.SESSION_CONFLICT,
] as const;

export const RECONNECT_BACKOFF = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
} as const;

export const STREAM_EPOCH_INITIAL = 1;
export const MAX_UINT32 = 0xffff_ffff;

export const PROTOCOL_TIMING = {
  pingIntervalMs: 1_000,
  rttStaleTimeoutMs: 5_000,
  primaryFeedbackMaxAgeMs: 5_000,
  primaryFeedbackLocalOffsetMinMs: -1_000,
  primaryFeedbackLocalOffsetMaxMs: 5_000,
  feedbackIntervalMs: 250,
  reloadPromotionGraceMs: 3_000,
  clientResizeDebounceMs: 350,
  serverResizeDebounceMs: 400,
} as const;

export const AUTH_PREFIX = {
  TOKEN: "TOKEN:",
  SECONDARY: "SECONDARY:",
} as const;

export const SPECIAL_KEYS = [
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "Space",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
] as const;

export type SpecialKey = (typeof SPECIAL_KEYS)[number];
