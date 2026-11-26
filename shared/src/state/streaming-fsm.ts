import { STREAM_EPOCH_INITIAL } from "../protocol/constants.js";

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

const HUD_LOCAL_BUF_THRESHOLD_MS = 800;
const HUD_SERVER_BUF_THRESHOLD_MS = 600;

function activateSessionState(
  streamEpoch: number,
  resumeCatchup?: { readonly targetBufferMs: number; readonly resumePtsUs: number },
): StreamingState {
  if (resumeCatchup !== undefined) {
    return {
      kind: "CATCHUP",
      streamEpoch,
      targetBufferMs: resumeCatchup.targetBufferMs,
      resumePtsUs: resumeCatchup.resumePtsUs,
    };
  }
  return { kind: "LIVE", streamEpoch };
}

function transitionFromStandby(
  state: Extract<StreamingState, { readonly kind: "STANDBY" }>,
  event: StreamingEvent,
): StreamingTransition {
  switch (event.type) {
    case "SESSION_ACTIVATED":
      return {
        nextState: activateSessionState(event.streamEpoch, event.resumeCatchup),
        effects: [{ type: "BROADCAST_STATE" }],
      };
    case "ENTER_STANDBY":
      if (state.reason === event.reason) {
        return { nextState: state, effects: [] };
      }
      return {
        nextState: { kind: "STANDBY", streamEpoch: state.streamEpoch, reason: event.reason },
        effects: [{ type: "BROADCAST_STATE" }],
      };
    case "POWER_SLEEP":
      if (state.reason === "SLEEP_PAUSED") {
        return { nextState: state, effects: [] };
      }
      return {
        nextState: { kind: "STANDBY", streamEpoch: state.streamEpoch, reason: "SLEEP_PAUSED" },
        effects: [{ type: "BROADCAST_STATE" }],
      };
    case "USER_INTERACTION":
    case "INTERACTION_TIMEOUT":
    case "CATCHUP_DRAINED":
    case "SOCKET_CONGESTED":
    case "HOLD_THRESHOLD_REACHED":
    case "HOLD_DRAINED":
    case "STREAM_RESET":
      return { nextState: state, effects: [] };
    default:
      return assertNever(event);
  }
}

function transitionFromInteractive(
  state: Extract<StreamingState, { readonly kind: "INTERACTIVE" }>,
  event: StreamingEvent,
): StreamingTransition {
  switch (event.type) {
    case "SESSION_ACTIVATED":
      return {
        nextState: activateSessionState(event.streamEpoch, event.resumeCatchup),
        effects: [{ type: "CANCEL_INTERACTION_TIMER" }, { type: "BROADCAST_STATE" }],
      };
    case "ENTER_STANDBY":
      return {
        nextState: { kind: "STANDBY", streamEpoch: state.streamEpoch, reason: event.reason },
        effects: [{ type: "CANCEL_INTERACTION_TIMER" }, { type: "BROADCAST_STATE" }],
      };
    case "POWER_SLEEP":
      return {
        nextState: { kind: "STANDBY", streamEpoch: state.streamEpoch, reason: "SLEEP_PAUSED" },
        effects: [{ type: "CANCEL_INTERACTION_TIMER" }, { type: "BROADCAST_STATE" }],
      };
    case "USER_INTERACTION":
      return {
        nextState: {
          kind: "INTERACTIVE",
          streamEpoch: state.streamEpoch,
          lastInteractionAtMs: event.atMs,
        },
        effects: [{ type: "ARM_INTERACTION_TIMER", delayMs: INTERACTION_TIMEOUT_MS }],
      };
    case "INTERACTION_TIMEOUT":
      return {
        nextState: { kind: "LIVE", streamEpoch: state.streamEpoch },
        effects: [{ type: "BROADCAST_STATE" }],
      };
    case "SOCKET_CONGESTED":
      return {
        nextState: state,
        effects: [{ type: "ENTER_LIVE_HYSTERESIS" }],
      };
    case "STREAM_RESET":
      return {
        nextState: { kind: "LIVE", streamEpoch: event.newStreamEpoch },
        effects: [
          { type: "FLUSH_CATCHUP_QUEUE" },
          { type: "ADVANCE_EPOCH_AND_RESET", streamEpoch: event.newStreamEpoch },
          { type: "CANCEL_INTERACTION_TIMER" },
          { type: "BROADCAST_STATE" },
        ],
      };
    case "CATCHUP_DRAINED":
    case "HOLD_THRESHOLD_REACHED":
    case "HOLD_DRAINED":
      return { nextState: state, effects: [] };
    default:
      return assertNever(event);
  }
}

