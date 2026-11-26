import type { PublicAppSettings } from "../settings/index.js";
import type { StreamingState } from "../state/index.js";
import type {
  PowerState,
  PrimaryPlaybackMode,
  ServerMetricsSnapshot,
  SessionRole,
  TelemetryEventInput,
} from "../types/index.js";
import type { SpecialKey } from "./constants.js";

export type AuthPayload =
  | { readonly kind: "PRIMARY_PIN"; readonly pin: string }
  | { readonly kind: "SECONDARY_PIN"; readonly pin: string }
  | { readonly kind: "TOKEN"; readonly token: string };

export type ClientControlMessage =
  | { readonly type: "PING"; readonly clientTimestampMs: number }
  | {
      readonly type: "PLAYBACK_FEEDBACK";
      readonly streamEpoch: number;
      readonly renderedPtsUs: number;
      readonly videoBufferedMs: number;
      readonly audioBufferedMs: number;
    }
  | { readonly type: "SET_ZOOM"; readonly scale: number }
  | { readonly type: "NAVIGATE"; readonly url: string }
  | { readonly type: "HISTORY_BACK" }
  | { readonly type: "HISTORY_FORWARD" }
  | { readonly type: "RELOAD" }
  | { readonly type: "TOGGLE_FULLSCREEN" }
  | { readonly type: "INPUT_TEXT"; readonly text: string }
  | { readonly type: "INPUT_KEY"; readonly key: SpecialKey }
  | { readonly type: "PAUSE_BROWSER" }
  | { readonly type: "RESUME_BROWSER" }
  | { readonly type: "RESTART_BROWSER" }
  | { readonly type: "DISCONNECT" };

export type ServerControlMessage =
  | { readonly type: "AUTH_REQUIRED"; readonly isSetupCompleted: boolean }
  | {
      readonly type: "AUTH_OK";
      readonly role: SessionRole;
      readonly token: string;
      readonly streamEpoch: number;
      readonly settings: PublicAppSettings;
      readonly powerState: PowerState;
    }
  | {
      readonly type: "AUTH_FAILED";
      readonly reason: string;
      readonly remainingAttempts: number;
    }
  | { readonly type: "SESSION_CONFLICT"; readonly reason: string }
  | {
      readonly type: "SESSION_ROLE_CHANGED";
      readonly role: SessionRole;
      readonly streamEpoch: number;
    }
  | {
      readonly type: "PRIMARY_SESSION_STATUS";
      readonly active: boolean;
      readonly streamEpoch: number;
    }
  | {
      readonly type: "PONG";
      readonly clientTimestampMs: number;
      readonly serverTimestampMs: number;
      readonly latestMediaPtsUs: number;
      readonly mode: PrimaryPlaybackMode | null;
      readonly serverRemainingBufferMs: number;
      readonly primaryRenderedPts: number | null;
      readonly primaryFeedbackAgeMs: number | null;
      readonly primaryTargetBufferMs: number;
      readonly primaryMode: PrimaryPlaybackMode | null;
    }
  | { readonly type: "STREAM_STATE"; readonly state: StreamingState }
  | {
      readonly type: "BUFFER_HOLD";
      readonly active: boolean;
      readonly streamEpoch: number;
    }
  | {
      readonly type: "BROWSER_STATUS";
      readonly powerState: PowerState;
      readonly streamEpoch: number;
    }
  | { readonly type: "PAGE_INFO"; readonly url: string; readonly title: string }
  | { readonly type: "SERVER_STATS"; readonly stats: ServerMetricsSnapshot }
  | { readonly type: "SETTINGS_UPDATED"; readonly settings: PublicAppSettings }
  | { readonly type: "ERROR"; readonly code: string; readonly message: string };

export interface TelemetryBatchPayload {
  readonly events: readonly TelemetryEventInput[];
}
