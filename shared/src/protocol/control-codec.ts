import type { StreamingState } from "../state/index.js";
import { ProtocolError } from "../types/errors.js";
import {
  type ClientMetricsSample,
  TELEMETRY_CATEGORIES,
  type TelemetryCategory,
  type TelemetryEventInput,
} from "../types/observability.js";
import { POWER_STATES, type PowerState } from "../types/power.js";
import { type PrimaryPlaybackMode, SESSION_ROLES, type SessionRole } from "../types/session.js";
import {
  AUTH_PREFIX,
  CHANNEL_ID,
  type ChannelId,
  FRAME_SIZE,
  RECONNECT_BACKOFF,
  SPECIAL_KEYS,
  type SpecialKey,
  TERMINAL_WS_CLOSE_CODES,
} from "./constants.js";
import type {
  AuthPayload,
  ClientControlMessage,
  ServerControlMessage,
  TelemetryBatchPayload,
} from "./messages.js";

interface TextEncoderLike {
  encode(input: string): Uint8Array;
}

interface TextDecoderLike {
  decode(input: Uint8Array): string;
}

type TextEncoderCtor = new () => TextEncoderLike;
type TextDecoderCtor = new (label?: string, options?: { fatal?: boolean }) => TextDecoderLike;

function isConstructor<T>(value: unknown): value is T {
  return typeof value === "function";
}

function getTextEncoder(): TextEncoderLike {
  const ctor: unknown = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder")?.value;
  if (!isConstructor<TextEncoderCtor>(ctor)) {
    throw new ProtocolError("INVALID_CONTROL_JSON", "TextEncoder is unavailable");
  }
  return new ctor();
}

function getTextDecoder(): TextDecoderLike {
  const ctor: unknown = Object.getOwnPropertyDescriptor(globalThis, "TextDecoder")?.value;
  if (!isConstructor<TextDecoderCtor>(ctor)) {
    throw new ProtocolError("INVALID_CONTROL_JSON", "TextDecoder is unavailable");
  }
  return new ctor("utf-8", { fatal: true });
}

const textEncoder = getTextEncoder();
const textDecoder = getTextDecoder();

