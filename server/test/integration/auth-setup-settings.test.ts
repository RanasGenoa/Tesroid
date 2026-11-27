import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type AlignedDimensions,
  AUTH_SECURITY_CONSTANTS,
  type EncoderBackend,
  MAX_FAVORITES,
  type PublicAppSettings,
  STREAM_EPOCH_INITIAL,
  type SystemStatusResponse,
  WS_CLOSE_CODE,
} from "@tesroid/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createAppContainer } from "../../src/app/container.js";
import type { BrowserControlPort } from "../../src/domains/browser/ports.js";
import type { EncoderControlPort } from "../../src/domains/encoder/ports.js";
import type { SessionServicePort } from "../../src/domains/session/ports.js";
import { SERVER_ENV_DEFAULTS, type ServerEnvConfig } from "../../src/infra/env.js";
import { createHttpServer } from "../../src/interfaces/http/server.js";
import { FakeClock, FakeProcessExit, FakeProcessExitError } from "../helpers/fakes.js";

const tempDirs: string[] = [];

async function makeTempDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tesroid-p2-int-"));
  tempDirs.push(dir);
  return dir;
}

function makeEnv(dataDir: string): ServerEnvConfig {
  return {
    port: SERVER_ENV_DEFAULTS.port,
    dataDir,
    display: SERVER_ENV_DEFAULTS.display,
    locale: SERVER_ENV_DEFAULTS.locale,
    timezone: SERVER_ENV_DEFAULTS.timezone,
    encoderMode: "auto",
    vaapiDevice: null,
    libvaDriverName: null,
    telemetryLogDir: path.join(dataDir, "telemetry"),
    clientDistPath: path.resolve(dataDir, "client-dist-unused"),
    bufferHoldExpireMinutes: SERVER_ENV_DEFAULTS.bufferHoldExpireMinutes,
    playbackBufferSeconds: SERVER_ENV_DEFAULTS.playbackBufferSeconds,
    playbackBufferMaxBytes: SERVER_ENV_DEFAULTS.playbackBufferMaxBytes,
    idleToBufferSeconds: SERVER_ENV_DEFAULTS.idleToBufferSeconds,
  };
}

function createBoundaryBrowserFake(options?: { failScale?: boolean }): {
  port: BrowserControlPort;
  scaleCalls: number[];
  viewportCalls: AlignedDimensions[];
} {
  const scaleCalls: number[] = [];
  const viewportCalls: AlignedDimensions[] = [];
  let currentViewport: AlignedDimensions = { width: 1_280, height: 720 };
  const notUsed = (): never => {
    throw new Error("UNEXPECTED_CALL");
  };
  return {
    scaleCalls,
    viewportCalls,
    port: {
      start: notUsed,
      stop: async () => {},
      freezeTree: notUsed,
      resumeTree: notUsed,
      restartBrowser: notUsed,
      setMonitoringPaused: () => {},
      getCurrentPageInfo: () => ({ url: null, title: null }),
      navigate: notUsed,
      goBack: notUsed,
      goForward: notUsed,
      reload: notUsed,
      toggleFullscreen: notUsed,
      setDisplayScale: async (scale: number) => {
        scaleCalls.push(scale);
        if (options?.failScale) {
          throw new Error("Browser scale apply failed");
        }
      },
      resizeViewport: async (dimensions: AlignedDimensions) => {
        currentViewport = dimensions;
        viewportCalls.push(dimensions);
      },
      getCurrentViewport: () => currentViewport,
      injectTouch: notUsed,
      injectText: notUsed,
      injectKey: notUsed,
    },
  };
}

