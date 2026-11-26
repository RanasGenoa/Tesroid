import type { ClientMetricsSample } from "../types/index.js";
import type {
  AuthPayload,
  ClientControlMessage,
  ServerControlMessage,
  TelemetryBatchPayload,
} from "./messages.js";

// Spec: docs/specs/03-streaming-transport.md#2.1
export function encodeAuthFrame(payload: AuthPayload): Uint8Array {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function decodeAuthFrame(buffer: Uint8Array): AuthPayload {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function encodeClientControlFrame(message: ClientControlMessage): Uint8Array {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function decodeClientControlFrame(buffer: Uint8Array): ClientControlMessage {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function encodeServerControlFrame(message: ServerControlMessage): Uint8Array {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function decodeServerControlFrame(buffer: Uint8Array): ServerControlMessage {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/08-observability.md#2.1
export function encodeMetricsFrame(sample: ClientMetricsSample): Uint8Array {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/08-observability.md#2.1
export function decodeMetricsFrame(buffer: Uint8Array): ClientMetricsSample {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/08-observability.md#2.2
export function encodeTelemetryFrame(batch: TelemetryBatchPayload): Uint8Array {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/08-observability.md#2.2
export function decodeTelemetryFrame(buffer: Uint8Array): TelemetryBatchPayload {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/02-session-multidisplay.md#3
export function isTerminalCloseCode(code: number): boolean {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/02-session-multidisplay.md#3
export function calculateReconnectDelayMs(attempt: number): number {
  throw new Error("NOT_IMPLEMENTED");
}