const SPECIAL_KEY_SET = new Set<string>(SPECIAL_KEYS);
const SESSION_ROLE_SET = new Set<string>(SESSION_ROLES);
const POWER_STATE_SET = new Set<string>(POWER_STATES);
const PRIMARY_MODE_SET = new Set<string>(["INTERACTIVE", "LIVE", "CATCHUP", "BUFFER_HOLD"]);
const TELEMETRY_CATEGORY_SET = new Set<string>(TELEMETRY_CATEGORIES);
const TERMINAL_CLOSE_CODE_SET = new Set<number>(TERMINAL_WS_CLOSE_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isSpecialKey(value: unknown): value is SpecialKey {
  return isString(value) && SPECIAL_KEY_SET.has(value);
}

function isSessionRole(value: unknown): value is SessionRole {
  return isString(value) && SESSION_ROLE_SET.has(value);
}

function isPowerState(value: unknown): value is PowerState {
  return isString(value) && POWER_STATE_SET.has(value);
}

function isPrimaryPlaybackModeOrNull(value: unknown): value is PrimaryPlaybackMode | null {
  return value === null || (isString(value) && PRIMARY_MODE_SET.has(value));
}

function isTelemetryCategory(value: unknown): value is TelemetryCategory {
  return isString(value) && TELEMETRY_CATEGORY_SET.has(value);
}

function encodeChannelText(channel: ChannelId, text: string): Uint8Array {
  const payload = textEncoder.encode(text);
  const frame = new Uint8Array(1 + payload.byteLength);
  frame[0] = channel;
  frame.set(payload, 1);
  return frame;
}

function decodeChannelPayload(buffer: Uint8Array, expectedChannel: ChannelId): Uint8Array {
  if (buffer.byteLength === 0) {
    throw new ProtocolError("FRAME_TOO_SHORT", "Empty frame");
  }
  const channel = buffer[0];
  if (channel !== expectedChannel) {
    throw new ProtocolError(
      "UNKNOWN_CHANNEL",
      `Expected channel 0x${expectedChannel.toString(16)}, got 0x${(channel ?? 0).toString(16)}`,
    );
  }
  if (buffer.byteLength < 2) {
    throw new ProtocolError("FRAME_TOO_SHORT", "Frame payload missing");
  }
  return buffer.subarray(1);
}

function decodeUtf8Json(payload: Uint8Array): unknown {
  let text: string;
  try {
    text = textDecoder.decode(payload);
  } catch {
    throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid UTF-8 in JSON control frame");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolError("INVALID_CONTROL_JSON", "Malformed JSON in control frame");
  }
}

function assertValidStreamingState(value: unknown): asserts value is StreamingState {
  if (!isRecord(value) || !isString(value.kind) || !isFiniteNumber(value.streamEpoch)) {
    throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid STREAM_STATE payload");
  }
  switch (value.kind) {
    case "STANDBY":
      if (
        value.reason !== "UNAUTHENTICATED" &&
        value.reason !== "REAR_STANDBY" &&
        value.reason !== "SLEEP_PAUSED"
      ) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid STANDBY reason");
      }
      return;
    case "INTERACTIVE":
      if (!isFiniteNumber(value.lastInteractionAtMs)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid INTERACTIVE lastInteractionAtMs");
      }
      return;
    case "LIVE":
      return;
    case "CATCHUP":
      if (!isFiniteNumber(value.targetBufferMs) || !isFiniteNumber(value.resumePtsUs)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid CATCHUP state fields");
      }
      return;
    case "BUFFER_HOLD":
      if (!isFiniteNumber(value.holdSinceMs)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid BUFFER_HOLD state fields");
      }
      return;
    default:
      throw new ProtocolError(
        "INVALID_CONTROL_JSON",
        `Unknown streaming state kind: ${value.kind}`,
      );
  }
}

function assertValidClientControlMessage(value: unknown): asserts value is ClientControlMessage {
  if (!isRecord(value) || !isString(value.type)) {
    throw new ProtocolError("INVALID_CONTROL_JSON", "Client control message must be an object");
  }
  switch (value.type) {
    case "PING":
      if (!isFiniteNumber(value.clientTimestampMs)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid PING clientTimestampMs");
      }
      return;
    case "PLAYBACK_FEEDBACK":
      if (
        !isFiniteNumber(value.streamEpoch) ||
        !isFiniteNumber(value.renderedPtsUs) ||
        !isFiniteNumber(value.videoBufferedMs) ||
        !isFiniteNumber(value.audioBufferedMs)
      ) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid PLAYBACK_FEEDBACK fields");
      }
      return;
    case "SET_ZOOM":
      if (!isFiniteNumber(value.scale)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid SET_ZOOM scale");
      }
      return;
    case "NAVIGATE":
      if (!isString(value.url)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid NAVIGATE url");
      }
      return;
    case "INPUT_TEXT":
      if (!isString(value.text)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid INPUT_TEXT text");
      }
      return;
    case "INPUT_KEY":
      if (!isSpecialKey(value.key)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid INPUT_KEY key");
      }
      return;
    case "HISTORY_BACK":
    case "HISTORY_FORWARD":
    case "RELOAD":
    case "TOGGLE_FULLSCREEN":
    case "PAUSE_BROWSER":
    case "RESUME_BROWSER":
    case "RESTART_BROWSER":
    case "DISCONNECT":
      return;
    default:
      throw new ProtocolError("INVALID_CONTROL_JSON", `Unknown client control type: ${value.type}`);
  }
}

