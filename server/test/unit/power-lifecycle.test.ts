import { type PowerState, STREAM_EPOCH_INITIAL } from "@tesroid/shared";
import { describe, expect, it } from "vitest";
import {
  type PowerBrowserPort,
  type PowerEncoderPort,
  PowerService,
  type PowerSessionPort,
  type PowerStreamingPort,
  PowerTimers,
  transitionPowerState,
} from "../../src/domains/power/index.js";
import { SettingsService } from "../../src/domains/settings/index.js";
import { FakeAtomicJsonStore, FakeClock } from "../helpers/fakes.js";

function createPowerPortFakes() {
  const calls: string[] = [];
  let videoRunning = false;
  let audioRunning = false;
  let epoch = STREAM_EPOCH_INITIAL;
  let monitoringPaused = false;
  let hasActiveSession = false;

  const browser: PowerBrowserPort = {
    start: async () => {
      calls.push("browser:start");
    },
    stop: async () => {
      calls.push("browser:stop");
    },
    freezeTree: async () => {
      calls.push("browser:freeze");
    },
    resumeTree: async () => {
      calls.push("browser:resume");
    },
    restartBrowser: async () => {
      calls.push("browser:restart");
    },
    setMonitoringPaused: (paused: boolean) => {
      monitoringPaused = paused;
      calls.push(`browser:monitoring=${paused}`);
    },
    getCurrentPageInfo: () => ({ url: "https://www.youtube.com", title: "YouTube" }),
  };

  const encoder: PowerEncoderPort = {
    ensureDualRunning: async () => {
      videoRunning = true;
      audioRunning = true;
      calls.push("encoder:ensureDualRunning");
    },
    stopAll: async () => {
      videoRunning = false;
      audioRunning = false;
      calls.push("encoder:stopAll");
    },
    advanceEpochAndResetClock: () => {
      epoch += 1;
      calls.push(`encoder:advanceEpoch(${epoch})`);
      return epoch;
    },
    pauseWithTimelineComp: async () => {
      videoRunning = false;
      audioRunning = false;
      calls.push("encoder:pauseWithTimelineComp");
    },
    clearTimelineComp: () => {
      calls.push("encoder:clearTimelineComp");
    },
    getCurrentEpoch: () => epoch,
  };

  const broadcastStates: Array<{ readonly state: PowerState; readonly epoch: number }> = [];
  const streaming: PowerStreamingPort = {
    clearBufferAndQueues: () => {
      calls.push("streaming:clearBuffer");
    },
    broadcastPowerState: (state: PowerState, streamEpoch: number) => {
      broadcastStates.push({ state, epoch: streamEpoch });
      calls.push(`streaming:broadcast(${state},${streamEpoch})`);
    },
    onPowerSleep: () => {
      calls.push("streaming:onPowerSleep");
    },
    onPowerHoldEntered: () => {
      calls.push("streaming:onPowerHoldEntered");
    },
    onPowerHoldExited: (newEpoch: number) => {
      calls.push(`streaming:onPowerHoldExited(${newEpoch})`);
    },
  };

  const session: PowerSessionPort = {
    hasActivePrimaryOrActing: () => hasActiveSession,
    demoteAllStreamingToStandby: (streamEpoch: number) => {
      calls.push(`session:demote(${streamEpoch})`);
    },
    promoteStandbyToStreaming: (streamEpoch: number) => {
      calls.push(`session:promote(${streamEpoch})`);
    },
  };

  return {
    calls,
    broadcastStates,
    browser,
    encoder,
    streaming,
    session,
    isDualRunning: () => videoRunning && audioRunning,
    isMonitoringPaused: () => monitoringPaused,
    setHasActiveSession: (active: boolean) => {
      hasActiveSession = active;
    },
    getEpoch: () => epoch,
  };
}

async function createPowerHarness(options?: {
  autoSleepMinutes?: number;
  targetBufferMs?: number;
  holdExpireMinutes?: number;
}) {
  const clock = new FakeClock(1_700_000_000_000);
  const store = new FakeAtomicJsonStore();
  const settings = new SettingsService({ store, filePath: "/data/settings.json" });
  await settings.load();
  await settings.completeSetup({ pinHash: "$2a$10$hash", timezone: "Asia/Tokyo" });
  if (options?.autoSleepMinutes !== undefined || options?.targetBufferMs !== undefined) {
    await settings.updateSettings(
      {
        stream: {
          autoSleepMinutes: options.autoSleepMinutes,
          targetBufferMs: options.targetBufferMs,
        },
      },
      { backend: "vaapi" },
    );
  }

  const fakes = createPowerPortFakes();
  let serviceRef: PowerService | undefined;
  const timers = new PowerTimers({
    clock,
    onAutoSleepExpired: () => {
      void serviceRef?.handleAutoSleepExpired();
    },
    onHoldExpired: () => {
      void serviceRef?.handleHoldExpired();
    },
  });
  const service = new PowerService({
    clock,
    settings,
    browser: fakes.browser,
    encoder: fakes.encoder,
    streaming: fakes.streaming,
    session: fakes.session,
    timers,
    holdExpireMinutes: options?.holdExpireMinutes ?? 10,
  });
  serviceRef = service;

  return { clock, settings, timers, service, fakes };
}