function createBoundaryEncoderFake(
  backend: EncoderBackend,
  options?: { failApply?: boolean },
): {
  port: EncoderControlPort;
  applyCalls: Array<{ videoChanged: boolean; audioChanged: boolean; dimensionsChanged: boolean }>;
} {
  const applyCalls: Array<{
    videoChanged: boolean;
    audioChanged: boolean;
    dimensionsChanged: boolean;
  }> = [];
  const notUsed = (): never => {
    throw new Error("UNEXPECTED_CALL");
  };
  return {
    applyCalls,
    port: {
      ensureDualRunning: notUsed,
      stopAll: async () => {},
      advanceEpochAndResetClock: () => STREAM_EPOCH_INITIAL,
      pauseWithTimelineComp: notUsed,
      clearTimelineComp: () => {},
      getCurrentEpoch: () => STREAM_EPOCH_INITIAL,
      detectBackend: notUsed,
      getActiveBackend: () => backend,
      getRenderNode: () => null,
      getHealthStatus: notUsed,
      reconfigureDimensions: notUsed,
      applySettingsUpdate: async (update) => {
        applyCalls.push(update);
        if (options?.failApply) {
          throw new Error("Encoder apply failed");
        }
      },
      restartVideoOnly: notUsed,
      restartAudioOnly: notUsed,
      subscribePackets: () => () => {},
    },
  };
}