function assertValidServerControlMessage(value: unknown): asserts value is ServerControlMessage {
  if (!isRecord(value) || !isString(value.type)) {
    throw new ProtocolError("INVALID_CONTROL_JSON", "Server control message must be an object");
  }
  switch (value.type) {
    case "AUTH_REQUIRED":
      if (!isBoolean(value.isSetupCompleted)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid AUTH_REQUIRED fields");
      }
      return;
    case "AUTH_OK":
      if (
        !isSessionRole(value.role) ||
        !isString(value.token) ||
        !isFiniteNumber(value.streamEpoch) ||
        !isRecord(value.settings) ||
        !isPowerState(value.powerState)
      ) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid AUTH_OK fields");
      }
      return;
    case "AUTH_FAILED":
      if (!isString(value.reason) || !isFiniteNumber(value.remainingAttempts)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid AUTH_FAILED fields");
      }
      return;
    case "SESSION_CONFLICT":
      if (!isString(value.reason)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid SESSION_CONFLICT fields");
      }
      return;
    case "SESSION_ROLE_CHANGED":
      if (!isSessionRole(value.role) || !isFiniteNumber(value.streamEpoch)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid SESSION_ROLE_CHANGED fields");
      }
      return;
    case "PRIMARY_SESSION_STATUS":
      if (!isBoolean(value.active) || !isFiniteNumber(value.streamEpoch)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid PRIMARY_SESSION_STATUS fields");
      }
      return;
    case "PONG":
      if (
        !isFiniteNumber(value.clientTimestampMs) ||
        !isFiniteNumber(value.serverTimestampMs) ||
        !isFiniteNumber(value.latestMediaPtsUs) ||
        !isPrimaryPlaybackModeOrNull(value.mode) ||
        !isFiniteNumber(value.serverRemainingBufferMs) ||
        !(value.primaryRenderedPts === null || isFiniteNumber(value.primaryRenderedPts)) ||
        !(value.primaryFeedbackAgeMs === null || isFiniteNumber(value.primaryFeedbackAgeMs)) ||
        !isFiniteNumber(value.primaryTargetBufferMs) ||
        !isPrimaryPlaybackModeOrNull(value.primaryMode)
      ) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid PONG fields");
      }
      return;
    case "STREAM_STATE":
      assertValidStreamingState(value.state);
      return;
    case "BUFFER_HOLD":
      if (!isBoolean(value.active) || !isFiniteNumber(value.streamEpoch)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid BUFFER_HOLD fields");
      }
      return;
    case "BROWSER_STATUS":
      if (!isPowerState(value.powerState) || !isFiniteNumber(value.streamEpoch)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid BROWSER_STATUS fields");
      }
      return;
    case "PAGE_INFO":
      if (!isString(value.url) || !isString(value.title)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid PAGE_INFO fields");
      }
      return;
    case "SERVER_STATS":
      if (
        !isRecord(value.stats) ||
        !isFiniteNumber(value.stats.timestamp) ||
        !isFiniteNumber(value.stats.encodeFps) ||
        !isFiniteNumber(value.stats.sendBitrateKbps) ||
        !isFiniteNumber(value.stats.audioPps) ||
        !isPowerState(value.stats.powerState)
      ) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid SERVER_STATS fields");
      }
      return;
    case "SETTINGS_UPDATED":
      if (!isRecord(value.settings)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid SETTINGS_UPDATED fields");
      }
      return;
    case "ERROR":
      if (!isString(value.code) || !isString(value.message)) {
        throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid ERROR fields");
      }
      return;
    default:
      throw new ProtocolError("INVALID_CONTROL_JSON", `Unknown server control type: ${value.type}`);
  }
}

const METRICS_NUMERIC_FIELDS: readonly (keyof ClientMetricsSample)[] = [
  "timestamp",
  "windowMs",
  "fps",
  "minFps",
  "maxFps",
  "droppedFrames",
  "decoderErrors",
  "totalRenderedFrames",
  "videoPackets",
  "videoBytes",
  "audioPackets",
  "bitrateKbps",
  "frameTimeP50Ms",
  "frameTimeP95Ms",
  "decodeQueueSize",
  "rttMs",
  "avDriftMs",
  "displayWidth",
  "displayHeight",
  "dpr",
];

