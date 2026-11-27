import * as fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  type AlignedDimensions,
  AUDIO_FLAG,
  AUTH_SECURITY_CONSTANTS,
  CHANNEL_ID,
  type ClientControlMessage,
  decodeMediaFrame,
  decodeServerControlFrame,
  encodeAuthFrame,
  encodeClientControlFrame,
  encodeResizeFrame,
  encodeTouchFrame,
  type MediaFrame,
  PROTOCOL_TIMING,
  type ServerControlMessage,
  STREAM_EPOCH_INITIAL,
  TOUCH_ACTION,
  type TouchFrame,
  VIDEO_FLAG,
  WS_CLOSE_CODE,
} from "@tesroid/shared";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createAppContainer } from "../../src/app/container.js";
import type { BrowserControlPort } from "../../src/domains/browser/ports.js";
import type {
  EncodedMediaPacket,
  EncoderControlPort,
  EncoderPacketListener,
} from "../../src/domains/encoder/ports.js";
import { SERVER_ENV_DEFAULTS, type ServerEnvConfig } from "../../src/infra/env.js";
import { createHttpServer } from "../../src/interfaces/http/server.js";
import { FakeClock, FakeGpuHardwareProbe, FakeProcessRunner } from "../helpers/fakes.js";

const tempDirs: string[] = [];

async function makeTempDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tesroid-p3-int-"));
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

function createPhase3BrowserFake() {
  let startCount = 0;
  let freezeCount = 0;
  let resumeCount = 0;
  let restartCount = 0;
  let monitoringPaused = false;
  const resizeCalls: AlignedDimensions[] = [];
  const touchCalls: TouchFrame[] = [];

  const port: BrowserControlPort = {
    start: async () => {
      startCount += 1;
    },
    stop: async () => {},
    freezeTree: async () => {
      freezeCount += 1;
    },
    resumeTree: async () => {
      resumeCount += 1;
    },
    restartBrowser: async () => {
      restartCount += 1;
    },
    setMonitoringPaused: (paused: boolean) => {
      monitoringPaused = paused;
    },
    getCurrentPageInfo: () => ({ url: "https://www.youtube.com", title: "YouTube" }),
    navigate: async () => {},
    goBack: async () => {},
    goForward: async () => {},
    reload: async () => {},
    toggleFullscreen: async () => {},
    setDisplayScale: async () => {},
    resizeViewport: async (dimensions) => {
      resizeCalls.push(dimensions);
    },
    injectTouch: async (frame) => {
      touchCalls.push(frame);
    },
    injectText: async () => {},
    injectKey: async () => {},
  };

  return {
    port,
    getStartCount: () => startCount,
    getFreezeCount: () => freezeCount,
    getResumeCount: () => resumeCount,
    getRestartCount: () => restartCount,
    isMonitoringPaused: () => monitoringPaused,
    resizeCalls,
    touchCalls,
  };
}

function createPhase3EncoderFake() {
  let epoch = STREAM_EPOCH_INITIAL;
  let videoRunning = false;
  let audioRunning = false;
  let ensureCalls = 0;
  let stopCalls = 0;
  const reconfigureCalls: AlignedDimensions[] = [];
  const listeners = new Set<EncoderPacketListener>();

  const port: EncoderControlPort = {
    ensureDualRunning: async () => {
      videoRunning = true;
      audioRunning = true;
      ensureCalls += 1;
    },
    stopAll: async () => {
      videoRunning = false;
      audioRunning = false;
      stopCalls += 1;
    },
    advanceEpochAndResetClock: () => {
      epoch += 1;
      return epoch;
    },
    pauseWithTimelineComp: async () => {
      videoRunning = false;
      audioRunning = false;
    },
    clearTimelineComp: () => {},
    getCurrentEpoch: () => epoch,
    detectBackend: async () => ({
      backend: "vaapi",
      vaapiDevice: "/dev/dri/renderD128",
      vaapiDriver: "radeonsi",
      reason: "fake",
    }),
    getActiveBackend: () => "vaapi",
    getHealthStatus: () => ({
      running: videoRunning && audioRunning,
      backend: "vaapi",
      mode: "auto",
      compressionLevel: 7,
      x264Preset: null,
      vaapiDriver: "radeonsi",
      lastFallbackReason: null,
      lastFallbackAt: null,
      captureResolution: { width: 1280, height: 720 },
      encodeResolution: { width: 1280, height: 720 },
    }),
    reconfigureDimensions: async (layoutDimensions) => {
      reconfigureCalls.push(layoutDimensions);
    },
    applySettingsUpdate: async () => {},
    restartVideoOnly: async () => {},
    restartAudioOnly: async () => {},
    subscribePackets: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    port,
    getEpoch: () => epoch,
    isDualRunning: () => videoRunning && audioRunning,
    getEnsureCalls: () => ensureCalls,
    getStopCalls: () => stopCalls,
    reconfigureCalls,
    emitPacket: (packet: EncodedMediaPacket) => {
      for (const listener of listeners) {
        listener(packet);
      }
    },
  };
}

type DecodedWsMessage =
  | { readonly kind: "control"; readonly message: ServerControlMessage }
  | { readonly kind: "media"; readonly frame: MediaFrame };

