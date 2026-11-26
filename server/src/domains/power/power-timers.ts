import type { Clock, TimerHandle } from "../../infra/index.js";

export type ActivePowerTimerKind = "NONE" | "AUTO_SLEEP" | "HOLD_EXPIRE";

type ActiveTimerSlot =
  | { readonly kind: "NONE" }
  | { readonly kind: "AUTO_SLEEP"; readonly handle: TimerHandle }
  | { readonly kind: "HOLD_EXPIRE"; readonly handle: TimerHandle };

export interface PowerTimersDeps {
  readonly clock: Clock;
  readonly onAutoSleepExpired: () => void;
  readonly onHoldExpired: () => void;
}

export class PowerTimers {
  private readonly deps: PowerTimersDeps;
  private active: ActiveTimerSlot = { kind: "NONE" };

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  constructor(deps: PowerTimersDeps) {
    this.deps = deps;
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  getActiveTimerKind(): ActivePowerTimerKind {
    return this.active.kind;
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  armAutoSleep(delayMs: number): void {
    this.armExclusive("AUTO_SLEEP", delayMs, this.deps.onAutoSleepExpired);
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  armHoldExpire(delayMs: number): void {
    this.armExclusive("HOLD_EXPIRE", delayMs, this.deps.onHoldExpired);
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  cancelAll(): void {
    if (this.active.kind !== "NONE") {
      this.deps.clock.clearTimeout(this.active.handle);
      this.active = { kind: "NONE" };
    }
  }

  private armExclusive(
    kind: Exclude<ActivePowerTimerKind, "NONE">,
    delayMs: number,
    callback: () => void,
  ): void {
    this.cancelAll();
    const safeDelayMs = Number.isFinite(delayMs) ? Math.max(0, Math.round(delayMs)) : 0;
    const handle = this.deps.clock.setTimeout(() => {
      this.active = { kind: "NONE" };
      callback();
    }, safeDelayMs);
    this.active = { kind, handle };
  }
}
