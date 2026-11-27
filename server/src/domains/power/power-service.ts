import {
  BUFFER_HOLD_CONSTANTS,
  calculateAutoSleepDelayMs,
  type PowerActionResult,
  type PowerState,
  type PowerStatusSnapshot,
} from "@tesroid/shared";
import type { Clock } from "../../infra/index.js";
import type { SettingsRepository } from "../settings/ports.js";
import type {
  HoldExitReason,
  PowerBrowserPort,
  PowerControllerPort,
  PowerEncoderPort,
  PowerSessionPort,
  PowerStreamingPort,
  PrimaryConnectMode,
} from "./ports.js";
import { type PowerTransitionEvent, transitionPowerState } from "./power-fsm.js";
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

function clampHoldExpireMs(holdExpireMinutes: number): number {
  const minutes = Number.isFinite(holdExpireMinutes)
    ? Math.max(BUFFER_HOLD_CONSTANTS.minExpireMinutes, holdExpireMinutes)
    : BUFFER_HOLD_CONSTANTS.defaultExpireMinutes;
  return Math.round(minutes * 60_000);
}

export class PowerService implements PowerControllerPort {
  private readonly deps: PowerServiceDeps;
  private readonly holdExpireDelayMs: number;
  private state: PowerState = "STOPPED";
  private updatedAtMs: number;
  private operationQueue: Promise<unknown> = Promise.resolve();

