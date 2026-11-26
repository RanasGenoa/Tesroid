export const INTERACTION_TIMEOUT_MS = 4_000 as const;

export type StandbyReason = "UNAUTHENTICATED" | "REAR_STANDBY" | "SLEEP_PAUSED";

export type StreamingState =
  | {
      readonly kind: "STANDBY";
      readonly streamEpoch: number;
      readonly reason: StandbyReason;
    }
  | {
      readonly kind: "INTERACTIVE";
      readonly streamEpoch: number;
      readonly lastInteractionAtMs: number;
    }
  | {
      readonly kind: "LIVE";
      readonly streamEpoch: number;
    }
  | {
      readonly kind: "CATCHUP";
      readonly streamEpoch: number;
      readonly targetBufferMs: number;
      readonly resumePtsUs: number;
    }
  | {
      readonly kind: "BUFFER_HOLD";
      readonly streamEpoch: number;
      readonly holdSinceMs: number;
      readonly targetBufferMs: number;
    };

export type StreamingStateKind = StreamingState["kind"];

export type StreamingEvent =
  | {
      readonly type: "SESSION_ACTIVATED";
      readonly streamEpoch: number;
      readonly resumeCatchup?: {
        readonly targetBufferMs: number;
        readonly resumePtsUs: number;
      };
    }
  | {
      readonly type: "ENTER_STANDBY";
      readonly reason: StandbyReason;
    }
  | {
      readonly type: "USER_INTERACTION";
      readonly atMs: number;
      readonly newStreamEpoch: number;
    }
  | {
      readonly type: "INTERACTION_TIMEOUT";
    }
  | {
      readonly type: "CATCHUP_DRAINED";
    }
  | {
      readonly type: "SOCKET_CONGESTED";
    }
  | {
      readonly type: "HOLD_THRESHOLD_REACHED";
      readonly atMs: number;
      readonly targetBufferMs: number;
    }
  | {
      readonly type: "HOLD_DRAINED";
      readonly newStreamEpoch: number;
    }
  | {
      readonly type: "STREAM_RESET";
      readonly newStreamEpoch: number;
    }
  | {
      readonly type: "POWER_SLEEP";
    };

export type StreamingEffect =
  | { readonly type: "FLUSH_CATCHUP_QUEUE" }
  | { readonly type: "ADVANCE_EPOCH_AND_RESET"; readonly streamEpoch: number }
  | { readonly type: "ARM_INTERACTION_TIMER"; readonly delayMs: typeof INTERACTION_TIMEOUT_MS }
  | { readonly type: "CANCEL_INTERACTION_TIMER" }
  | { readonly type: "REQUEST_POWER_HOLD" }
  | { readonly type: "REQUEST_POWER_RESUME" }
  | { readonly type: "ENTER_LIVE_HYSTERESIS" }
  | { readonly type: "BROADCAST_STATE" };

export interface StreamingTransition {
  readonly nextState: StreamingState;
  readonly effects: readonly StreamingEffect[];
}

export type QueueKind = "NONE" | "LIVE" | "CATCHUP";

export type HudModeBadge = "STANDBY" | "HOLD" | "DIRECT_LIVE" | "WAIT" | "BUF" | "LIVE";

export interface HudProjectionInput {
  readonly localBufferedMs: number;
  readonly serverBufferedMs: number;
  readonly isWaitingForKeyframe: boolean;
}

// Spec: docs/architecture.md#3.5
export function assertNever(_value: never): never {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/architecture.md#3.5
export function createInitialStreamingState(
  streamEpoch?: number,
  reason?: StandbyReason,
): StreamingState {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.2
export function transitionStreamingState(
  state: StreamingState,
  event: StreamingEvent,
): StreamingTransition {
  switch (state.kind) {
    case "STANDBY":
    case "INTERACTIVE":
    case "LIVE":
    case "CATCHUP":
    case "BUFFER_HOLD": {
      switch (event.type) {
        case "SESSION_ACTIVATED":
        case "ENTER_STANDBY":
        case "USER_INTERACTION":
        case "INTERACTION_TIMEOUT":
        case "CATCHUP_DRAINED":
        case "SOCKET_CONGESTED":
        case "HOLD_THRESHOLD_REACHED":
        case "HOLD_DRAINED":
        case "STREAM_RESET":
        case "POWER_SLEEP":
          throw new Error("NOT_IMPLEMENTED");
        default:
          return assertNever(event);
      }
    }
    default:
      return assertNever(state);
  }
}

// Spec: docs/specs/04-client-playback-avsync.md#2.3
export function selectQueueKind(state: StreamingState): QueueKind {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.2
export function isInputAllowed(state: StreamingState): boolean {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.2
export function shouldSuppressMediaSend(state: StreamingState): boolean {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/07-ui-hud-settings.md#2.1
export function selectHudModeBadge(state: StreamingState, input: HudProjectionInput): HudModeBadge {
  throw new Error("NOT_IMPLEMENTED");
}
