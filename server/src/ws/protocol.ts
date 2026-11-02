export const WSS_CHANNEL = {
  VIDEO: 0x01,
  AUDIO: 0x02,
  CONTROL_RESPONSE: 0x03,
  TOUCH: 0x10,
  RESIZE: 0x11,
  AUTH: 0x12,
  COMMAND: 0x13,
  METRICS: 0x14,
} as const;

export const VIDEO_FLAGS = {
  KEYFRAME: 0x01,
  CONFIG: 0x02,
} as const;

export const AUDIO_FLAGS = {
  KEYFRAME: 0x01,
  CONFIG: 0x02,
} as const;
