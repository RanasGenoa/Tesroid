import { type PowerState, type SessionRole, STREAM_EPOCH_INITIAL } from "@tesroid/shared";
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
  let browserFrozen = false;
  let browserRestartedWhileFrozen = false;
  let monitoringPaused = false;
  let videoRunning = false;
  let audioRunning = false;
  let timelineCompActive = false;
  let epoch = STREAM_EPOCH_INITIAL;
  let hasActiveSession = false;
  let confirmedPtsUs: bigint | null = null;
  let secondaryRole: Extract<SessionRole, "SECONDARY_STREAMING" | "SECONDARY_STANDBY"> =
    "SECONDARY_STANDBY";
  let streamingBufferDirty = false;
  let streamingPowerHoldActive = false;
  let streamingSleeping = false;
  let failNextStopAll = false;
  let failNextFreezeTree = false;
  let failNextResumeTree = false;
  const broadcastStates: Array<{ readonly state: PowerState; readonly epoch: number }> = [];

  const browser: PowerBrowserPort = {
    start: async () => {
      browserFrozen = false;
    },
    stop: async () => {
      browserFrozen = false;
    },
    freezeTree: async () => {
      if (failNextFreezeTree) {
        failNextFreezeTree = false;
        throw new Error("FREEZE_FAILED");
      }
      browserFrozen = true;
    },
    resumeTree: async () => {
      if (failNextResumeTree) {
        failNextResumeTree = false;
        throw new Error("RESUME_FAILED");
      }
      browserFrozen = false;
    },
    restartBrowser: async () => {
      if (browserFrozen) {
        browserRestartedWhileFrozen = true;
      }
    },
    setMonitoringPaused: (paused: boolean) => {
      monitoringPaused = paused;
    },
    getCurrentPageInfo: () => ({ url: "https://www.youtube.com", title: "YouTube" }),
  };

  const encoder: PowerEncoderPort = {
    ensureDualRunning: async () => {
      videoRunning = true;
      audioRunning = true;
    },
    stopAll: async () => {
      if (failNextStopAll) {
        failNextStopAll = false;
        throw new Error("STOP_FAILED");
      }
      videoRunning = false;
      audioRunning = false;
    },
    advanceEpochAndResetClock: () => {
      epoch += 1;
      return epoch;
    },
    pauseWithTimelineComp: async () => {
      videoRunning = false;
      audioRunning = false;
      timelineCompActive = true;
    },
    clearTimelineComp: () => {
      timelineCompActive = false;
    },
    getCurrentEpoch: () => epoch,
  };

  const streaming: PowerStreamingPort = {
    clearBufferAndQueues: () => {
      streamingBufferDirty = false;
    },
    broadcastPowerState: (state: PowerState, streamEpoch: number) => {
      broadcastStates.push({ state, epoch: streamEpoch });
    },
    onPowerActive: () => {
      streamingSleeping = false;
    },
    onPowerSleep: () => {
      streamingSleeping = true;
      streamingPowerHoldActive = false;
    },
    onPowerHoldEntered: () => {
      streamingPowerHoldActive = true;
    },
    onPowerHoldExited: () => {
      streamingPowerHoldActive = false;
    },
  };

  const session: PowerSessionPort = {
    hasActivePrimaryOrActing: () => hasActiveSession,
    demoteAllStreamingToStandby: () => {
      secondaryRole = "SECONDARY_STANDBY";
    },
    promoteStandbyToStreaming: () => {
      secondaryRole = "SECONDARY_STREAMING";
    },
    clearPrimaryFeedback: () => {
      confirmedPtsUs = null;
    },
  };

  return {
    broadcastStates,
    browser,
    encoder,
    streaming,
    session,
    isDualRunning: () => videoRunning && audioRunning,
    isMonitoringPaused: () => monitoringPaused,
    isBrowserFrozen: () => browserFrozen,
    wasBrowserRestartedWhileFrozen: () => browserRestartedWhileFrozen,
    isTimelineCompActive: () => timelineCompActive,
    isBufferDirty: () => streamingBufferDirty,
    markBufferDirty: () => {
      streamingBufferDirty = true;
    },
    isStreamingHoldActive: () => streamingPowerHoldActive,
    isStreamingSleeping: () => streamingSleeping,
    getConfirmedPtsUs: () => confirmedPtsUs,
    setConfirmedPtsUs: (ptsUs: bigint | null) => {
      confirmedPtsUs = ptsUs;
    },
    getSecondaryRole: () => secondaryRole,
    setSecondaryRole: (role: Extract<SessionRole, "SECONDARY_STREAMING" | "SECONDARY_STANDBY">) => {
      secondaryRole = role;
    },
    setHasActiveSession: (active: boolean) => {
      hasActiveSession = active;
    },
    injectFailure: (target: "stopAll" | "freezeTree" | "resumeTree") => {
      if (target === "stopAll") {
        failNextStopAll = true;
      } else if (target === "freezeTree") {
        failNextFreezeTree = true;
      } else {
        failNextResumeTree = true;
      }
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
      void serviceRef?.handleAutoSleepExpired().catch(() => undefined);
    },
    onHoldExpired: () => {
      void serviceRef?.handleHoldExpired().catch(() => undefined);
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

    fakes.setConfirmedPtsUs(1_000_000n);
    const started = await service.ensureActive();
    expect(started.ok).toBe(true);
    expect(started.state).toBe("ACTIVE");
    expect(fakes.isDualRunning()).toBe(true);
    expect(fakes.isMonitoringPaused()).toBe(false);
    expect(fakes.getConfirmedPtsUs()).toBeNull();

    fakes.setConfirmedPtsUs(2_000_000n);
    fakes.markBufferDirty();
    fakes.setSecondaryRole("SECONDARY_STREAMING");
    const slept = await service.sleep();
    expect(slept.ok).toBe(true);
    expect(slept.state).toBe("SLEEP_PAUSED");
    expect(fakes.isDualRunning()).toBe(false);
    expect(fakes.isMonitoringPaused()).toBe(true);
    expect(fakes.isBrowserFrozen()).toBe(true);
    expect(fakes.isBufferDirty()).toBe(false);
    expect(fakes.getConfirmedPtsUs()).toBeNull();
    expect(fakes.isStreamingSleeping()).toBe(true);
    expect(fakes.getSecondaryRole()).toBe("SECONDARY_STANDBY");

    fakes.setHasActiveSession(true);
    fakes.setConfirmedPtsUs(3_000_000n);
    const resumed = await service.resume();
    expect(resumed.ok).toBe(true);
    expect(resumed.state).toBe("ACTIVE");
    expect(resumed.streamEpoch).toBeGreaterThan(slept.streamEpoch);
    expect(fakes.isDualRunning()).toBe(true);
    expect(fakes.isBrowserFrozen()).toBe(false);
    expect(fakes.isStreamingSleeping()).toBe(false);
    expect(fakes.getConfirmedPtsUs()).toBeNull();
    expect(fakes.getSecondaryRole()).toBe("SECONDARY_STREAMING");

    fakes.setConfirmedPtsUs(4_000_000n);
    const restarted = await service.restartBrowser();
    expect(restarted.ok).toBe(true);
    expect(restarted.state).toBe("ACTIVE");
    expect(restarted.streamEpoch).toBeGreaterThan(resumed.streamEpoch);
    expect(fakes.isDualRunning()).toBe(true);
    expect(fakes.getConfirmedPtsUs()).toBeNull();

    await service.sleep();
    const restartedFromSleep = await service.restartBrowser();
    expect(restartedFromSleep.ok).toBe(true);
    expect(restartedFromSleep.state).toBe("ACTIVE");
    expect(fakes.isBrowserFrozen()).toBe(false);
    expect(fakes.wasBrowserRestartedWhileFrozen()).toBe(false);
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
    await service.onPrimaryConnected("NEW_SESSION");
    expect(service.getStatus().state).toBe("ACTIVE");

    const holdRes = await service.enterBufferHold();
    expect(holdRes.ok).toBe(true);
    expect(holdRes.state).toBe("BUFFER_HOLD");
    expect(timers.getActiveTimerKind()).toBe("HOLD_EXPIRE");

    // Advance 4 minutes while primary is still connected, then primary disconnects.
    clock.advanceByMs(4 * 60_000);
    fakes.setHasActiveSession(false);
    service.onPrimaryDisconnected();
    expect(timers.getActiveTimerKind()).toBe("HOLD_EXPIRE");

    // Re-armed 10-minute timer must not expire after 9m59s, and must expire at 10m00s.
    fakes.markBufferDirty();
    clock.advanceByMs(9 * 60_000 + 59_000);
    await Promise.resolve();
    expect(service.getStatus().state).toBe("BUFFER_HOLD");

    clock.advanceByMs(1_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(service.getStatus().state).toBe("SLEEP_PAUSED");
    expect(timers.getActiveTimerKind()).toBe("NONE");
    expect(fakes.isBrowserFrozen()).toBe(true);
    expect(fakes.isTimelineCompActive()).toBe(false);
    expect(fakes.isBufferDirty()).toBe(false);

    service.dispose();
  });

  it("AC-03: converts manual sleep during BUFFER_HOLD directly to SLEEP_PAUSED without encoder resume churn, preserves BUFFER_HOLD on RECONNECT, and settles safely on I/O failure", async () => {
    const { service, timers, fakes } = await createPowerHarness();

    fakes.setHasActiveSession(true);
    await service.onPrimaryConnected("NEW_SESSION");
    await service.enterBufferHold();
    expect(service.getStatus().state).toBe("BUFFER_HOLD");
    expect(fakes.isStreamingHoldActive()).toBe(true);
    expect(fakes.isTimelineCompActive()).toBe(true);

    fakes.markBufferDirty();
    const manualSleep = await service.sleep();
    expect(manualSleep.ok).toBe(true);
    expect(manualSleep.state).toBe("SLEEP_PAUSED");
    expect(timers.getActiveTimerKind()).toBe("NONE");
    expect(fakes.isDualRunning()).toBe(false);
    expect(fakes.isTimelineCompActive()).toBe(false);
    expect(fakes.isBufferDirty()).toBe(false);
    expect(fakes.isStreamingHoldActive()).toBe(false);

    await service.resume();
    await service.enterBufferHold();
    const epochBeforeReconnect = fakes.getEpoch();
    await service.onPrimaryConnected("RECONNECT");
    expect(service.getStatus().state).toBe("BUFFER_HOLD");
    expect(timers.getActiveTimerKind()).toBe("HOLD_EXPIRE");
    expect(fakes.isBrowserFrozen()).toBe(true);
    expect(fakes.getEpoch()).toBe(epochBeforeReconnect);

    await service.onPrimaryConnected("NEW_SESSION");
    expect(service.getStatus().state).toBe("ACTIVE");
    expect(timers.getActiveTimerKind()).toBe("NONE");
    expect(fakes.isDualRunning()).toBe(true);
    expect(fakes.isBrowserFrozen()).toBe(false);
    expect(fakes.isTimelineCompActive()).toBe(false);

    // Failure during sleep/hold/exit settles safely to ok=false without leaving inconsistent state.
    fakes.injectFailure("freezeTree");
    const failedSleep = await service.sleep();
    expect(failedSleep).toMatchObject({ ok: false, state: "ACTIVE" });
    expect(fakes.isMonitoringPaused()).toBe(false);

    fakes.injectFailure("freezeTree");
    const failedHold = await service.enterBufferHold();
    expect(failedHold).toMatchObject({ ok: false, state: "ACTIVE" });
    expect(fakes.isMonitoringPaused()).toBe(false);

    await service.enterBufferHold();
    fakes.injectFailure("resumeTree");
    const failedExit = await service.exitBufferHold("DRAINED");
    expect(failedExit).toMatchObject({ ok: false, state: "BUFFER_HOLD" });
    expect(timers.getActiveTimerKind()).toBe("HOLD_EXPIRE");

    fakes.markBufferDirty();
    const fallbackRes = await service.exitBufferHold("LIVE_FALLBACK");
    expect(fallbackRes.ok).toBe(true);
    expect(fallbackRes.state).toBe("ACTIVE");
    expect(fakes.isDualRunning()).toBe(true);
    expect(fakes.isBufferDirty()).toBe(false);
    expect(fakes.isTimelineCompActive()).toBe(false);

    service.dispose();
  });

  it("AC-04: cancels autoSleepTimer when primary reconnects within grace delay, and transitions to SLEEP_PAUSED + demotes streaming secondaries when grace expires", async () => {
    const { clock, timers, service, fakes } = await createPowerHarness({
      autoSleepMinutes: 3,
      targetBufferMs: 10_000,
    });

    fakes.setHasActiveSession(true);
    await service.onPrimaryConnected("NEW_SESSION");
    fakes.setSecondaryRole("SECONDARY_STREAMING");

    fakes.setHasActiveSession(false);
    service.onPrimaryDisconnected();
    expect(timers.getActiveTimerKind()).toBe("AUTO_SLEEP");

    clock.advanceByMs(120_000);
    expect(service.getStatus().state).toBe("ACTIVE");
    fakes.setHasActiveSession(true);
    await service.onPrimaryConnected("RECONNECT");
    expect(timers.getActiveTimerKind()).toBe("NONE");

    clock.advanceByMs(180_000);
    expect(service.getStatus().state).toBe("ACTIVE");

    fakes.setHasActiveSession(false);
    service.onPrimaryDisconnected();
    expect(timers.getActiveTimerKind()).toBe("AUTO_SLEEP");

    clock.advanceByMs(180_000);
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
    expect(service.getStatus().state).toBe("SLEEP_PAUSED");
    expect(timers.getActiveTimerKind()).toBe("NONE");
    expect(fakes.getSecondaryRole()).toBe("SECONDARY_STANDBY");
    expect(fakes.broadcastStates.at(-1)?.state).toBe("SLEEP_PAUSED");

    service.dispose();
  });
});
