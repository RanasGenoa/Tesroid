import { assertNever, type PowerState } from "@tesroid/shared";

export type PowerTransitionEvent =
  | { readonly type: "START_REQUESTED" }
  | { readonly type: "STARTUP_SUCCEEDED" }
  | { readonly type: "STARTUP_FAILED" }
  | { readonly type: "SLEEP_REQUESTED" }
  | { readonly type: "RESUME_REQUESTED" }
  | { readonly type: "RESTART_REQUESTED" }
  | { readonly type: "RESTART_SUCCEEDED" }
  | { readonly type: "HOLD_REQUESTED" }
  | { readonly type: "HOLD_RELEASED" }
  | { readonly type: "AUTO_SLEEP_EXPIRED" }
  | { readonly type: "HOLD_EXPIRED" };

export interface PowerTransitionResult {
  readonly nextState: PowerState;
  readonly allowed: boolean;
}

function transitionFromStopped(event: PowerTransitionEvent): PowerTransitionResult {
  switch (event.type) {
    case "START_REQUESTED":
    case "RESUME_REQUESTED":
      return { nextState: "STARTING", allowed: true };
    case "RESTART_REQUESTED":
      return { nextState: "RESTARTING", allowed: true };
    case "STARTUP_SUCCEEDED":
    case "STARTUP_FAILED":
    case "SLEEP_REQUESTED":
    case "RESTART_SUCCEEDED":
    case "HOLD_REQUESTED":
    case "HOLD_RELEASED":
    case "AUTO_SLEEP_EXPIRED":
    case "HOLD_EXPIRED":
      return { nextState: "STOPPED", allowed: false };
    default:
      return assertNever(event);
  }
}

function transitionFromStarting(event: PowerTransitionEvent): PowerTransitionResult {
  switch (event.type) {
    case "STARTUP_SUCCEEDED":
      return { nextState: "ACTIVE", allowed: true };
    case "STARTUP_FAILED":
      return { nextState: "ERROR", allowed: true };
    case "SLEEP_REQUESTED":
      return { nextState: "SLEEP_PAUSED", allowed: true };
    case "RESTART_REQUESTED":
      return { nextState: "RESTARTING", allowed: true };
    case "START_REQUESTED":
    case "RESUME_REQUESTED":
    case "RESTART_SUCCEEDED":
    case "HOLD_REQUESTED":
    case "HOLD_RELEASED":
    case "AUTO_SLEEP_EXPIRED":
    case "HOLD_EXPIRED":
      return { nextState: "STARTING", allowed: false };
    default:
      return assertNever(event);
  }
}

function transitionFromActive(event: PowerTransitionEvent): PowerTransitionResult {
  switch (event.type) {
    case "HOLD_REQUESTED":
      return { nextState: "BUFFER_HOLD", allowed: true };
    case "SLEEP_REQUESTED":
    case "AUTO_SLEEP_EXPIRED":
      return { nextState: "SLEEP_PAUSED", allowed: true };
    case "RESTART_REQUESTED":
      return { nextState: "RESTARTING", allowed: true };
    case "START_REQUESTED":
    case "STARTUP_SUCCEEDED":
    case "STARTUP_FAILED":
    case "RESUME_REQUESTED":
    case "RESTART_SUCCEEDED":
    case "HOLD_RELEASED":
    case "HOLD_EXPIRED":
      return { nextState: "ACTIVE", allowed: false };
    default:
      return assertNever(event);
  }
}

function transitionFromBufferHold(event: PowerTransitionEvent): PowerTransitionResult {
  switch (event.type) {
    case "HOLD_RELEASED":
      return { nextState: "ACTIVE", allowed: true };
    case "SLEEP_REQUESTED":
    case "HOLD_EXPIRED":
      return { nextState: "SLEEP_PAUSED", allowed: true };
    case "RESTART_REQUESTED":
      return { nextState: "RESTARTING", allowed: true };
    case "START_REQUESTED":
    case "STARTUP_SUCCEEDED":
    case "STARTUP_FAILED":
    case "RESUME_REQUESTED":
    case "RESTART_SUCCEEDED":
    case "HOLD_REQUESTED":
    case "AUTO_SLEEP_EXPIRED":
      return { nextState: "BUFFER_HOLD", allowed: false };
    default:
      return assertNever(event);
  }
}

function transitionFromSleepPaused(event: PowerTransitionEvent): PowerTransitionResult {
  switch (event.type) {
    case "START_REQUESTED":
    case "RESUME_REQUESTED":
      return { nextState: "STARTING", allowed: true };
    case "RESTART_REQUESTED":
      return { nextState: "RESTARTING", allowed: true };
    case "STARTUP_SUCCEEDED":
    case "STARTUP_FAILED":
    case "SLEEP_REQUESTED":
    case "RESTART_SUCCEEDED":
    case "HOLD_REQUESTED":
    case "HOLD_RELEASED":
    case "AUTO_SLEEP_EXPIRED":
    case "HOLD_EXPIRED":
      return { nextState: "SLEEP_PAUSED", allowed: false };
    default:
      return assertNever(event);
  }
}

function transitionFromRestarting(event: PowerTransitionEvent): PowerTransitionResult {
  switch (event.type) {
    case "RESTART_SUCCEEDED":
      return { nextState: "ACTIVE", allowed: true };
    case "STARTUP_FAILED":
      return { nextState: "ERROR", allowed: true };
    case "SLEEP_REQUESTED":
      return { nextState: "SLEEP_PAUSED", allowed: true };
    case "START_REQUESTED":
    case "STARTUP_SUCCEEDED":
    case "RESUME_REQUESTED":
    case "RESTART_REQUESTED":
    case "HOLD_REQUESTED":
    case "HOLD_RELEASED":
    case "AUTO_SLEEP_EXPIRED":
    case "HOLD_EXPIRED":
      return { nextState: "RESTARTING", allowed: false };
    default:
      return assertNever(event);
  }
}

function transitionFromError(event: PowerTransitionEvent): PowerTransitionResult {
  switch (event.type) {
    case "START_REQUESTED":
    case "RESUME_REQUESTED":
      return { nextState: "STARTING", allowed: true };
    case "RESTART_REQUESTED":
      return { nextState: "RESTARTING", allowed: true };
    case "SLEEP_REQUESTED":
      return { nextState: "SLEEP_PAUSED", allowed: true };
    case "STARTUP_SUCCEEDED":
    case "STARTUP_FAILED":
    case "RESTART_SUCCEEDED":
    case "HOLD_REQUESTED":
    case "HOLD_RELEASED":
    case "AUTO_SLEEP_EXPIRED":
    case "HOLD_EXPIRED":
      return { nextState: "ERROR", allowed: false };
    default:
      return assertNever(event);
  }
}

// Spec: docs/specs/10-power-lifecycle.md#2.1
export function transitionPowerState(
  current: PowerState,
  event: PowerTransitionEvent,
): PowerTransitionResult {
  switch (current) {
    case "STOPPED":
      return transitionFromStopped(event);
    case "STARTING":
      return transitionFromStarting(event);
    case "ACTIVE":
      return transitionFromActive(event);
    case "BUFFER_HOLD":
      return transitionFromBufferHold(event);
    case "SLEEP_PAUSED":
      return transitionFromSleepPaused(event);
    case "RESTARTING":
      return transitionFromRestarting(event);
    case "ERROR":
      return transitionFromError(event);
    default:
      return assertNever(current);
  }
}