describe("server/domains/power (Spec 10)", () => {
  it("AC-01: routes sleep, resume, and restart-browser consistently through single lifecycle state machine with dual V/A encoder guarantee on ACTIVE", async () => {
    expect(transitionPowerState("BUFFER_HOLD", { type: "AUTO_SLEEP_EXPIRED" }).allowed).toBe(false);
    expect(transitionPowerState("SLEEP_PAUSED", { type: "HOLD_REQUESTED" }).allowed).toBe(false);

    const { service, fakes } = await createPowerHarness();
    expect(service.getStatus().state).toBe("STOPPED");

    const started = await service.ensureActive();
    expect(started.ok).toBe(true);
    expect(started.state).toBe("ACTIVE");
    expect(fakes.isDualRunning()).toBe(true);
    expect(fakes.isMonitoringPaused()).toBe(false);

    const slept = await service.sleep();
    expect(slept.ok).toBe(true);
    expect(slept.state).toBe("SLEEP_PAUSED");
    expect(fakes.isDualRunning()).toBe(false);
    expect(fakes.isMonitoringPaused()).toBe(true);
    expect(fakes.calls).toContain("browser:freeze");
    expect(fakes.calls).toContain("streaming:clearBuffer");
    expect(fakes.calls).toContain(`session:demote(${slept.streamEpoch})`);

    fakes.setHasActiveSession(true);
    const resumed = await service.resume();
    expect(resumed.ok).toBe(true);
    expect(resumed.state).toBe("ACTIVE");
    expect(resumed.streamEpoch).toBeGreaterThan(slept.streamEpoch);
    expect(fakes.isDualRunning()).toBe(true);
    expect(fakes.calls).toContain(`session:promote(${resumed.streamEpoch})`);

    const restarted = await service.restartBrowser();
    expect(restarted.ok).toBe(true);
    expect(restarted.state).toBe("ACTIVE");
    expect(restarted.streamEpoch).toBeGreaterThan(resumed.streamEpoch);
    expect(fakes.isDualRunning()).toBe(true);

    await service.sleep();
    fakes.calls.length = 0;
    const restartedFromSleep = await service.restartBrowser();
    expect(restartedFromSleep.ok).toBe(true);
    expect(restartedFromSleep.state).toBe("ACTIVE");
    expect(fakes.calls.indexOf("browser:resume")).toBeLessThan(
      fakes.calls.indexOf("browser:restart"),
    );
    expect(fakes.isDualRunning()).toBe(true);

    service.dispose();
  });

  it("AC-02: enforces strict mutual exclusion between autoSleepTimer and holdExpireTimer, and re-arms holdExpireTimer on primary disconnect in BUFFER_HOLD even when autoSleepMinutes = 0", async () => {
    const timerClock = new FakeClock();
    const expiredEvents: string[] = [];
    const timersOnly = new PowerTimers({
      clock: timerClock,
      onAutoSleepExpired: () => expiredEvents.push("auto"),
      onHoldExpired: () => expiredEvents.push("hold"),
    });

    timersOnly.armAutoSleep(5_000);
    expect(timersOnly.getActiveTimerKind()).toBe("AUTO_SLEEP");
    timersOnly.armHoldExpire(10_000);
    expect(timersOnly.getActiveTimerKind()).toBe("HOLD_EXPIRE");
    timerClock.advanceByMs(6_000);
    expect(expiredEvents).toEqual([]);
    timerClock.advanceByMs(4_000);
    expect(expiredEvents).toEqual(["hold"]);
    expect(timersOnly.getActiveTimerKind()).toBe("NONE");

    const { clock, timers, service, fakes } = await createPowerHarness({
      autoSleepMinutes: 0,
      holdExpireMinutes: 10,
    });

    fakes.setHasActiveSession(true);
    await service.onPrimaryConnected();
    expect(service.getStatus().state).toBe("ACTIVE");

    const holdRes = await service.enterBufferHold(10_000);
    expect(holdRes.ok).toBe(true);
    expect(holdRes.state).toBe("BUFFER_HOLD");
    expect(timers.getActiveTimerKind()).toBe("HOLD_EXPIRE");

    // Advance 4 minutes while primary is still connected, then primary disconnects.
    clock.advanceByMs(4 * 60_000);
    fakes.setHasActiveSession(false);
    service.onPrimaryDisconnected();
    expect(timers.getActiveTimerKind()).toBe("HOLD_EXPIRE");

    // Re-armed 10-minute timer must not expire after 9m59s, and must expire at 10m00s.
    fakes.calls.length = 0;
    clock.advanceByMs(9 * 60_000 + 59_000);
    await Promise.resolve();
    expect(service.getStatus().state).toBe("BUFFER_HOLD");

    clock.advanceByMs(1_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(service.getStatus().state).toBe("SLEEP_PAUSED");
    expect(timers.getActiveTimerKind()).toBe("NONE");
    expect(fakes.calls).not.toContain("browser:resume");
    expect(fakes.calls).toContain("encoder:clearTimelineComp");
    expect(fakes.calls).toContain("streaming:clearBuffer");

    service.dispose();
  });

  it("AC-03: converts manual sleep during BUFFER_HOLD directly to SLEEP_PAUSED without encoder resume churn, and clears Hold on new primary or LIVE fallback", async () => {
    const { service, timers, fakes } = await createPowerHarness();

    fakes.setHasActiveSession(true);
    await service.onPrimaryConnected();
    await service.enterBufferHold(10_000);
    expect(service.getStatus().state).toBe("BUFFER_HOLD");

    fakes.calls.length = 0;
    const manualSleep = await service.sleep();
    expect(manualSleep.ok).toBe(true);
    expect(manualSleep.state).toBe("SLEEP_PAUSED");
    expect(timers.getActiveTimerKind()).toBe("NONE");
    expect(fakes.calls).not.toContain("browser:resume");
    expect(fakes.calls).not.toContain("encoder:ensureDualRunning");
    expect(fakes.calls).toContain("encoder:clearTimelineComp");
    expect(fakes.calls).toContain("streaming:clearBuffer");

    await service.resume();
    await service.enterBufferHold(10_000);
    fakes.calls.length = 0;
    await service.onPrimaryConnected();
    expect(service.getStatus().state).toBe("ACTIVE");
    expect(timers.getActiveTimerKind()).toBe("NONE");
    expect(fakes.isDualRunning()).toBe(true);
    expect(fakes.calls).toContain("browser:resume");
    expect(fakes.calls).toContain("encoder:ensureDualRunning");

    await service.enterBufferHold(10_000);
    fakes.calls.length = 0;
    const fallbackRes = await service.exitBufferHold("LIVE_FALLBACK");
    expect(fallbackRes.ok).toBe(true);
    expect(fallbackRes.state).toBe("ACTIVE");
    expect(fakes.isDualRunning()).toBe(true);
    expect(fakes.calls).toContain("streaming:clearBuffer");
    expect(fakes.calls).toContain("encoder:clearTimelineComp");

    service.dispose();
  });

  it("AC-04: cancels autoSleepTimer when primary reconnects within grace delay, and transitions to SLEEP_PAUSED + demotes streaming secondaries when grace expires", async () => {
    const { clock, timers, service, fakes } = await createPowerHarness({
      autoSleepMinutes: 3,
      targetBufferMs: 10_000,
    });

    fakes.setHasActiveSession(true);
    await service.onPrimaryConnected();

    fakes.setHasActiveSession(false);
    service.onPrimaryDisconnected();
    expect(timers.getActiveTimerKind()).toBe("AUTO_SLEEP");

    clock.advanceByMs(120_000);
    expect(service.getStatus().state).toBe("ACTIVE");
    fakes.setHasActiveSession(true);
    await service.onPrimaryConnected();
    expect(timers.getActiveTimerKind()).toBe("NONE");

    clock.advanceByMs(180_000);
    expect(service.getStatus().state).toBe("ACTIVE");

    fakes.setHasActiveSession(false);
    service.onPrimaryDisconnected();
    expect(timers.getActiveTimerKind()).toBe("AUTO_SLEEP");

    fakes.calls.length = 0;
    clock.advanceByMs(180_000);
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
    expect(service.getStatus().state).toBe("SLEEP_PAUSED");
    expect(timers.getActiveTimerKind()).toBe("NONE");
    expect(fakes.calls).toContain(`session:demote(${fakes.getEpoch()})`);
    expect(fakes.broadcastStates.at(-1)?.state).toBe("SLEEP_PAUSED");

    service.dispose();
  });
});