  // Spec: docs/specs/10-power-lifecycle.md#2.1
  constructor(deps: PowerServiceDeps) {
    this.deps = deps;
    this.holdExpireDelayMs = clampHoldExpireMs(deps.holdExpireMinutes);
    this.updatedAtMs = deps.clock.nowMs();
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  getStatus(): PowerStatusSnapshot {
    const pageInfo = this.deps.browser.getCurrentPageInfo();
    return {
      state: this.state,
      streamEpoch: this.deps.encoder.getCurrentEpoch(),
      currentUrl: pageInfo.url,
      currentTitle: pageInfo.title,
      updatedAtMs: this.updatedAtMs,
    };
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.1
  ensureActive(): Promise<PowerActionResult> {
    this.deps.timers.cancelAll();
    return this.enqueue(() => this.ensureActiveInternal());
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  sleep(): Promise<PowerActionResult> {
    this.deps.timers.cancelAll();
    return this.enqueue(() => this.sleepInternal("SLEEP_REQUESTED"));
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  resume(): Promise<PowerActionResult> {
    this.deps.timers.cancelAll();
    return this.enqueue(() => this.resumeInternal());
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  restartBrowser(): Promise<PowerActionResult> {
    this.deps.timers.cancelAll();
    return this.enqueue(() => this.restartBrowserInternal());
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  enterBufferHold(): Promise<PowerActionResult> {
    return this.enqueue(() => this.enterBufferHoldInternal());
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  exitBufferHold(reason: HoldExitReason, atMs?: number): Promise<PowerActionResult> {
    this.deps.timers.cancelAll();
    return this.enqueue(() => this.exitBufferHoldInternal(reason, atMs));
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  async onPrimaryConnected(mode: PrimaryConnectMode): Promise<void> {
    await this.enqueue(async () => {
      if (this.state === "BUFFER_HOLD" && mode === "RECONNECT") {
        this.deps.session.promoteStandbyToStreaming(this.deps.encoder.getCurrentEpoch());
        return;
      }
      this.deps.timers.cancelAll();
      const result = await this.ensureActiveInternal();
      if (result.ok) {
        this.deps.session.promoteStandbyToStreaming(result.streamEpoch);
      }
    });
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  onPrimaryDisconnected(): void {
    if (this.deps.session.hasActivePrimaryOrActing()) {
      return;
    }
    if (this.state === "BUFFER_HOLD") {
      // Always re-arm hold expiry on primary disconnect even when autoSleepMinutes = 0.
      this.deps.timers.armHoldExpire(this.holdExpireDelayMs);
      return;
    }
    if (this.state === "ACTIVE") {
      const stream = this.deps.settings.getCurrent().stream;
      const delayMs = calculateAutoSleepDelayMs(stream.autoSleepMinutes);
      if (delayMs !== null) {
        this.deps.timers.armAutoSleep(delayMs);
      } else {
        this.deps.timers.cancelAll();
      }
    }
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  handleAutoSleepExpired(): Promise<PowerActionResult> {
    return this.enqueue(async () => {
      if (this.deps.session.hasActivePrimaryOrActing()) {
        return {
          ok: false,
          state: this.state,
          streamEpoch: this.deps.encoder.getCurrentEpoch(),
        };
      }
      return this.sleepInternal("AUTO_SLEEP_EXPIRED");
    });
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  handleHoldExpired(): Promise<PowerActionResult> {
    return this.enqueue(() => this.sleepInternal("HOLD_EXPIRED"));
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  dispose(): void {
    this.deps.timers.cancelAll();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(task, task);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private setState(nextState: PowerState): void {
    this.state = nextState;
    this.updatedAtMs = this.deps.clock.nowMs();
  }

  private applyFsm(event: PowerTransitionEvent): boolean {
    const result = transitionPowerState(this.state, event);
    if (!result.allowed) {
      return false;
    }
    this.setState(result.nextState);
    return true;
  }

  private async ensureActiveInternal(): Promise<PowerActionResult> {
    this.deps.timers.cancelAll();
    if (this.state === "ACTIVE") {
      await this.deps.encoder.ensureDualRunning();
      return {
        ok: true,
        state: this.state,
        streamEpoch: this.deps.encoder.getCurrentEpoch(),
      };
    }
    if (this.state === "BUFFER_HOLD") {
      return this.exitBufferHoldInternal("NEW_PRIMARY");
    }
    if (this.state === "SLEEP_PAUSED") {
      return this.resumeInternal();
    }

    if (!this.applyFsm({ type: "START_REQUESTED" })) {
      return {
        ok: false,
        state: this.state,
        streamEpoch: this.deps.encoder.getCurrentEpoch(),
      };
    }
    this.deps.streaming.broadcastPowerState(this.state, this.deps.encoder.getCurrentEpoch());

    try {
      await this.deps.browser.start();
      this.deps.browser.setMonitoringPaused(false);
      this.deps.encoder.clearTimelineComp();
      const epoch = this.deps.encoder.advanceEpochAndResetClock();
      this.deps.session.clearPrimaryFeedback();
      await this.deps.encoder.ensureDualRunning();
      this.applyFsm({ type: "STARTUP_SUCCEEDED" });
      this.deps.streaming.onPowerActive(epoch);
      this.deps.streaming.broadcastPowerState(this.state, epoch);
      return { ok: true, state: this.state, streamEpoch: epoch };
    } catch {
      this.applyFsm({ type: "STARTUP_FAILED" });
      const epoch = this.deps.encoder.getCurrentEpoch();
      this.deps.streaming.broadcastPowerState(this.state, epoch);
      return { ok: false, state: this.state, streamEpoch: epoch };
    }
  }

  private async sleepInternal(
    eventType: "SLEEP_REQUESTED" | "AUTO_SLEEP_EXPIRED" | "HOLD_EXPIRED",
  ): Promise<PowerActionResult> {
    this.deps.timers.cancelAll();
    if (this.state === "SLEEP_PAUSED") {
      return {
        ok: true,
        state: this.state,
        streamEpoch: this.deps.encoder.getCurrentEpoch(),
      };
    }

    const prevState = this.state;
    const transition = transitionPowerState(prevState, { type: eventType });
    if (!transition.allowed) {
      return {
        ok: false,
        state: this.state,
        streamEpoch: this.deps.encoder.getCurrentEpoch(),
      };
    }

    try {
      this.deps.browser.setMonitoringPaused(true);
      await this.deps.encoder.stopAll();
      this.deps.encoder.clearTimelineComp();

      // BUFFER_HOLD already froze the browser tree; convert directly without resume churn.
      if (prevState !== "BUFFER_HOLD") {
        await this.deps.browser.freezeTree();
      }
    } catch {
      if (prevState === "BUFFER_HOLD") {
        this.deps.timers.armHoldExpire(this.holdExpireDelayMs);
      } else {
        this.deps.browser.setMonitoringPaused(false);
      }
      return {
        ok: false,
        state: this.state,
        streamEpoch: this.deps.encoder.getCurrentEpoch(),
      };
    }

    this.deps.streaming.clearBufferAndQueues();
    this.deps.session.clearPrimaryFeedback();
    this.deps.streaming.onPowerSleep();
    this.setState(transition.nextState);

    const epoch = this.deps.encoder.getCurrentEpoch();
    this.deps.session.demoteAllStreamingToStandby(epoch);
    this.deps.streaming.broadcastPowerState(this.state, epoch);

    return { ok: true, state: this.state, streamEpoch: epoch };
  }

  private async resumeInternal(): Promise<PowerActionResult> {
    this.deps.timers.cancelAll();
    if (this.state === "ACTIVE") {
      await this.deps.encoder.ensureDualRunning();
      return {
        ok: true,
        state: this.state,
        streamEpoch: this.deps.encoder.getCurrentEpoch(),
      };
    }
    if (this.state === "BUFFER_HOLD") {
      return this.exitBufferHoldInternal("RESET");
    }
    if (this.state === "STOPPED" || this.state === "ERROR") {
      return this.ensureActiveInternal();
    }

    if (!this.applyFsm({ type: "RESUME_REQUESTED" })) {
      return {
        ok: false,
        state: this.state,
        streamEpoch: this.deps.encoder.getCurrentEpoch(),
      };
    }
    this.deps.streaming.broadcastPowerState(this.state, this.deps.encoder.getCurrentEpoch());

    try {
      await this.deps.browser.resumeTree();
      this.deps.browser.setMonitoringPaused(false);
      this.deps.encoder.clearTimelineComp();
      const epoch = this.deps.encoder.advanceEpochAndResetClock();
      this.deps.session.clearPrimaryFeedback();
      await this.deps.encoder.ensureDualRunning();
      this.applyFsm({ type: "STARTUP_SUCCEEDED" });
      this.deps.streaming.onPowerActive(epoch);
      this.deps.streaming.broadcastPowerState(this.state, epoch);
      if (this.deps.session.hasActivePrimaryOrActing()) {
        this.deps.session.promoteStandbyToStreaming(epoch);
      }
      return { ok: true, state: this.state, streamEpoch: epoch };
    } catch {
      this.applyFsm({ type: "STARTUP_FAILED" });
      const epoch = this.deps.encoder.getCurrentEpoch();
      this.deps.streaming.broadcastPowerState(this.state, epoch);
      return { ok: false, state: this.state, streamEpoch: epoch };
    }
  }

  private async restartBrowserInternal(): Promise<PowerActionResult> {
    this.deps.timers.cancelAll();
    const prevState = this.state;
    if (!this.applyFsm({ type: "RESTART_REQUESTED" })) {
      return {
        ok: false,
        state: this.state,
        streamEpoch: this.deps.encoder.getCurrentEpoch(),
      };
    }
    this.deps.streaming.broadcastPowerState(this.state, this.deps.encoder.getCurrentEpoch());

    try {
      this.deps.browser.setMonitoringPaused(true);
      await this.deps.encoder.stopAll();
      this.deps.encoder.clearTimelineComp();
      this.deps.streaming.clearBufferAndQueues();

      if (prevState === "SLEEP_PAUSED" || prevState === "BUFFER_HOLD") {
        await this.deps.browser.resumeTree();
      }
      await this.deps.browser.restartBrowser();
      this.deps.browser.setMonitoringPaused(false);
      const epoch = this.deps.encoder.advanceEpochAndResetClock();
      this.deps.session.clearPrimaryFeedback();
      await this.deps.encoder.ensureDualRunning();

      this.applyFsm({ type: "RESTART_SUCCEEDED" });
      this.deps.streaming.onPowerActive(epoch);
      this.deps.streaming.broadcastPowerState(this.state, epoch);
      if (this.deps.session.hasActivePrimaryOrActing()) {
        this.deps.session.promoteStandbyToStreaming(epoch);
      }
      return { ok: true, state: this.state, streamEpoch: epoch };
    } catch {
      this.applyFsm({ type: "STARTUP_FAILED" });
      const epoch = this.deps.encoder.getCurrentEpoch();
      this.deps.streaming.broadcastPowerState(this.state, epoch);
      return { ok: false, state: this.state, streamEpoch: epoch };
    }
  }

  private async enterBufferHoldInternal(): Promise<PowerActionResult> {
    const transition = transitionPowerState(this.state, { type: "HOLD_REQUESTED" });
    if (!transition.allowed) {
      return {
        ok: false,
        state: this.state,
        streamEpoch: this.deps.encoder.getCurrentEpoch(),
      };
    }

    try {
      this.deps.browser.setMonitoringPaused(true);
      await this.deps.encoder.pauseWithTimelineComp();
      await this.deps.browser.freezeTree();
    } catch {
      this.deps.browser.setMonitoringPaused(false);
      return {
        ok: false,
        state: this.state,
        streamEpoch: this.deps.encoder.getCurrentEpoch(),
      };
    }

    this.setState(transition.nextState);
    this.deps.timers.armHoldExpire(this.holdExpireDelayMs);

    const epoch = this.deps.encoder.getCurrentEpoch();
    this.deps.streaming.onPowerHoldEntered(this.updatedAtMs);
    this.deps.streaming.broadcastPowerState(this.state, epoch);
    return { ok: true, state: this.state, streamEpoch: epoch };
  }

  private async exitBufferHoldInternal(
    reason: HoldExitReason,
    atMs?: number,
  ): Promise<PowerActionResult> {
    this.deps.timers.cancelAll();
    const transition = transitionPowerState(this.state, { type: "HOLD_RELEASED" });
    if (!transition.allowed) {
      return {
        ok: false,
        state: this.state,
        streamEpoch: this.deps.encoder.getCurrentEpoch(),
      };
    }

    let epoch: number;
    try {
      await this.deps.browser.resumeTree();
      this.deps.browser.setMonitoringPaused(false);
      if (reason !== "DRAINED") {
        this.deps.streaming.clearBufferAndQueues();
        this.deps.encoder.clearTimelineComp();
      }
      epoch = this.deps.encoder.advanceEpochAndResetClock();
      this.deps.session.clearPrimaryFeedback();
      await this.deps.encoder.ensureDualRunning();
    } catch {
      this.deps.timers.armHoldExpire(this.holdExpireDelayMs);
      return {
        ok: false,
        state: this.state,
        streamEpoch: this.deps.encoder.getCurrentEpoch(),
      };
    }

    this.setState(transition.nextState);
    this.deps.streaming.onPowerHoldExited(epoch, reason, atMs);
    this.deps.streaming.broadcastPowerState(this.state, epoch);
    return { ok: true, state: this.state, streamEpoch: epoch };
  }
}