class WsTestClient {
  readonly ws: WebSocket;
  private readonly messages: DecodedWsMessage[] = [];
  private readonly waiters: Array<(msg: DecodedWsMessage) => void> = [];
  private closePromiseResolve:
    | ((event: { readonly code: number; readonly reason: string }) => void)
    | null = null;
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => {
      this.closePromiseResolve = resolve;
    });

    ws.on("message", (raw) => {
      const data =
        raw instanceof Uint8Array
          ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
          : raw instanceof ArrayBuffer
            ? new Uint8Array(raw)
            : new Uint8Array(Buffer.concat(raw));

      const channel = data[0];
      const decoded: DecodedWsMessage =
        channel === CHANNEL_ID.CONTROL_RESPONSE
          ? { kind: "control", message: decodeServerControlFrame(data) }
          : { kind: "media", frame: decodeMediaFrame(data) };

      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        waiter(decoded);
      } else {
        this.messages.push(decoded);
      }
    });

    ws.on("close", (code, reasonBuf) => {
      this.closePromiseResolve?.({ code, reason: reasonBuf.toString("utf8") });
    });
  }

  static async connect(wsUrl: string): Promise<WsTestClient> {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    const client = new WsTestClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });
    return client;
  }

  sendBinary(bytes: Uint8Array): void {
    this.ws.send(bytes, { binary: true });
  }

  sendControl(msg: ClientControlMessage): void {
    this.sendBinary(encodeClientControlFrame(msg));
  }

  async nextMessage(timeoutMs = 2_000): Promise<DecodedWsMessage> {
    const queued = this.messages.shift();
    if (queued !== undefined) {
      return queued;
    }
    return new Promise<DecodedWsMessage>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        const idx = this.waiters.indexOf(onMsg);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        reject(new Error("Timed out waiting for WebSocket message"));
      }, timeoutMs);
      const onMsg = (msg: DecodedWsMessage) => {
        globalThis.clearTimeout(timer);
        resolve(msg);
      };
      this.waiters.push(onMsg);
    });
  }

  async nextControl<T extends ServerControlMessage["type"]>(
    expectedType?: T,
  ): Promise<Extract<ServerControlMessage, { readonly type: T }>> {
    while (true) {
      const item = await this.nextMessage();
      if (item.kind !== "control") {
        continue;
      }
      if (expectedType === undefined || item.message.type === expectedType) {
        return item.message as Extract<ServerControlMessage, { readonly type: T }>;
      }
    }
  }

  async nextMedia(): Promise<MediaFrame> {
    while (true) {
      const item = await this.nextMessage();
      if (item.kind === "media") {
        return item.frame;
      }
    }
  }

  drainControlMessages(): ServerControlMessage[] {
    const out: ServerControlMessage[] = [];
    for (let i = 0; i < this.messages.length; ) {
      const entry = this.messages[i];
      if (entry?.kind === "control") {
        out.push(entry.message);
        this.messages.splice(i, 1);
      } else {
        i += 1;
      }
    }
    return out;
  }

  drainMediaFrames(): MediaFrame[] {
    const out: MediaFrame[] = [];
    for (let i = 0; i < this.messages.length; ) {
      const entry = this.messages[i];
      if (entry?.kind === "media") {
        out.push(entry.frame);
        this.messages.splice(i, 1);
      } else {
        i += 1;
      }
    }
    return out;
  }

  async close(code = 1000): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) {
      return;
    }
    this.ws.close(code);
    await this.closed;
  }
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, 25);
  });
}