function assertValidMetricsSample(value: unknown): asserts value is ClientMetricsSample {
  if (!isRecord(value)) {
    throw new ProtocolError("INVALID_CONTROL_JSON", "Metrics payload must be an object");
  }
  for (const field of METRICS_NUMERIC_FIELDS) {
    if (!isFiniteNumber(value[field])) {
      throw new ProtocolError("INVALID_CONTROL_JSON", `Invalid metrics field: ${field}`);
    }
  }
}

function assertValidTelemetryEvent(value: unknown): asserts value is TelemetryEventInput {
  if (!isRecord(value)) {
    throw new ProtocolError("INVALID_CONTROL_JSON", "Telemetry event must be an object");
  }
  if (!isTelemetryCategory(value.category) || !isString(value.event)) {
    throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid telemetry event category or name");
  }
  if (value.timestamp !== undefined && !isFiniteNumber(value.timestamp)) {
    throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid telemetry event timestamp");
  }
  if (value.data !== undefined && !isRecord(value.data)) {
    throw new ProtocolError("INVALID_CONTROL_JSON", "Invalid telemetry event data");
  }
}

function assertValidTelemetryBatch(value: unknown): asserts value is TelemetryBatchPayload {
  if (!isRecord(value) || !Array.isArray(value.events)) {
    throw new ProtocolError("INVALID_CONTROL_JSON", "Telemetry batch must contain events array");
  }
  for (const entry of value.events) {
    assertValidTelemetryEvent(entry);
  }
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function encodeAuthFrame(payload: AuthPayload): Uint8Array {
  let raw: string;
  switch (payload.kind) {
    case "PRIMARY_PIN":
      if (
        payload.pin.length === 0 ||
        payload.pin.startsWith(AUTH_PREFIX.TOKEN) ||
        payload.pin.startsWith(AUTH_PREFIX.SECONDARY)
      ) {
        throw new ProtocolError("INVALID_BINARY_FRAME", "Invalid PRIMARY_PIN auth payload");
      }
      raw = payload.pin;
      break;
    case "SECONDARY_PIN":
      if (payload.pin.length === 0) {
        throw new ProtocolError("INVALID_BINARY_FRAME", "Empty SECONDARY_PIN auth payload");
      }
      raw = `${AUTH_PREFIX.SECONDARY}${payload.pin}`;
      break;
    case "TOKEN":
      if (payload.token.length === 0) {
        throw new ProtocolError("INVALID_BINARY_FRAME", "Empty TOKEN auth payload");
      }
      raw = `${AUTH_PREFIX.TOKEN}${payload.token}`;
      break;
  }
  return encodeChannelText(CHANNEL_ID.AUTH, raw);
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function decodeAuthFrame(buffer: Uint8Array): AuthPayload {
  const payload = decodeChannelPayload(buffer, CHANNEL_ID.AUTH);
  let text: string;
  try {
    text = textDecoder.decode(payload);
  } catch {
    throw new ProtocolError("INVALID_BINARY_FRAME", "Invalid UTF-8 in auth frame");
  }
  if (text.length === 0) {
    throw new ProtocolError("FRAME_TOO_SHORT", "Empty auth payload");
  }
  if (text.startsWith(AUTH_PREFIX.TOKEN)) {
    const token = text.slice(AUTH_PREFIX.TOKEN.length);
    if (token.length === 0) {
      throw new ProtocolError("INVALID_BINARY_FRAME", "Empty token in auth frame");
    }
    return { kind: "TOKEN", token };
  }
  if (text.startsWith(AUTH_PREFIX.SECONDARY)) {
    const pin = text.slice(AUTH_PREFIX.SECONDARY.length);
    if (pin.length === 0) {
      throw new ProtocolError("INVALID_BINARY_FRAME", "Empty secondary PIN in auth frame");
    }
    return { kind: "SECONDARY_PIN", pin };
  }
  return { kind: "PRIMARY_PIN", pin: text };
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function encodeClientControlFrame(message: ClientControlMessage): Uint8Array {
  assertValidClientControlMessage(message);
  return encodeChannelText(CHANNEL_ID.CONTROL_COMMAND, JSON.stringify(message));
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function decodeClientControlFrame(buffer: Uint8Array): ClientControlMessage {
  const payload = decodeChannelPayload(buffer, CHANNEL_ID.CONTROL_COMMAND);
  const parsed = decodeUtf8Json(payload);
  assertValidClientControlMessage(parsed);
  return parsed;
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function encodeServerControlFrame(message: ServerControlMessage): Uint8Array {
  assertValidServerControlMessage(message);
  return encodeChannelText(CHANNEL_ID.CONTROL_RESPONSE, JSON.stringify(message));
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function decodeServerControlFrame(buffer: Uint8Array): ServerControlMessage {
  const payload = decodeChannelPayload(buffer, CHANNEL_ID.CONTROL_RESPONSE);
  const parsed = decodeUtf8Json(payload);
  assertValidServerControlMessage(parsed);
  return parsed;
}

// Spec: docs/specs/08-observability.md#2.1
export function encodeMetricsFrame(sample: ClientMetricsSample): Uint8Array {
  assertValidMetricsSample(sample);
  return encodeChannelText(CHANNEL_ID.METRICS, JSON.stringify(sample));
}

// Spec: docs/specs/08-observability.md#2.1
export function decodeMetricsFrame(buffer: Uint8Array): ClientMetricsSample {
  const payload = decodeChannelPayload(buffer, CHANNEL_ID.METRICS);
  const parsed = decodeUtf8Json(payload);
  assertValidMetricsSample(parsed);
  return parsed;
}

// Spec: docs/specs/08-observability.md#2.2
export function encodeTelemetryFrame(batch: TelemetryBatchPayload): Uint8Array {
  assertValidTelemetryBatch(batch);
  const frame = encodeChannelText(CHANNEL_ID.TELEMETRY, JSON.stringify(batch));
  if (frame.byteLength > FRAME_SIZE.MAX_TELEMETRY_BYTES) {
    throw new ProtocolError(
      "PAYLOAD_TOO_LARGE",
      `Telemetry frame size ${frame.byteLength} exceeds ${FRAME_SIZE.MAX_TELEMETRY_BYTES} bytes`,
    );
  }
  return frame;
}

// Spec: docs/specs/08-observability.md#2.2
export function decodeTelemetryFrame(buffer: Uint8Array): TelemetryBatchPayload {
  const payload = decodeChannelPayload(buffer, CHANNEL_ID.TELEMETRY);
  if (buffer.byteLength > FRAME_SIZE.MAX_TELEMETRY_BYTES) {
    throw new ProtocolError(
      "PAYLOAD_TOO_LARGE",
      `Telemetry frame size ${buffer.byteLength} exceeds ${FRAME_SIZE.MAX_TELEMETRY_BYTES} bytes`,
    );
  }
  const parsed = decodeUtf8Json(payload);
  assertValidTelemetryBatch(parsed);
  return parsed;
}

// Spec: docs/specs/02-session-multidisplay.md#3
export function isTerminalCloseCode(code: number): boolean {
  return TERMINAL_CLOSE_CODE_SET.has(code);
}

// Spec: docs/specs/02-session-multidisplay.md#3
export function calculateReconnectDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) {
    return RECONNECT_BACKOFF.baseDelayMs;
  }
  const exponent = Math.min(Math.floor(attempt), 30);
  return Math.min(RECONNECT_BACKOFF.baseDelayMs * 2 ** exponent, RECONNECT_BACKOFF.maxDelayMs);
}
