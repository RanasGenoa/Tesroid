import type { Clock } from "../../infra/index.js";

export type ActivePowerTimerKind = "NONE" | "AUTO_SLEEP" | "HOLD_EXPIRE";

export interface PowerTimersDeps {
  readonly clock: Clock;
  readonly onAutoSleepExpired: () => void;
  readonly onHoldExpired: () => void;
}

export class PowerTimers {
  // Spec: docs/specs/10-power-lifecycle.md#2.4
  constructor(deps: PowerTimersDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  getActiveTimerKind(): ActivePowerTimerKind {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  armAutoSleep(delayMs: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  armHoldExpire(delayMs: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  cancelAll(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