async function startHarness(options?: { skipSetup?: boolean }) {
  const dataDir = await makeTempDataDir();
  const clock = new FakeClock(1_700_000_000_000);
  const browserFake = createPhase3BrowserFake();
  const encoderFake = createPhase3EncoderFake();
  const container = createAppContainer(makeEnv(dataDir), {
    clock,
    browser: browserFake.port,
    encoder: encoderFake.port,
  });
  await container.coordinator.initialize();
  const app = createHttpServer(container);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;

  if (!options?.skipSetup) {
    const setupRes = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { pin: "1234" },
    });
    expect(setupRes.statusCode).toBe(200);
  }

  const clients: WsTestClient[] = [];
  const connectClient = async (): Promise<WsTestClient> => {
    const client = await WsTestClient.connect(wsUrl);
    clients.push(client);
    return client;
  };

  const cleanup = async () => {
    for (const client of clients) {
      if (
        client.ws.readyState === WebSocket.OPEN ||
        client.ws.readyState === WebSocket.CONNECTING
      ) {
        client.ws.terminate();
      }
    }
    await app.close();
    await container.dispose();
  };

  return {
    clock,
    browserFake,
    encoderFake,
    container,
    app,
    wsUrl,
    connectClient,
    cleanup,
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

describe("Integration: Session, Power & Stream Reset (Spec 02, 03, 10)", () => {
  it("Spec 01 AC-02: allows valid initial PIN over WS /ws when setup is incomplete and establishes PRIMARY session", async () => {
    const harness = await startHarness({ skipSetup: true });
    try {
      const client = await harness.connectClient();
      const authReq = await client.nextControl("AUTH_REQUIRED");
      expect(authReq.isSetupCompleted).toBe(false);

      client.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "12" }));
      const failed = await client.nextControl("AUTH_FAILED");
      expect(failed.reason).toBe("INVALID_PIN");
      expect(harness.container.settings.getCurrent().isSetupCompleted).toBe(false);

      client.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      const authOk = await client.nextControl("AUTH_OK");
      expect(authOk.role).toBe("PRIMARY");
      expect(authOk.powerState).toBe("ACTIVE");
      expect(authOk.settings.isSetupCompleted).toBe(true);
      expect(harness.browserFake.getStartCount()).toBe(1);
      expect(harness.encoderFake.isDualRunning()).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("Spec 01 AC-08: ignores a second auth frame on an established connection without conflict, close, or attempt decrement", async () => {
    const harness = await startHarness();
    try {
      const client = await harness.connectClient();
      await client.nextControl("AUTH_REQUIRED");
      client.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      const authOk = await client.nextControl("AUTH_OK");

      client.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "0000" }));

      const outcome = await Promise.race([
        client.closed.then(() => "closed" as const),
        new Promise<"open">((resolve) => {
          globalThis.setTimeout(() => resolve("open"), 300);
        }),
      ]);
      expect(outcome).toBe("open");

      for (const msg of client.drainControlMessages()) {
        expect(msg.type).not.toBe("SESSION_CONFLICT");
        expect(msg.type).not.toBe("AUTH_FAILED");
      }

      const status = await harness.app.inject({ method: "GET", url: "/api/status" });
      const statusBody = status.json() as {
        remainingAttempts: number;
        consecutiveFailures: number;
      };
      expect(statusBody.consecutiveFailures).toBe(0);
      expect(statusBody.remainingAttempts).toBe(AUTH_SECURITY_CONSTANTS.maxConsecutiveFailures);

      const settings = await harness.app.inject({
        method: "GET",
        url: "/api/settings",
        headers: { authorization: `Bearer ${authOk.token}` },
      });
      expect(settings.statusCode).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });

  it("Spec 02 AC-01: displaces existing PRIMARY with WS 4009 on new raw PIN login and rejects competing token reconnect with WS 4009", async () => {
    const harness = await startHarness();
    try {
      const clientA = await harness.connectClient();
      await clientA.nextControl("AUTH_REQUIRED");
      clientA.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      const authA = await clientA.nextControl("AUTH_OK");
      expect(authA.role).toBe("PRIMARY");

      const verifyB = await harness.app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { pin: "1234", role: "PRIMARY" },
      });
      const tokenB = (verifyB.json() as { token: string }).token;

      const clientB = await harness.connectClient();
      await clientB.nextControl("AUTH_REQUIRED");
      clientB.sendBinary(encodeAuthFrame({ kind: "TOKEN", token: tokenB }));
      const conflictB = await clientB.nextControl("SESSION_CONFLICT");
      expect(conflictB.type).toBe("SESSION_CONFLICT");
      expect((await clientB.closed).code).toBe(WS_CLOSE_CODE.SESSION_CONFLICT);

      const clientC = await harness.connectClient();
      await clientC.nextControl("AUTH_REQUIRED");
      clientC.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      const conflictA = await clientA.nextControl("SESSION_CONFLICT");
      expect(conflictA.type).toBe("SESSION_CONFLICT");
      expect((await clientA.closed).code).toBe(WS_CLOSE_CODE.SESSION_CONFLICT);

      const authC = await clientC.nextControl("AUTH_OK");
      expect(authC.role).toBe("PRIMARY");
      expect(authC.token).not.toBe(authA.token);

      const oldTokenCheck = await harness.app.inject({
        method: "GET",
        url: "/api/settings",
        headers: { authorization: `Bearer ${authA.token}` },
      });
      expect(oldTokenCheck.statusCode).toBe(401);
    } finally {
      await harness.cleanup();
    }
  });

  it("Spec 02 AC-02: closes superseded socket with WS 4000 (not 4009) when new socket authenticates with identical token", async () => {
    const harness = await startHarness();
    try {
      const clientA = await harness.connectClient();
      await clientA.nextControl("AUTH_REQUIRED");
      clientA.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      const authA = await clientA.nextControl("AUTH_OK");
      const stopCallsBefore = harness.encoderFake.getStopCalls();

      const clientA2 = await harness.connectClient();
      await clientA2.nextControl("AUTH_REQUIRED");
      clientA2.sendBinary(encodeAuthFrame({ kind: "TOKEN", token: authA.token }));

      const closedA = await clientA.closed;
      expect(closedA.code).toBe(WS_CLOSE_CODE.SESSION_SUPERSEDED);
      expect(clientA.drainControlMessages().some((m) => m.type === "SESSION_CONFLICT")).toBe(false);

      const authA2 = await clientA2.nextControl("AUTH_OK");
      expect(authA2.role).toBe("PRIMARY");
      expect(authA2.token).toBe(authA.token);
      expect(harness.encoderFake.getStopCalls()).toBe(stopCallsBefore);
      expect(harness.container.session.hasActivePrimaryOrActing()).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("Spec 02 AC-03: ignores resize/reset from SECONDARY_STREAMING, omits audio packets to secondaries, and attaches fresh primary sync metadata on PONG", async () => {
    const harness = await startHarness();
    try {
      const primary = await harness.connectClient();
      await primary.nextControl("AUTH_REQUIRED");
      primary.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      const authP = await primary.nextControl("AUTH_OK");

      const secondary = await harness.connectClient();
      await secondary.nextControl("AUTH_REQUIRED");
      secondary.sendBinary(encodeAuthFrame({ kind: "SECONDARY_PIN", pin: "1234" }));
      const authS = await secondary.nextControl("AUTH_OK");
      expect(authS.role).toBe("SECONDARY_STREAMING");

      secondary.sendBinary(encodeResizeFrame({ width: 800, height: 600, dprX100: 150 }));
      const resetForbidden = await harness.app.inject({
        method: "POST",
        url: "/api/stream/reset",
        headers: { authorization: `Bearer ${authS.token}` },
      });
      expect(resetForbidden.statusCode).toBe(403);
      await flushMicrotasks();
      expect(harness.browserFake.resizeCalls).toHaveLength(0);
      expect(harness.encoderFake.reconfigureCalls).toHaveLength(0);

      primary.sendBinary(encodeResizeFrame({ width: 773, height: 553, dprX100: 153 }));
      await flushMicrotasks();
      expect(harness.browserFake.resizeCalls).toHaveLength(0);
      expect(harness.encoderFake.reconfigureCalls).toHaveLength(0);
      harness.clock.advanceByMs(PROTOCOL_TIMING.serverResizeDebounceMs);
      await flushMicrotasks();
      expect(harness.browserFake.resizeCalls).toHaveLength(1);
      expect(harness.encoderFake.reconfigureCalls).toHaveLength(1);
      const activeEpoch = harness.encoderFake.getEpoch();
      expect(activeEpoch).toBeGreaterThan(authP.streamEpoch);

      harness.encoderFake.emitPacket({
        mediaType: "video",
        flags: VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC,
        streamEpoch: activeEpoch,
        ptsUs: 1_000_000n,
        payload: new Uint8Array([1, 2, 3]),
      });
      harness.encoderFake.emitPacket({
        mediaType: "audio",
        flags: AUDIO_FLAG.KEYFRAME,
        streamEpoch: activeEpoch,
        ptsUs: 1_020_000n,
        payload: new Uint8Array([4, 5, 6]),
      });

      const primaryMedia1 = await primary.nextMedia();
      const primaryMedia2 = await primary.nextMedia();
      expect([primaryMedia1.channel, primaryMedia2.channel]).toEqual([
        CHANNEL_ID.VIDEO,
        CHANNEL_ID.AUDIO,
      ]);

      const secMedia = await secondary.nextMedia();
      expect(secMedia.channel).toBe(CHANNEL_ID.VIDEO);
      await flushMicrotasks();
      expect(secondary.drainMediaFrames()).toHaveLength(0);

      primary.sendControl({
        type: "PLAYBACK_FEEDBACK",
        streamEpoch: activeEpoch,
        renderedPtsUs: 4_500_000,
        videoBufferedMs: 250,
        audioBufferedMs: 200,
      });
      await flushMicrotasks();
      harness.clock.advanceByMs(150);

      secondary.sendControl({ type: "PING", clientTimestampMs: 9_999 });
      const pong = await secondary.nextControl("PONG");
      expect(pong.primaryRenderedPts).toBe(4_500_000);
      expect(pong.primaryFeedbackAgeMs).toBe(150);
      expect(pong.primaryTargetBufferMs).toBe(10_000);
      expect(pong.primaryMode).toBe("LIVE");
    } finally {
      await harness.cleanup();
    }
  });

  it("Spec 02 AC-04: keeps browser/encoders asleep when SECONDARY_STANDBY connects and promotes to streaming upon PRIMARY login", async () => {
    const harness = await startHarness();
    try {
      const standby = await harness.connectClient();
      await standby.nextControl("AUTH_REQUIRED");
      standby.sendBinary(encodeAuthFrame({ kind: "SECONDARY_PIN", pin: "1234" }));
      const authS = await standby.nextControl("AUTH_OK");
      expect(authS.role).toBe("SECONDARY_STANDBY");
      expect(authS.powerState).toBe("STOPPED");
      expect(harness.browserFake.getStartCount()).toBe(0);
      expect(harness.encoderFake.getEnsureCalls()).toBe(0);

      standby.sendBinary(
        encodeTouchFrame({
          action: TOUCH_ACTION.DOWN,
          pointerId: 1n,
          x: 100,
          y: 100,
          screenWidth: 800,
          screenHeight: 600,
          pressure: 100,
          actionButton: 0,
          buttons: 1,
        }),
      );
      standby.sendControl({ type: "PAUSE_BROWSER" });
      await flushMicrotasks();
      expect(harness.browserFake.touchCalls).toHaveLength(0);
      expect(harness.container.power.getStatus().state).toBe("STOPPED");

      const primary = await harness.connectClient();
      await primary.nextControl("AUTH_REQUIRED");
      primary.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      const authP = await primary.nextControl("AUTH_OK");
      expect(authP.powerState).toBe("ACTIVE");

      const statusMsg = await standby.nextControl("PRIMARY_SESSION_STATUS");
      expect(statusMsg.active).toBe(true);
      expect(harness.browserFake.getStartCount()).toBe(1);
      expect(harness.encoderFake.isDualRunning()).toBe(true);

      harness.encoderFake.emitPacket({
        mediaType: "video",
        flags: VIDEO_FLAG.KEYFRAME,
        streamEpoch: authP.streamEpoch,
        ptsUs: 500_000n,
        payload: new Uint8Array([9, 8]),
      });
      const secVideo = await standby.nextMedia();
      expect(secVideo.channel).toBe(CHANNEL_ID.VIDEO);
    } finally {
      await harness.cleanup();
    }
  });

  it("Spec 02 AC-05: promotes first secondary to ACTING_PRIMARY on explicit 1000 disconnect (or >3s 1001 grace), prevents chained promotion, and resets V/A encoders on PRIMARY return", async () => {
    const harness = await startHarness();
    try {
      const primaryA = await harness.connectClient();
      await primaryA.nextControl("AUTH_REQUIRED");
      primaryA.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      const authA = await primaryA.nextControl("AUTH_OK");

      const secB = await harness.connectClient();
      await secB.nextControl("AUTH_REQUIRED");
      secB.sendBinary(encodeAuthFrame({ kind: "SECONDARY_PIN", pin: "1234" }));
      await secB.nextControl("AUTH_OK");

      const secC = await harness.connectClient();
      await secC.nextControl("AUTH_REQUIRED");
      secC.sendBinary(encodeAuthFrame({ kind: "SECONDARY_PIN", pin: "1234" }));
      await secC.nextControl("AUTH_OK");

      primaryA.sendControl({
        type: "PLAYBACK_FEEDBACK",
        streamEpoch: authA.streamEpoch,
        renderedPtsUs: 2_000_000,
        videoBufferedMs: 100,
        audioBufferedMs: 100,
      });
      await flushMicrotasks();

      // 1001 reload starts 3,000 ms grace and nullifies PTS in PONG during grace.
      await primaryA.close(WS_CLOSE_CODE.GOING_AWAY);
      await flushMicrotasks();
      secB.sendControl({ type: "PING", clientTimestampMs: 1234 });
      const gracePong = await secB.nextControl("PONG");
      expect(gracePong.primaryRenderedPts).toBeNull();
      expect(gracePong.primaryFeedbackAgeMs).toBeNull();

      // Reconnecting within 3,000 ms cancels grace without promoting secB.
      harness.clock.advanceByMs(PROTOCOL_TIMING.reloadPromotionGraceMs - 500);
      const primaryA2 = await harness.connectClient();
      await primaryA2.nextControl("AUTH_REQUIRED");
      primaryA2.sendBinary(encodeAuthFrame({ kind: "TOKEN", token: authA.token }));
      await primaryA2.nextControl("AUTH_OK");
      expect(secB.drainControlMessages().some((m) => m.type === "SESSION_ROLE_CHANGED")).toBe(
        false,
      );

      // Exceeding 3,000 ms promotes secB to ACTING_PRIMARY.
      await primaryA2.close(WS_CLOSE_CODE.GOING_AWAY);
      await flushMicrotasks();
      harness.clock.advanceByMs(PROTOCOL_TIMING.reloadPromotionGraceMs);
      const promotedB = await secB.nextControl("SESSION_ROLE_CHANGED");
      expect(promotedB.role).toBe("ACTING_PRIMARY");

      // New PRIMARY logs in -> secB demotes with simultaneous V/A encoder reset and new streamEpoch.
      const stopBefore = harness.encoderFake.getStopCalls();
      const ensureBefore = harness.encoderFake.getEnsureCalls();
      const epochBefore = harness.encoderFake.getEpoch();
      const primaryD = await harness.connectClient();
      await primaryD.nextControl("AUTH_REQUIRED");
      primaryD.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      const authD = await primaryD.nextControl("AUTH_OK");
      const demotedB = await secB.nextControl("SESSION_ROLE_CHANGED");
      expect(demotedB.role).toBe("SECONDARY_STREAMING");
      expect(demotedB.streamEpoch).toBe(authD.streamEpoch);
      expect(authD.streamEpoch).toBeGreaterThan(epochBefore);
      expect(harness.encoderFake.getStopCalls()).toBeGreaterThan(stopBefore);
      expect(harness.encoderFake.getEnsureCalls()).toBeGreaterThan(ensureBefore);

      // Explicit 1000 disconnect promotes secB immediately; when secB explicitly disconnects, secC is NOT chain-promoted.
      primaryD.sendControl({ type: "DISCONNECT" });
      await primaryD.closed;
      const immediatePromotedB = await secB.nextControl("SESSION_ROLE_CHANGED");
      expect(immediatePromotedB.role).toBe("ACTING_PRIMARY");

      secB.sendControl({ type: "DISCONNECT" });
      await secB.closed;
      await flushMicrotasks();
      expect(secC.drainControlMessages().some((m) => m.type === "SESSION_ROLE_CHANGED")).toBe(
        false,
      );
      expect(harness.container.session.hasActivePrimaryOrActing()).toBe(false);

      harness.clock.advanceByMs(180_000);
      const standbyC = await secC.nextControl("PRIMARY_SESSION_STATUS");
      expect(standbyC.active).toBe(false);
      expect(harness.container.power.getStatus().state).toBe("SLEEP_PAUSED");
    } finally {
      await harness.cleanup();
    }
  });

  it("Spec 02 AC-06: protects secondary playback during primary 1006 transient disconnect until auto-sleep triggers SECONDARY_STANDBY", async () => {
    const harness = await startHarness();
    try {
      const primary = await harness.connectClient();
      await primary.nextControl("AUTH_REQUIRED");
      primary.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      const authP = await primary.nextControl("AUTH_OK");

      const secondary = await harness.connectClient();
      await secondary.nextControl("AUTH_REQUIRED");
      secondary.sendBinary(encodeAuthFrame({ kind: "SECONDARY_PIN", pin: "1234" }));
      await secondary.nextControl("AUTH_OK");

      // Transient 1006 drop (simulated via close code 1006 on coordinator or abnormal termination).
      const primaryAuthority = harness.container.session.getPrimaryAuthority();
      expect(primaryAuthority).not.toBeNull();
      if (primaryAuthority !== null) {
        harness.container.coordinator.handleWsClose(primaryAuthority.id, 1006);
      }
      await flushMicrotasks();
      expect(
        secondary
          .drainControlMessages()
          .some((m) => m.type === "SESSION_ROLE_CHANGED" || m.type === "PRIMARY_SESSION_STATUS"),
      ).toBe(false);

      harness.encoderFake.emitPacket({
        mediaType: "video",
        flags: VIDEO_FLAG.KEYFRAME,
        streamEpoch: authP.streamEpoch,
        ptsUs: 700_000n,
        payload: new Uint8Array([7, 7]),
      });
      const stillStreaming = await secondary.nextMedia();
      expect(stillStreaming.channel).toBe(CHANNEL_ID.VIDEO);

      harness.clock.advanceByMs(180_000);
      const demoted = await secondary.nextControl("PRIMARY_SESSION_STATUS");
      expect(demoted.active).toBe(false);
      expect(harness.container.power.getStatus().state).toBe("SLEEP_PAUSED");
    } finally {
      await harness.cleanup();
    }
  });

  it("Spec 03 AC-04 & Spec 10 AC-01: unifies POST /api/stream/reset (always resets V/A encoders + new streamEpoch) and POST /api/power/* lifecycle routes", async () => {
    const harness = await startHarness();
    try {
      const unauthReset = await harness.app.inject({
        method: "POST",
        url: "/api/stream/reset",
      });
      expect(unauthReset.statusCode).toBe(401);

      const primary = await harness.connectClient();
      await primary.nextControl("AUTH_REQUIRED");
      primary.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      const authP = await primary.nextControl("AUTH_OK");

      const stopBefore = harness.encoderFake.getStopCalls();
      const resetRes = await harness.app.inject({
        method: "POST",
        url: "/api/stream/reset",
        headers: { authorization: `Bearer ${authP.token}` },
      });
      expect(resetRes.statusCode).toBe(200);
      const resetBody = resetRes.json() as { ok: boolean; state: string; streamEpoch: number };
      expect(resetBody.ok).toBe(true);
      expect(resetBody.state).toBe("ACTIVE");
      expect(resetBody.streamEpoch).toBe(authP.streamEpoch + 1);
      expect(harness.encoderFake.getStopCalls()).toBe(stopBefore + 1);
      expect(harness.encoderFake.isDualRunning()).toBe(true);

      await harness.container.power.enterBufferHold();
      const statusHold = await harness.app.inject({ method: "GET", url: "/api/power/status" });
      expect((statusHold.json() as { state: string }).state).toBe("BUFFER_HOLD");

      const resetFromHold = await harness.app.inject({
        method: "POST",
        url: "/api/stream/reset",
        headers: { authorization: `Bearer ${authP.token}` },
      });
      expect(resetFromHold.statusCode).toBe(200);
      expect((resetFromHold.json() as { state: string; streamEpoch: number }).state).toBe("ACTIVE");
      expect((resetFromHold.json() as { streamEpoch: number }).streamEpoch).toBe(
        resetBody.streamEpoch + 1,
      );

      const sleepRes = await harness.app.inject({
        method: "POST",
        url: "/api/power/sleep",
        headers: { authorization: `Bearer ${authP.token}` },
      });
      expect(sleepRes.statusCode).toBe(200);
      expect((sleepRes.json() as { state: string }).state).toBe("SLEEP_PAUSED");

      const resumeRes = await harness.app.inject({
        method: "POST",
        url: "/api/power/resume",
        headers: { authorization: `Bearer ${authP.token}` },
      });
      expect(resumeRes.statusCode).toBe(200);
      expect((resumeRes.json() as { state: string }).state).toBe("ACTIVE");
      expect(harness.encoderFake.isDualRunning()).toBe(true);

      const restartRes = await harness.app.inject({
        method: "POST",
        url: "/api/power/restart-browser",
        headers: { authorization: `Bearer ${authP.token}` },
      });
      expect(restartRes.statusCode).toBe(200);
      expect((restartRes.json() as { state: string }).state).toBe("ACTIVE");
      expect(harness.browserFake.getRestartCount()).toBe(1);
      expect(harness.encoderFake.isDualRunning()).toBe(true);

      await flushMicrotasks();
      primary.drainControlMessages();
      primary.sendControl({ type: "PAUSE_BROWSER" });
      const wsSlept = await primary.nextControl("BROWSER_STATUS");
      expect(wsSlept.powerState).toBe("SLEEP_PAUSED");
      primary.sendControl({ type: "RESUME_BROWSER" });
      const wsStarting = await primary.nextControl("BROWSER_STATUS");
      expect(wsStarting.powerState).toBe("STARTING");
      const wsResumed = await primary.nextControl("BROWSER_STATUS");
      expect(wsResumed.powerState).toBe("ACTIVE");
    } finally {
      await harness.cleanup();
    }
  });

  it("Spec 03 AC-03 & AC-05: enters BUFFER_HOLD at >=85% ring buffer occupancy, keeps CATCHUP drain active on same-token reconnect until <=10%, and exits immediately on 4009 takeover", async () => {
    const harness = await startHarness();
    try {
      const primary = await harness.connectClient();
      await primary.nextControl("AUTH_REQUIRED");
      primary.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      const authP = await primary.nextControl("AUTH_OK");

      harness.encoderFake.emitPacket({
        mediaType: "video",
        flags: VIDEO_FLAG.CONFIG,
        streamEpoch: authP.streamEpoch,
        ptsUs: 0n,
        payload: new Uint8Array([0x01, 0x64]),
      });
      harness.encoderFake.emitPacket({
        mediaType: "video",
        flags: VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC,
        streamEpoch: authP.streamEpoch,
        ptsUs: 1_000_000n,
        payload: new Uint8Array([1, 2, 3]),
      });
      harness.encoderFake.emitPacket({
        mediaType: "video",
        flags: VIDEO_FLAG.AVCC,
        streamEpoch: authP.streamEpoch,
        ptsUs: 5_000_000n,
        payload: new Uint8Array([4, 5, 6]),
      });
      await primary.nextMedia();
      await primary.nextMedia();

      primary.sendControl({
        type: "PLAYBACK_FEEDBACK",
        streamEpoch: authP.streamEpoch,
        renderedPtsUs: 1_000_000,
        videoBufferedMs: 400,
        audioBufferedMs: 2_800,
      });
      await flushMicrotasks();

      // PONG reflects audio lag > video lag: max(0, 4000 - 2800) = 1200 ms.
      primary.sendControl({ type: "PING", clientTimestampMs: 777 });
      const pong = await primary.nextControl("PONG");
      expect(pong.serverRemainingBufferMs).toBe(1_200);

      // Terminate primary socket cleanly via real WS close path (close code 1006).
      primary.ws.terminate();
      await primary.closed;
      for (let i = 0; i < 100 && harness.container.session.getPrimaryAuthority() !== null; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(harness.container.session.getPrimaryAuthority()).toBeNull();
      for (let sec = 6; sec <= 52; sec += 1) {
        harness.encoderFake.emitPacket({
          mediaType: "video",
          flags: (sec % 2 === 0 ? VIDEO_FLAG.KEYFRAME : 0) | VIDEO_FLAG.AVCC,
          streamEpoch: authP.streamEpoch,
          ptsUs: BigInt(sec) * 1_000_000n,
          payload: new Uint8Array([sec]),
        });
      }
      await flushMicrotasks();
      expect(harness.container.power.getStatus().state).toBe("BUFFER_HOLD");
      expect(harness.container.streaming.getState().kind).toBe("BUFFER_HOLD");

      // Reconnect with same token: preserves BUFFER_HOLD (generation paused) while draining CATCHUP.
      const primaryReconn = await harness.connectClient();
      await primaryReconn.nextControl("AUTH_REQUIRED");
      primaryReconn.sendBinary(encodeAuthFrame({ kind: "TOKEN", token: authP.token }));
      const authReconn = await primaryReconn.nextControl("AUTH_OK");
      expect(authReconn.powerState).toBe("BUFFER_HOLD");

      // Advance client feedback + clock so CATCHUP drains <= 10% and auto-resumes ACTIVE.
      primaryReconn.sendControl({
        type: "PLAYBACK_FEEDBACK",
        streamEpoch: authP.streamEpoch,
        renderedPtsUs: 48_000_000,
        videoBufferedMs: 100,
        audioBufferedMs: 100,
      });
      await flushMicrotasks();
      harness.clock.advanceByMs(200);
      await flushMicrotasks();
      expect(harness.container.power.getStatus().state).toBe("ACTIVE");
      expect(harness.container.streaming.getState().kind).toBe("LIVE");
      const epochAfterHoldResume = harness.container.streaming.getState().streamEpoch;
      expect(harness.container.session.getPrimaryConfirmedPtsUs(epochAfterHoldResume)).toBeNull();

      // Re-enter BUFFER_HOLD and verify 4009 raw PIN takeover discards buffer and resumes ACTIVE immediately.
      await harness.container.power.enterBufferHold();
      expect(harness.container.power.getStatus().state).toBe("BUFFER_HOLD");
      const takeover = await harness.connectClient();
      await takeover.nextControl("AUTH_REQUIRED");
      takeover.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      await primaryReconn.closed;
      const authTakeover = await takeover.nextControl("AUTH_OK");
      expect(authTakeover.powerState).toBe("ACTIVE");
      expect(harness.container.streaming.getState().kind).toBe("LIVE");
    } finally {
      await harness.cleanup();
    }
  });

  it("Spec 03 AC-03 & AC-04: wires real EncoderService + StreamingController + PowerService + SessionService inside createAppContainer and resets confirmed PTS cleanly across epoch updates", async () => {
    const dataDir = await makeTempDataDir();
    const clock = new FakeClock(1_700_000_000_000);
    const browserFake = createPhase3BrowserFake();
    const runner = new FakeProcessRunner();
    const gpuProbe = new FakeGpuHardwareProbe();
    const container = createAppContainer(makeEnv(dataDir), {
      clock,
      browser: browserFake.port,
      processRunner: runner,
      gpuProbe,
    });
    await container.coordinator.initialize();
    const app = createHttpServer(container);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as AddressInfo;
    const client = await WsTestClient.connect(`ws://127.0.0.1:${address.port}/ws`);

    try {
      await app.inject({ method: "POST", url: "/api/setup", payload: { pin: "1234" } });
      await client.nextControl("AUTH_REQUIRED");
      client.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      const authOk = await client.nextControl("AUTH_OK");
      expect(authOk.powerState).toBe("ACTIVE");
      expect(container.encoder.getHealthStatus().running).toBe(true);
      expect(container.streaming.getState()).toEqual({
        kind: "LIVE",
        streamEpoch: authOk.streamEpoch,
      });

      // Record confirmed PTS on initial epoch.
      client.sendControl({
        type: "PLAYBACK_FEEDBACK",
        streamEpoch: authOk.streamEpoch,
        renderedPtsUs: 40_000_000,
        videoBufferedMs: 100,
        audioBufferedMs: 100,
      });
      await flushMicrotasks();
      expect(container.session.getPrimaryConfirmedPtsUs(authOk.streamEpoch)).toBe(40_000_000n);

      const resetRes = await app.inject({
        method: "POST",
        url: "/api/stream/reset",
        headers: { authorization: `Bearer ${authOk.token}` },
      });
      expect(resetRes.statusCode).toBe(200);
      const resetBody = resetRes.json() as { ok: boolean; streamEpoch: number; state: string };
      expect(resetBody.ok).toBe(true);
      expect(resetBody.state).toBe("ACTIVE");
      expect(resetBody.streamEpoch).toBe(authOk.streamEpoch + 1);
      expect(container.streaming.getState()).toEqual({
        kind: "LIVE",
        streamEpoch: resetBody.streamEpoch,
      });

      expect(container.session.getPrimaryConfirmedPtsUs(resetBody.streamEpoch)).toBeNull();
      client.sendControl({ type: "PING", clientTimestampMs: 101 });
      const pongAfterReset = await client.nextControl("PONG");
      expect(pongAfterReset.primaryRenderedPts).toBeNull();

      client.sendControl({
        type: "PLAYBACK_FEEDBACK",
        streamEpoch: authOk.streamEpoch,
        renderedPtsUs: 45_000_000,
        videoBufferedMs: 50,
        audioBufferedMs: 50,
      });
      await flushMicrotasks();
      expect(container.session.getPrimaryConfirmedPtsUs(resetBody.streamEpoch)).toBeNull();

      client.sendControl({
        type: "PLAYBACK_FEEDBACK",
        streamEpoch: resetBody.streamEpoch,
        renderedPtsUs: 200_000,
        videoBufferedMs: 50,
        audioBufferedMs: 50,
      });
      await flushMicrotasks();
      expect(container.session.getPrimaryConfirmedPtsUs(resetBody.streamEpoch)).toBe(200_000n);
      client.sendControl({ type: "PING", clientTimestampMs: 102 });
      const pongNewEpoch = await client.nextControl("PONG");
      expect(pongNewEpoch.primaryRenderedPts).toBe(200_000);

      // Restart browser also advances epoch, resets cursor to null, and accepts feedback on the restarted epoch.
      const restartRes = await app.inject({
        method: "POST",
        url: "/api/power/restart-browser",
        headers: { authorization: `Bearer ${authOk.token}` },
      });
      expect(restartRes.statusCode).toBe(200);
      const restartBody = restartRes.json() as { ok: boolean; streamEpoch: number; state: string };
      expect(restartBody.streamEpoch).toBe(resetBody.streamEpoch + 1);
      expect(container.session.getPrimaryConfirmedPtsUs(restartBody.streamEpoch)).toBeNull();
      client.sendControl({
        type: "PLAYBACK_FEEDBACK",
        streamEpoch: restartBody.streamEpoch,
        renderedPtsUs: 50_000,
        videoBufferedMs: 30,
        audioBufferedMs: 30,
      });
      await flushMicrotasks();
      expect(container.session.getPrimaryConfirmedPtsUs(restartBody.streamEpoch)).toBe(50_000n);
    } finally {
      client.ws.terminate();
      await app.close();
      await container.dispose();
      expect(container.encoder.getHealthStatus().running).toBe(false);
    }
  });
});