function transitionFromLive(
  state: Extract<StreamingState, { readonly kind: "LIVE" }>,
  event: StreamingEvent,
): StreamingTransition {
  switch (event.type) {
    case "SESSION_ACTIVATED": {
      const nextState = activateSessionState(event.streamEpoch, event.resumeCatchup);
      const changed = nextState.kind !== state.kind || nextState.streamEpoch !== state.streamEpoch;
      return {
        nextState,
        effects: changed ? [{ type: "BROADCAST_STATE" }] : [],
      };
    }
    case "ENTER_STANDBY":
      return {
        nextState: { kind: "STANDBY", streamEpoch: state.streamEpoch, reason: event.reason },
        effects: [{ type: "BROADCAST_STATE" }],
      };
    case "POWER_SLEEP":
      return {
        nextState: { kind: "STANDBY", streamEpoch: state.streamEpoch, reason: "SLEEP_PAUSED" },
        effects: [{ type: "BROADCAST_STATE" }],
      };
    case "USER_INTERACTION":
      return {
        nextState: {
          kind: "INTERACTIVE",
          streamEpoch: state.streamEpoch,
          lastInteractionAtMs: event.atMs,
        },
        effects: [
          { type: "ARM_INTERACTION_TIMER", delayMs: INTERACTION_TIMEOUT_MS },
          { type: "BROADCAST_STATE" },
        ],
      };
    case "SOCKET_CONGESTED":
      return {
        nextState: state,
        effects: [{ type: "ENTER_LIVE_HYSTERESIS" }],
      };
    case "HOLD_THRESHOLD_REACHED":
      return {
        nextState: {
          kind: "BUFFER_HOLD",
          streamEpoch: state.streamEpoch,
          holdSinceMs: event.atMs,
          targetBufferMs: event.targetBufferMs,
        },
        effects: [
          { type: "CANCEL_INTERACTION_TIMER" },
          { type: "REQUEST_POWER_HOLD" },
          { type: "BROADCAST_STATE" },
        ],
      };
    case "STREAM_RESET":
      return {
        nextState: { kind: "LIVE", streamEpoch: event.newStreamEpoch },
        effects: [
          { type: "FLUSH_CATCHUP_QUEUE" },
          { type: "ADVANCE_EPOCH_AND_RESET", streamEpoch: event.newStreamEpoch },
          { type: "CANCEL_INTERACTION_TIMER" },
          { type: "BROADCAST_STATE" },
        ],
      };
    case "INTERACTION_TIMEOUT":
    case "CATCHUP_DRAINED":
    case "HOLD_DRAINED":
      return { nextState: state, effects: [] };
    default:
      return assertNever(event);
  }
}