function createBoundarySessionFake(): {
  port: SessionServicePort;
  policyViolationReasons: Array<{ code: number; reason: string }>;
} {
  const policyViolationReasons: Array<{ code: number; reason: string }> = [];
  const notUsed = (): never => {
    throw new Error("UNEXPECTED_CALL");
  };
  return {
    policyViolationReasons,
    port: {
      hasActivePrimaryOrActing: () => false,
      demoteAllStreamingToStandby: () => {},
      promoteStandbyToStreaming: () => {},
      authenticatePrimaryPin: notUsed,
      authenticateSecondaryPin: notUsed,
      authenticateToken: notUsed,
      handleDisconnect: notUsed,
      getSession: () => null,
      getPrimaryAuthority: () => null,
      getStreamingSecondaries: () => [],
      getAllSessions: () => [],
      recordPrimaryFeedback: () => {},
      clearPrimaryFeedback: () => {},
      getPrimaryConfirmedPtsUs: () => null,
      getPrimarySyncMetadata: () => ({
        primaryRenderedPts: null,
        primaryFeedbackAgeMs: null,
        primaryTargetBufferMs: 0,
        primaryMode: null,
      }),
      closeAllWithPolicyViolation: (reason: string) => {
        policyViolationReasons.push({ code: WS_CLOSE_CODE.POLICY_VIOLATION, reason });
      },
      dispose: () => {},
    },
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("Integration: Auth, Setup & Settings (Spec 01, 05, 07)", () => {
  it("Spec 01 AC-01: rejects invalid PINs with HTTP 400 and revokes all active session tokens immediately on valid PIN change via PUT /api/settings", async () => {
    const dataDir = await makeTempDataDir();
    const clock = new FakeClock(1_700_000_000_000);
    const container = createAppContainer(makeEnv(dataDir), { clock });
    await container.coordinator.initialize();
    const app = createHttpServer(container);

    try {
      for (const badPin of ["123", "123456789", "12ab", "１２３４", ""]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/setup",
          payload: { pin: badPin },
        });
        expect(res.statusCode).toBe(400);
      }

      const setupRes = await app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { pin: "1234" },
      });
      expect(setupRes.statusCode).toBe(200);

      const persistedRaw = await fs.readFile(path.join(dataDir, "settings.json"), "utf8");
      expect(persistedRaw).not.toContain('"1234"');
      const persisted = JSON.parse(persistedRaw) as { pinHash: string };
      expect(persisted.pinHash).toMatch(/^\$2[aby]\$10\$/);

      const primaryLogin = await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { pin: "1234", role: "PRIMARY" },
      });
      const secondaryLogin = await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { pin: "1234", role: "SECONDARY_STREAMING" },
      });
      expect(primaryLogin.statusCode).toBe(200);
      expect(secondaryLogin.statusCode).toBe(200);
      const token1 = (primaryLogin.json() as { token: string }).token;
      const token2 = (secondaryLogin.json() as { token: string }).token;

      const badChange = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { authorization: `Bearer ${token1}` },
        payload: { pin: "12ab" },
      });
      expect(badChange.statusCode).toBe(400);

      const keepPin = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { authorization: `Bearer ${token1}` },
        payload: { pin: "" },
      });
      expect(keepPin.statusCode).toBe(200);

      const getStillValid = await app.inject({
        method: "GET",
        url: "/api/settings",
        headers: { authorization: `Bearer ${token2}` },
      });
      expect(getStillValid.statusCode).toBe(200);

      const changePin = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { authorization: `Bearer ${token1}` },
        payload: { pin: "5678" },
      });
      expect(changePin.statusCode).toBe(200);

      for (const revokedToken of [token1, token2]) {
        const afterRevoke = await app.inject({
          method: "GET",
          url: "/api/settings",
          headers: { authorization: `Bearer ${revokedToken}` },
        });
        expect(afterRevoke.statusCode).toBe(401);
      }

      const oldPinAttempt = await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { pin: "1234" },
      });
      expect(oldPinAttempt.statusCode).toBe(401);

      const newPinAttempt = await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { pin: "5678" },
      });
      expect(newPinAttempt.statusCode).toBe(200);
    } finally {
      await app.close();
      await container.dispose();
    }
  });

  it("Spec 01 AC-02: rejects expired tokens (>= 24h TTL), enforces 10-minute sweep, and keeps failures unchanged for unconfigured or empty verify", async () => {
    const dataDir = await makeTempDataDir();
    const clock = new FakeClock(1_700_000_000_000);
    const container = createAppContainer(makeEnv(dataDir), { clock });
    await container.coordinator.initialize();
    const app = createHttpServer(container);

    try {
      const beforeSetupVerify = await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { pin: "1234" },
      });
      expect(beforeSetupVerify.statusCode).toBe(401);

      const emptyVerify = await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { pin: "" },
      });
      expect(emptyVerify.statusCode).toBe(400);

      const statusBefore = (
        await app.inject({ method: "GET", url: "/api/status" })
      ).json() as SystemStatusResponse;
      expect(statusBefore.consecutiveFailures).toBe(0);
      expect(statusBefore.remainingAttempts).toBe(10);

      await app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { pin: "1234" },
      });

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { pin: "1234" },
      });
      const token = (loginRes.json() as { token: string }).token;

      clock.advanceByMs(AUTH_SECURITY_CONSTANTS.tokenSweepIntervalMs);
      const validBeforeTtl = await app.inject({
        method: "GET",
        url: "/api/settings",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(validBeforeTtl.statusCode).toBe(200);
      expect(validBeforeTtl.json()).not.toHaveProperty("pinHash");

      clock.advanceByMs(
        AUTH_SECURITY_CONSTANTS.tokenTtlMs - AUTH_SECURITY_CONSTANTS.tokenSweepIntervalMs,
      );
      const expiredRes = await app.inject({
        method: "GET",
        url: "/api/settings",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(expiredRes.statusCode).toBe(401);
    } finally {
      await app.close();
      await container.dispose();
    }
  });

  it("Spec 01 AC-03: persists consecutive PIN failures to lockout.json, sends WS 1008 + exits(1) after 200ms on 10th failure, and aborts startup if locked", async () => {
    const dataDir = await makeTempDataDir();
    const clock = new FakeClock(1_700_000_000_000);
    const processExit = new FakeProcessExit();
    const sessionFake = createBoundarySessionFake();

    const container = createAppContainer(makeEnv(dataDir), {
      clock,
      processExit,
      session: sessionFake.port,
    });
    await container.coordinator.initialize();
    const app = createHttpServer(container);

    try {
      await app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { pin: "1234" },
      });

      for (let attempt = 1; attempt <= 9; attempt += 1) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/verify",
          payload: { pin: attempt === 1 ? "abc" : "9999" },
        });
        expect(res.statusCode).toBe(401);
        expect((res.json() as { remainingAttempts: number }).remainingAttempts).toBe(10 - attempt);

        const lockoutFile = JSON.parse(
          await fs.readFile(path.join(dataDir, "lockout.json"), "utf8"),
        ) as { consecutiveFailures: number; isLocked: boolean };
        expect(lockoutFile.consecutiveFailures).toBe(attempt);
        expect(lockoutFile.isLocked).toBe(false);
      }

      const tenthRes = await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { pin: "9999" },
      });
      expect(tenthRes.statusCode).toBe(403);
      expect((tenthRes.json() as { remainingAttempts: number }).remainingAttempts).toBe(0);

      expect(sessionFake.policyViolationReasons).toHaveLength(1);
      expect(sessionFake.policyViolationReasons[0]?.code).toBe(WS_CLOSE_CODE.POLICY_VIOLATION);

      const lockedFile = JSON.parse(
        await fs.readFile(path.join(dataDir, "lockout.json"), "utf8"),
      ) as { consecutiveFailures: number; isLocked: boolean };
      expect(lockedFile.consecutiveFailures).toBe(10);
      expect(lockedFile.isLocked).toBe(true);

      expect(processExit.exitCodes).toEqual([]);
      expect(() => clock.advanceByMs(AUTH_SECURITY_CONSTANTS.lockoutShutdownDelayMs)).toThrow(
        FakeProcessExitError,
      );
      expect(processExit.exitCodes).toEqual([1]);

      const restartedExit = new FakeProcessExit();
      const restarted = createAppContainer(makeEnv(dataDir), {
        clock,
        processExit: restartedExit,
      });
      await expect(restarted.coordinator.initialize()).rejects.toThrow(FakeProcessExitError);
      expect(restartedExit.exitCodes).toEqual([1]);
      await restarted.dispose();

      await fs.unlink(path.join(dataDir, "lockout.json"));
      const recoveredExit = new FakeProcessExit();
      const recovered = createAppContainer(makeEnv(dataDir), {
        clock,
        processExit: recoveredExit,
      });
      await recovered.coordinator.initialize();
      expect(recovered.coordinator.getSystemStatus().isLocked).toBe(false);
      expect(recovered.coordinator.getSystemStatus().remainingAttempts).toBe(10);
      await recovered.dispose();
    } finally {
      await app.close();
      await container.dispose();
    }
  });

  it("Spec 01 AC-04: rejects invalid timezone or unknown qualityPreset with HTTP 400 and rejects POST /api/setup with HTTP 403 once completed", async () => {
    const dataDir = await makeTempDataDir();
    const container = createAppContainer(makeEnv(dataDir), {
      clock: new FakeClock(1_700_000_000_000),
    });
    await container.coordinator.initialize();
    const app = createHttpServer(container);

    try {
      const badTz = await app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { pin: "1234", timezone: "Mars/Olympus" },
      });
      expect(badTz.statusCode).toBe(400);

      const badPreset = await app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { pin: "1234", qualityPreset: "ultra" },
      });
      expect(badPreset.statusCode).toBe(400);

      const okSetup = await app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { pin: "1234", timezone: "UTC" },
      });
      expect(okSetup.statusCode).toBe(200);

      const secondSetup = await app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { pin: "5678" },
      });
      expect(secondSetup.statusCode).toBe(403);
    } finally {
      await app.close();
      await container.dispose();
    }
  });

  it("Spec 01 AC-05: expands lightweight preset (0.65x, 24fps, 0.5M, 70% scale, 2,000 ms buffer), returns HTTP 200 even if partial live-apply fails, and falls back safely on corrupted settings.json", async () => {
    const gpuDataDir = await makeTempDataDir();
    const failingBrowser = createBoundaryBrowserFake({ failScale: true });
    const failingEncoder = createBoundaryEncoderFake("vaapi", { failApply: true });

    const gpuContainer = createAppContainer(makeEnv(gpuDataDir), {
      clock: new FakeClock(1_700_000_000_000),
      browser: failingBrowser.port,
      encoder: failingEncoder.port,
    });
    await gpuContainer.coordinator.initialize();
    const gpuApp = createHttpServer(gpuContainer);

    try {
      const setupRes = await gpuApp.inject({
        method: "POST",
        url: "/api/setup",
        payload: { pin: "1234", qualityPreset: "  LIGHTWEIGHT  " },
      });
      expect(setupRes.statusCode).toBe(200);
      expect(failingBrowser.scaleCalls).toEqual([70]);
      expect(failingEncoder.applyCalls).toHaveLength(1);

      const setupBody = setupRes.json() as PublicAppSettings;
      expect(setupBody.stream.preset).toBe("low_power");
      expect(setupBody.stream.maxSize).toBe(960);
      expect(setupBody.stream.clientProfile.active).toBe("lightweight");
      expect(setupBody.stream.fps).toBe(24);
      expect(setupBody.stream.videoBitrate).toBe(500_000);
      expect(setupBody.stream.displayScale).toBe(70);
      expect(setupBody.stream.targetBufferMs).toBe(2_000);

      const loginRes = await gpuApp.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { pin: "1234" },
      });
      const token = (loginRes.json() as { token: string }).token;
      const readBack = await gpuApp.inject({
        method: "GET",
        url: "/api/settings",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(readBack.statusCode).toBe(200);
      expect(readBack.json()).toEqual(setupBody);
    } finally {
      await gpuApp.close();
      await gpuContainer.dispose();
    }

    const cpuDataDir = await makeTempDataDir();
    const cpuEncoder = createBoundaryEncoderFake("software");
    const cpuContainer = createAppContainer(makeEnv(cpuDataDir), {
      clock: new FakeClock(1_700_000_000_000),
      encoder: cpuEncoder.port,
    });
    await cpuContainer.coordinator.initialize();
    const cpuApp = createHttpServer(cpuContainer);

    try {
      const setupRes = await cpuApp.inject({
        method: "POST",
        url: "/api/setup",
        payload: { pin: "1234", qualityPreset: "lightweight" },
      });
      expect(setupRes.statusCode).toBe(200);
      const body = setupRes.json() as PublicAppSettings;
      expect(body.stream.preset).toBe("cpu_low_power");
      expect(body.stream.x264Preset).toBe("ultrafast");
      expect(body.stream.maxSize).toBe(960);
      expect(body.stream.targetBufferMs).toBe(2_000);
    } finally {
      await cpuApp.close();
      await cpuContainer.dispose();
    }

    const corruptDir = await makeTempDataDir();
    await fs.writeFile(path.join(corruptDir, "settings.json"), "{corrupted-json", "utf8");
    const corruptContainer = createAppContainer(makeEnv(corruptDir), {
      clock: new FakeClock(1_700_000_000_000),
    });
    await corruptContainer.coordinator.initialize();
    expect(corruptContainer.coordinator.getSystemStatus().isSetupCompleted).toBe(false);
    await corruptContainer.dispose();
  });

  it("Spec 05 AC-02/03 & Spec 07 AC-03: rejects duplicate favorite URLs across all paths, clamps videoBitrate to 2.0M, and propagates maxSize immediately", async () => {
    const dataDir = await makeTempDataDir();
    const encoderFake = createBoundaryEncoderFake("vaapi");
    const browserFake = createBoundaryBrowserFake();
    const container = createAppContainer(makeEnv(dataDir), {
      clock: new FakeClock(1_700_000_000_000),
      encoder: encoderFake.port,
      browser: browserFake.port,
    });
    await container.coordinator.initialize();
    const app = createHttpServer(container);

    try {
      await app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { pin: "1234" },
      });

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { pin: "1234" },
      });
      const token = (loginRes.json() as { token: string }).token;

      const dupRes = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          favorites: [
            { id: "yt1", title: "YouTube", url: "https://www.youtube.com", isHome: true },
            { id: "yt2", title: "YT Copy", url: "https://www.youtube.com/", isHome: false },
          ],
        },
      });
      expect(dupRes.statusCode).toBe(400);

      const tooMany = Array.from({ length: MAX_FAVORITES + 1 }, (_, i) => ({
        id: `fav-${i}`,
        title: `Fav ${i}`,
        url: `https://example.com/${i}`,
        isHome: i === 0,
      }));
      const limitRes = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { authorization: `Bearer ${token}` },
        payload: { favorites: tooMany },
      });
      expect(limitRes.statusCode).toBe(400);

      encoderFake.applyCalls.length = 0;

      const updateRes = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          stream: {
            videoBitrate: 5_000_000,
            maxSize: 960,
          },
        },
      });
      expect(updateRes.statusCode).toBe(200);
      const updated = updateRes.json() as PublicAppSettings;
      expect(updated.stream.videoBitrate).toBe(2_000_000);
      expect(updated.stream.maxSize).toBe(960);
      // Spec 05 §2.3: maxSize 更新はクライアントリサイズを待たず仮想ブラウザ寸法へ即反映される。
      expect(browserFake.viewportCalls).toEqual([{ width: 960, height: 540 }]);
      expect(encoderFake.applyCalls).toEqual([]);
    } finally {
      await app.close();
      await container.dispose();
    }
  });
});
