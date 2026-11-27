import * as fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  CHANNEL_ID,
  type ClientMetricsSample,
  decodeServerControlFrame,
  encodeAuthFrame,
  encodeMetricsFrame,
  encodeTelemetryFrame,
  type HealthResponse,
  METRICS_LIMITS,
  type MetricsSummary,
  type ServerControlMessage,
  STREAM_EPOCH_INITIAL,
  TELEMETRY_CATEGORIES,
  TELEMETRY_LIMITS,
  type TelemetrySessionSummary,
  VIDEO_FLAG,
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
import { FakeClock } from "../helpers/fakes.js";

const tempDirs: string[] = [];

async function makeTempDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tesroid-p6-int-"));
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

function createBoundaryBrowserFake(): BrowserControlPort {
  return {
    start: async () => {},
    stop: async () => {},
    freezeTree: async () => {},
    resumeTree: async () => {},
    restartBrowser: async () => {},
    setMonitoringPaused: () => {},
    getCurrentPageInfo: () => ({ url: "https://www.youtube.com", title: "YouTube" }),
    navigate: async () => {},
    goBack: async () => {},
    goForward: async () => {},
    reload: async () => {},
    toggleFullscreen: async () => {},
    setDisplayScale: async () => {},
    resizeViewport: async () => {},
    getCurrentViewport: () => ({ width: 1_280, height: 720 }),
    injectTouch: async () => {},
    injectText: async () => {},
    injectKey: async () => {},
  };
}

function createBoundaryEncoderFake() {
  let epoch = STREAM_EPOCH_INITIAL;
  let running = false;
  const listeners = new Set<EncoderPacketListener>();

  const port: EncoderControlPort = {
    ensureDualRunning: async () => {
      running = true;
    },
    stopAll: async () => {
      running = false;
    },
    advanceEpochAndResetClock: () => {
      epoch += 1;
      return epoch;
    },
    pauseWithTimelineComp: async () => {
      running = false;
    },
    clearTimelineComp: () => {},
    getCurrentEpoch: () => epoch,
    detectBackend: async () => ({
      backend: "vaapi",
      vaapiDevice: "/dev/dri/renderD128",
      vaapiDriver: "radeonsi",
      reason: "test",
    }),
    getActiveBackend: () => "vaapi",
    getHealthStatus: () => ({
      running,
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
    reconfigureDimensions: async () => {},
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
    emitPacket: (packet: EncodedMediaPacket) => {
      for (const listener of listeners) {
        listener(packet);
      }
    },
  };
}

class WsTestClient {
  readonly ws: WebSocket;
  private readonly controlQueue: ServerControlMessage[] = [];
  private readonly waiters: Array<(msg: ServerControlMessage) => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => {
      const data =
        raw instanceof Uint8Array
          ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
          : raw instanceof ArrayBuffer
            ? new Uint8Array(raw)
            : new Uint8Array(Buffer.concat(raw));
      if (data[0] !== CHANNEL_ID.CONTROL_RESPONSE) {
        return;
      }
      const message = decodeServerControlFrame(data);
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        waiter(message);
      } else {
        this.controlQueue.push(message);
      }
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

  async nextControl<T extends ServerControlMessage["type"]>(
    expectedType?: T,
  ): Promise<Extract<ServerControlMessage, { readonly type: T }>> {
    while (true) {
      const msg = await this.nextAnyControl();
      if (expectedType === undefined || msg.type === expectedType) {
        return msg as Extract<ServerControlMessage, { readonly type: T }>;
      }
    }
  }

  private nextAnyControl(timeoutMs = 2_000): Promise<ServerControlMessage> {
    const queued = this.controlQueue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        const idx = this.waiters.indexOf(onMsg);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        reject(new Error("Timed out waiting for WS control message"));
      }, timeoutMs);
      const onMsg = (msg: ServerControlMessage) => {
        globalThis.clearTimeout(timer);
        resolve(msg);
      };
      this.waiters.push(onMsg);
    });
  }
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, 30);
  });
}