function transitionFromCatchup(
  state: Extract<StreamingState, { readonly kind: "CATCHUP" }>,
  event: StreamingEvent,
): StreamingTransition {
  switch (event.type) {
    case "SESSION_ACTIVATED":
      if (event.resumeCatchup !== undefined) {
        return {
          nextState: activateSessionState(event.streamEpoch, event.resumeCatchup),
          effects: [{ type: "BROADCAST_STATE" }],
        };
      }
      return {
        nextState: { kind: "LIVE", streamEpoch: event.streamEpoch },
        effects: [{ type: "FLUSH_CATCHUP_QUEUE" }, { type: "BROADCAST_STATE" }],
      };
    case "ENTER_STANDBY":
      return {
        nextState: { kind: "STANDBY", streamEpoch: state.streamEpoch, reason: event.reason },
        effects: [{ type: "FLUSH_CATCHUP_QUEUE" }, { type: "BROADCAST_STATE" }],
      };
    case "POWER_SLEEP":
      return {
        nextState: { kind: "STANDBY", streamEpoch: state.streamEpoch, reason: "SLEEP_PAUSED" },
        effects: [{ type: "FLUSH_CATCHUP_QUEUE" }, { type: "BROADCAST_STATE" }],
      };
    case "USER_INTERACTION":
      return {
        nextState: {
          kind: "INTERACTIVE",
          streamEpoch: event.newStreamEpoch,
          lastInteractionAtMs: event.atMs,
        },
        effects: [
          { type: "FLUSH_CATCHUP_QUEUE" },
          { type: "ADVANCE_EPOCH_AND_RESET", streamEpoch: event.newStreamEpoch },
          { type: "ARM_INTERACTION_TIMER", delayMs: INTERACTION_TIMEOUT_MS },
          { type: "BROADCAST_STATE" },
        ],
      };
    case "CATCHUP_DRAINED":
      return {
        nextState: { kind: "LIVE", streamEpoch: state.streamEpoch },
        effects: [{ type: "BROADCAST_STATE" }],
      };
    case "HOLD_THRESHOLD_REACHED":
      return {
        nextState: {
          kind: "BUFFER_HOLD",
          streamEpoch: state.streamEpoch,
          holdSinceMs: event.atMs,
          targetBufferMs: event.targetBufferMs,
        },
        effects: [
          { type: "CANCEL_INTERACTION_TIMER" },
          { type: "REQUEST_POWER_HOLD" },
          { type: "BROADCAST_STATE" },
        ],
      };
    case "STREAM_RESET":
      return {
        nextState: { kind: "LIVE", streamEpoch: event.newStreamEpoch },
        effects: [
          { type: "FLUSH_CATCHUP_QUEUE" },
          { type: "ADVANCE_EPOCH_AND_RESET", streamEpoch: event.newStreamEpoch },
          { type: "CANCEL_INTERACTION_TIMER" },
          { type: "BROADCAST_STATE" },
        ],
      };
    case "INTERACTION_TIMEOUT":
    case "SOCKET_CONGESTED":
    case "HOLD_DRAINED":
      return { nextState: state, effects: [] };
    default:
      return assertNever(event);
  }
}

function transitionFromBufferHold(
  state: Extract<StreamingState, { readonly kind: "BUFFER_HOLD" }>,
  event: StreamingEvent,
): StreamingTransition {
  switch (event.type) {
    case "SESSION_ACTIVATED":
      if (event.resumeCatchup !== undefined) {
        return {
          nextState: activateSessionState(event.streamEpoch, event.resumeCatchup),
          effects: [{ type: "REQUEST_POWER_RESUME" }, { type: "BROADCAST_STATE" }],
        };
      }
      return {
        nextState: { kind: "LIVE", streamEpoch: event.streamEpoch },
        effects: [
          { type: "FLUSH_CATCHUP_QUEUE" },
          { type: "REQUEST_POWER_RESUME" },
          { type: "ADVANCE_EPOCH_AND_RESET", streamEpoch: event.streamEpoch },
          { type: "BROADCAST_STATE" },
        ],
      };
    case "ENTER_STANDBY":
      return {
        nextState: { kind: "STANDBY", streamEpoch: state.streamEpoch, reason: event.reason },
        effects: [{ type: "FLUSH_CATCHUP_QUEUE" }, { type: "BROADCAST_STATE" }],
      };
    case "POWER_SLEEP":
      return {
        nextState: { kind: "STANDBY", streamEpoch: state.streamEpoch, reason: "SLEEP_PAUSED" },
        effects: [{ type: "FLUSH_CATCHUP_QUEUE" }, { type: "BROADCAST_STATE" }],
      };
    case "USER_INTERACTION":
      return {
        nextState: {
          kind: "INTERACTIVE",
          streamEpoch: event.newStreamEpoch,
          lastInteractionAtMs: event.atMs,
        },
        effects: [
          { type: "FLUSH_CATCHUP_QUEUE" },
          { type: "REQUEST_POWER_RESUME" },
          { type: "ADVANCE_EPOCH_AND_RESET", streamEpoch: event.newStreamEpoch },
          { type: "ARM_INTERACTION_TIMER", delayMs: INTERACTION_TIMEOUT_MS },
          { type: "BROADCAST_STATE" },
        ],
      };
    case "HOLD_DRAINED":
      return {
        nextState: { kind: "LIVE", streamEpoch: event.newStreamEpoch },
        effects: [
          { type: "REQUEST_POWER_RESUME" },
          { type: "ADVANCE_EPOCH_AND_RESET", streamEpoch: event.newStreamEpoch },
          { type: "BROADCAST_STATE" },
        ],
      };
    case "STREAM_RESET":
      return {
        nextState: { kind: "LIVE", streamEpoch: event.newStreamEpoch },
        effects: [
          { type: "FLUSH_CATCHUP_QUEUE" },
          { type: "REQUEST_POWER_RESUME" },
          { type: "ADVANCE_EPOCH_AND_RESET", streamEpoch: event.newStreamEpoch },
          { type: "CANCEL_INTERACTION_TIMER" },
          { type: "BROADCAST_STATE" },
        ],
      };
    case "INTERACTION_TIMEOUT":
    case "CATCHUP_DRAINED":
    case "SOCKET_CONGESTED":
    case "HOLD_THRESHOLD_REACHED":
      return { nextState: state, effects: [] };
    default:
      return assertNever(event);
  }
}

