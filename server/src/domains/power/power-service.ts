import type { PowerActionResult, PowerStatusSnapshot } from "@tesroid/shared";
import type { Clock } from "../../infra/index.js";
import type { SettingsRepository } from "../settings/ports.js";
import type {
  HoldExitReason,
  PowerBrowserPort,
  PowerControllerPort,
  PowerEncoderPort,
  PowerSessionPort,
  PowerStreamingPort,
} from "./ports.js";
import type { PowerTimers } from "./power-timers.js";

export interface PowerServiceDeps {
  readonly clock: Clock;
  readonly settings: SettingsRepository;
  readonly browser: PowerBrowserPort;
  readonly encoder: PowerEncoderPort;
  readonly streaming: PowerStreamingPort;
  readonly session: PowerSessionPort;
  readonly timers: PowerTimers;
  readonly holdExpireMinutes: number;
}

export class PowerService implements PowerControllerPort {
  // Spec: docs/specs/10-power-lifecycle.md#2.1
  constructor(deps: PowerServiceDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  getStatus(): PowerStatusSnapshot {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.1
  ensureActive(): Promise<PowerActionResult> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  sleep(): Promise<PowerActionResult> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  resume(): Promise<PowerActionResult> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  restartBrowser(): Promise<PowerActionResult> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  enterBufferHold(targetBufferMs: number): Promise<PowerActionResult> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  exitBufferHold(reason: HoldExitReason): Promise<PowerActionResult> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  onPrimaryConnected(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  onPrimaryDisconnected(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  dispose(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
