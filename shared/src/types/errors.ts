export type SharedErrorCode =
  | "INVALID_BINARY_FRAME"
  | "FRAME_TOO_SHORT"
  | "UNKNOWN_CHANNEL"
  | "INVALID_CONTROL_JSON"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_PIN"
  | "INVALID_TIMEZONE"
  | "INVALID_QUALITY_PRESET"
  | "INVALID_SETTINGS"
  | "INVALID_PRESET_FOR_BACKEND"
  | "INVALID_CLIENT_PROFILE"
  | "INVALID_FAVORITE"
  | "DUPLICATE_FAVORITE_URL"
  | "FAVORITES_LIMIT_EXCEEDED"
  | "INVALID_URL_SCHEME"
  | "INVALID_DIMENSIONS"
  | "INVALID_BITRATE";

export type ProtocolErrorCode = Extract<
  SharedErrorCode,
  | "INVALID_BINARY_FRAME"
  | "FRAME_TOO_SHORT"
  | "UNKNOWN_CHANNEL"
  | "INVALID_CONTROL_JSON"
  | "PAYLOAD_TOO_LARGE"
>;

export class SharedValidationError extends Error {
  readonly code: SharedErrorCode;
  readonly field?: string;

  constructor(code: SharedErrorCode, message: string, field?: string) {
    super(message);
    this.name = "SharedValidationError";
    this.code = code;
    this.field = field;
  }
}

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}