function makeSample(overrides: Partial<ClientMetricsSample> = {}): ClientMetricsSample {
  return {
    timestamp: Date.UTC(2026, 10, 27, 9, 0, 0),
    windowMs: 10_000,
    fps: 30,
    minFps: 27,
    maxFps: 31,
    droppedFrames: 1,
    decoderErrors: 0,
    totalRenderedFrames: 300,
    videoPackets: 120,
    videoBytes: 150_000,
    audioPackets: 500,
    bitrateKbps: 120,
    frameTimeP50Ms: 3.5,
    frameTimeP95Ms: 7.2,
    decodeQueueSize: 0,
    rttMs: 18,
    avDriftMs: 12.5,
    displayWidth: 773,
    displayHeight: 553,
    dpr: 1.53,
    ...overrides,
  };
}

async function startHarness() {
  const dataDir = await makeTempDataDir();
  const clock = new FakeClock(Date.UTC(2026, 10, 27, 9, 0, 0));
  const encoderFake = createBoundaryEncoderFake();
  const container = createAppContainer(makeEnv(dataDir), {
    clock,
    browser: createBoundaryBrowserFake(),
    encoder: encoderFake.port,
  });
  await container.coordinator.initialize();
  const app = createHttpServer(container);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;

  const setupRes = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { pin: "1234" },
  });
  expect(setupRes.statusCode).toBe(200);

  const clients: WsTestClient[] = [];
  const connectClient = async () => {
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

  return { dataDir, clock, encoderFake, container, app, connectClient, cleanup };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("Integration: Observability HTTP & WS API (Spec 08)", () => {
  it("AC-01: ingests client metrics exclusively via WS 0x14 and serves accurate summary and history via /api/metrics/*", async () => {
    const harness = await startHarness();
    try {
      const client = await harness.connectClient();
      await client.nextControl("AUTH_REQUIRED");
      client.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      await client.nextControl("AUTH_OK");

      client.sendBinary(
        encodeMetricsFrame(
          makeSample({
            timestamp: Date.UTC(2026, 10, 27, 9, 0, 10),
            fps: 30,
            droppedFrames: 2,
            decoderErrors: 1,
            avDriftMs: -6_500,
          }),
        ),
      );
      client.sendBinary(
        encodeMetricsFrame(
          makeSample({
            timestamp: Date.UTC(2026, 10, 27, 9, 0, 20),
            fps: 60,
            minFps: 55,
            maxFps: 60,
            droppedFrames: 3,
            decoderErrors: 2,
            avDriftMs: 5_500,
          }),
        ),
      );
      await flushAsync();

      const summaryRes = await harness.app.inject({
        method: "GET",
        url: "/api/metrics/summary",
      });
      expect(summaryRes.statusCode).toBe(200);
      const summary = summaryRes.json() as MetricsSummary;
      expect(summary.sampleCount).toBe(2);
      expect(summary.durationSec).toBe(20);
      expect(summary.totalDroppedFrames).toBe(5);
      expect(summary.totalDecoderErrors).toBe(3);
      expect(summary.minAvDriftMs).toBe(-6_500);
      expect(summary.maxAvDriftMs).toBe(5_500);
      expect(summary.avgAvDriftMs).toBe(-500);

      const historyRes = await harness.app.inject({
        method: "GET",
        url: "/api/metrics/history?limit=1",
      });
      expect(historyRes.statusCode).toBe(200);
      const history = historyRes.json() as ClientMetricsSample[];
      expect(history).toHaveLength(1);
      expect(history[0]?.fps).toBe(60);

      // Public /api/health endpoint works without auth and reports encoder + uptime.
      harness.clock.advanceByMs(1_000);
      const healthRes = await harness.app.inject({
        method: "GET",
        url: "/api/health",
        remoteAddress: "203.0.113.10",
      });
      expect(healthRes.statusCode).toBe(200);
      const health = healthRes.json() as HealthResponse;
      expect(health.ok).toBe(true);
      expect(health.uptimeSec).toBe(1);
      expect(health.powerState).toBe("ACTIVE");
      expect(health.encoder.backend).toBe("vaapi");
      expect(health.encoder.vaapiDriver).toBe("radeonsi");

      // Server emits SERVER_STATS every 2 seconds to authenticated sessions.
      harness.encoderFake.emitPacket({
        mediaType: "video",
        flags: VIDEO_FLAG.KEYFRAME,
        streamEpoch: STREAM_EPOCH_INITIAL,
        ptsUs: 1_000n,
        payload: new Uint8Array(500),
      });
      harness.clock.advanceByMs(METRICS_LIMITS.serverStatsIntervalMs - 1_000);
      const statsMsg = await client.nextControl("SERVER_STATS");
      expect(statsMsg.stats.encodeFps).toBeGreaterThan(0);
      expect(statsMsg.stats.sendBitrateKbps).toBeGreaterThan(0);
      expect(statsMsg.stats.powerState).toBe("ACTIVE");
    } finally {
      await harness.cleanup();
    }
  });

  it("AC-02/03: ingests telemetry via WS 0x15, serves session list, NDJSON downloads (404 when missing), and DELETE /api/telemetry/sessions", async () => {
    const harness = await startHarness();
    try {
      const client = await harness.connectClient();
      await client.nextControl("AUTH_REQUIRED");
      client.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      const authOk = await client.nextControl("AUTH_OK");

      // Telemetry is OFF by default: sending WS 0x15 must not create directory or file.
      client.sendBinary(
        encodeTelemetryFrame({
          events: [{ category: "network", event: "ignored_when_off" }],
        }),
      );
      await flushAsync();
      await expect(fs.access(path.join(harness.dataDir, "telemetry"))).rejects.toThrow();

      // Enable telemetry via HTTP settings API.
      const loginRes = await harness.app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { pin: "1234" },
      });
      const token = (loginRes.json() as { token: string }).token;
      const enableRes = await harness.app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { authorization: `Bearer ${token}` },
        payload: { stream: { telemetryEnabled: true } },
      });
      expect(enableRes.statusCode).toBe(200);
      expect(authOk.settings.stream.telemetryEnabled).toBe(false);

      client.sendBinary(
        encodeTelemetryFrame({
          events: TELEMETRY_CATEGORIES.map((category) => ({
            category,
            event: `api_${category}`,
            data: { ok: true },
          })),
        }),
      );
      await flushAsync();

      const listRes = await harness.app.inject({
        method: "GET",
        url: "/api/telemetry/sessions",
      });
      expect(listRes.statusCode).toBe(200);
      const sessions = listRes.json() as TelemetrySessionSummary[];
      expect(sessions).toHaveLength(1);
      const sessionId = sessions[0]?.sessionId ?? "";
      expect(sessionId).toBe(harness.container.telemetry.getCurrentSessionId());
      expect(sessions[0]?.lineCount).toBe(TELEMETRY_CATEGORIES.length);

      const latestDownload = await harness.app.inject({
        method: "GET",
        url: "/api/telemetry/sessions/latest/download",
      });
      expect(latestDownload.statusCode).toBe(200);
      expect(latestDownload.headers["content-type"]).toContain("application/x-ndjson");
      const lines = latestDownload.body
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { category: string });
      expect(lines.map((item) => item.category)).toEqual([...TELEMETRY_CATEGORIES]);

      const byIdDownload = await harness.app.inject({
        method: "GET",
        url: `/api/telemetry/sessions/${sessionId}/download`,
      });
      expect(byIdDownload.statusCode).toBe(200);
      expect(byIdDownload.body).toBe(latestDownload.body);

      const missingRes = await harness.app.inject({
        method: "GET",
        url: "/api/telemetry/sessions/non-existent-session/download",
      });
      expect(missingRes.statusCode).toBe(404);

      const traversalRes = await harness.app.inject({
        method: "GET",
        url: "/api/telemetry/sessions/..%2Fsettings.json/download",
      });
      expect(traversalRes.statusCode).toBe(404);

      const deleteRes = await harness.app.inject({
        method: "DELETE",
        url: "/api/telemetry/sessions",
      });
      expect(deleteRes.statusCode).toBe(200);

      const emptyList = await harness.app.inject({
        method: "GET",
        url: "/api/telemetry/sessions",
      });
      expect(emptyList.json()).toEqual([]);

      const latestAfterDelete = await harness.app.inject({
        method: "GET",
        url: "/api/telemetry/sessions/latest/download",
      });
      expect(latestAfterDelete.statusCode).toBe(404);
    } finally {
      await harness.cleanup();
    }
  });

  it("AC-04: drops > 512 KiB telemetry frames and unauthenticated WS 0x14/0x15 frames, permits loopback REST access, and enforces Bearer auth from remote IPs", async () => {
    const harness = await startHarness();
    try {
      const loginRes = await harness.app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { pin: "1234" },
      });
      const token = (loginRes.json() as { token: string }).token;

      await harness.app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { authorization: `Bearer ${token}` },
        payload: { stream: { telemetryEnabled: true } },
      });

      // Unauthenticated WS 0x14 and 0x15 frames must be ignored and receive AUTH_REQUIRED.
      const unauthClient = await harness.connectClient();
      await unauthClient.nextControl("AUTH_REQUIRED");
      unauthClient.sendBinary(encodeMetricsFrame(makeSample()));
      await unauthClient.nextControl("AUTH_REQUIRED");
      unauthClient.sendBinary(
        encodeTelemetryFrame({ events: [{ category: "network", event: "unauth_drop" }] }),
      );
      await unauthClient.nextControl("AUTH_REQUIRED");
      await flushAsync();

      expect(harness.container.metrics.getSummary().sampleCount).toBe(0);
      expect(await harness.container.telemetry.listSessions()).toEqual([]);

      // Authenticated client sending > 512 KiB telemetry frame must be dropped.
      const authClient = await harness.connectClient();
      await authClient.nextControl("AUTH_REQUIRED");
      authClient.sendBinary(encodeAuthFrame({ kind: "PRIMARY_PIN", pin: "1234" }));
      await authClient.nextControl("AUTH_OK");

      const oversizedPayload = Buffer.from(
        JSON.stringify({
          events: [{ category: "log", event: "oversized", data: { blob: "a".repeat(520 * 1024) } }],
        }),
        "utf8",
      );
      const oversizedFrame = new Uint8Array(1 + oversizedPayload.byteLength);
      oversizedFrame[0] = CHANNEL_ID.TELEMETRY;
      oversizedFrame.set(oversizedPayload, 1);
      expect(oversizedFrame.byteLength).toBeGreaterThan(TELEMETRY_LIMITS.maxPayloadBytes);
      authClient.sendBinary(oversizedFrame);
      await flushAsync();

      expect(await harness.container.telemetry.listSessions()).toEqual([]);

      // Loopback vs remote IP / proxied loopback HTTP auth boundaries.
      const protectedEndpoints = [
        { method: "GET" as const, url: "/api/metrics/summary" },
        { method: "GET" as const, url: "/api/metrics/history" },
        { method: "GET" as const, url: "/api/telemetry/sessions" },
        { method: "GET" as const, url: "/api/telemetry/sessions/latest/download" },
        { method: "DELETE" as const, url: "/api/telemetry/sessions" },
      ];

      for (const endpoint of protectedEndpoints) {
        const remoteUnauth = await harness.app.inject({
          method: endpoint.method,
          url: endpoint.url,
          remoteAddress: "203.0.113.10",
        });
        expect(remoteUnauth.statusCode).toBe(401);

        const proxiedUnauth = await harness.app.inject({
          method: endpoint.method,
          url: endpoint.url,
          remoteAddress: "127.0.0.1",
          headers: { "x-forwarded-for": "203.0.113.10" },
        });
        expect(proxiedUnauth.statusCode).toBe(401);

        const remoteAuth = await harness.app.inject({
          method: endpoint.method,
          url: endpoint.url,
          remoteAddress: "203.0.113.10",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(remoteAuth.statusCode).not.toBe(401);

        const loopbackRes = await harness.app.inject({
          method: endpoint.method,
          url: endpoint.url,
          remoteAddress: "127.0.0.1",
        });
        expect(loopbackRes.statusCode).not.toBe(401);
      }
    } finally {
      await harness.cleanup();
    }
  });
});