// Spec: docs/architecture.md#3.5
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}

// Spec: docs/architecture.md#3.5
export function createInitialStreamingState(
  streamEpoch = STREAM_EPOCH_INITIAL,
  reason: StandbyReason = "UNAUTHENTICATED",
): StreamingState {
  return {
    kind: "STANDBY",
    streamEpoch,
    reason,
  };
}

// Spec: docs/specs/03-streaming-transport.md#2.2
export function transitionStreamingState(
  state: StreamingState,
  event: StreamingEvent,
): StreamingTransition {
  switch (state.kind) {
    case "STANDBY":
      return transitionFromStandby(state, event);
    case "INTERACTIVE":
      return transitionFromInteractive(state, event);
    case "LIVE":
      return transitionFromLive(state, event);
    case "CATCHUP":
      return transitionFromCatchup(state, event);
    case "BUFFER_HOLD":
      return transitionFromBufferHold(state, event);
    default:
      return assertNever(state);
  }
}

// Spec: docs/specs/04-client-playback-avsync.md#2.3
export function selectQueueKind(state: StreamingState): QueueKind {
  switch (state.kind) {
    case "STANDBY":
      return "NONE";
    case "INTERACTIVE":
    case "LIVE":
      return "LIVE";
    case "CATCHUP":
    case "BUFFER_HOLD":
      return "CATCHUP";
    default:
      return assertNever(state);
  }
}

// Spec: docs/specs/03-streaming-transport.md#2.2
export function isInputAllowed(state: StreamingState): boolean {
  switch (state.kind) {
    case "STANDBY":
      return false;
    case "INTERACTIVE":
    case "LIVE":
    case "CATCHUP":
    case "BUFFER_HOLD":
      return true;
    default:
      return assertNever(state);
  }
}

// Spec: docs/specs/03-streaming-transport.md#2.2
export function shouldSuppressMediaSend(state: StreamingState): boolean {
  switch (state.kind) {
    case "STANDBY":
    case "BUFFER_HOLD":
      return true;
    case "INTERACTIVE":
    case "LIVE":
    case "CATCHUP":
      return false;
    default:
      return assertNever(state);
  }
}

// Spec: docs/specs/07-ui-hud-settings.md#2.1
export function selectHudModeBadge(state: StreamingState, input: HudProjectionInput): HudModeBadge {
  switch (state.kind) {
    case "STANDBY":
      return "STANDBY";
    case "BUFFER_HOLD":
      return "HOLD";
    case "INTERACTIVE":
      return "DIRECT_LIVE";
    case "LIVE":
    case "CATCHUP":
      if (input.isWaitingForKeyframe) {
        return "WAIT";
      }
      if (
        input.localBufferedMs >= HUD_LOCAL_BUF_THRESHOLD_MS ||
        input.serverBufferedMs >= HUD_SERVER_BUF_THRESHOLD_MS
      ) {
        return "BUF";
      }
      return "LIVE";
    default:
      return assertNever(state);
  }
}
