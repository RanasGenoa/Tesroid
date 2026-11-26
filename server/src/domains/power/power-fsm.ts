import type { PowerState } from "@tesroid/shared";

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

// Spec: docs/specs/10-power-lifecycle.md#2.1
export function transitionPowerState(
  current: PowerState,
  event: PowerTransitionEvent,
): PowerTransitionResult {
  throw new Error("NOT_IMPLEMENTED");
}
