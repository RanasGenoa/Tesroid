import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type ClientMetricsSample,
  METRICS_LIMITS,
  TELEMETRY_CATEGORIES,
  TELEMETRY_LIMITS,
  type TelemetryEventInput,
} from "@tesroid/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  isValidTelemetryEvent,
  MetricsRingBuffer,
  sanitizeTelemetrySessionId,
  TelemetryStore,
} from "../../src/domains/observability/index.js";
import { SettingsService } from "../../src/domains/settings/settings-service.js";
import { NodeJsonlStore, parseServerEnv } from "../../src/infra/index.js";
import { FakeAtomicJsonStore, FakeClock, FakeJsonlStore } from "../helpers/fakes.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tesroid-p6-unit-"));
  tempDirs.push(dir);
  return dir;
}

function makeMetricsSample(overrides: Partial<ClientMetricsSample> = {}): ClientMetricsSample {
  return {
    timestamp: 1_700_000_000_000,
    windowMs: 10_000,
    fps: 30,
    minFps: 28,
    maxFps: 31,
    droppedFrames: 0,
    decoderErrors: 0,
    totalRenderedFrames: 300,
    videoPackets: 100,
    videoBytes: 125_000,
    audioPackets: 500,
    bitrateKbps: 100,
    frameTimeP50Ms: 4,
    frameTimeP95Ms: 8,
    decodeQueueSize: 1,
    rttMs: 25,
    avDriftMs: 0,
    displayWidth: 773,
    displayHeight: 553,
    dpr: 1.53,
    ...overrides,
  };
}

async function createSettingsRepo(telemetryEnabled: boolean): Promise<SettingsService> {
  const settings = new SettingsService({
    store: new FakeAtomicJsonStore(),
    filePath: "/virtual/settings.json",
  });
  await settings.load();
  if (telemetryEnabled) {
    await settings.updateSettings({ stream: { telemetryEnabled: true } }, { backend: "software" });
  }
  return settings;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("server/domains/observability (Spec 08)", () => {
  it("AC-01: aggregates 10s window deltas across 360-entry ring buffer without double-counting drops/errors and preserves signed A/V drift > 5,000 ms", () => {
    const buffer = new MetricsRingBuffer();

    const empty = buffer.getSummary();
    expect(empty.sampleCount).toBe(0);
    expect(empty.lastUpdated).toBeNull();
    expect(empty.totalDroppedFrames).toBe(0);
    expect(empty.totalDecoderErrors).toBe(0);

    // Push 365 samples so the oldest 5 (high drops/errors) are evicted by the 360-entry FIFO cap.
    for (let i = 0; i < 365; i += 1) {
      const isEvicted = i < 5;
      buffer.recordSample(
        makeMetricsSample({
          timestamp: 1_700_000_000_000 + i * 10_000,
          fps: isEvicted ? 10 : 30,
          minFps: isEvicted ? 5 : 24,
          maxFps: isEvicted ? 12 : 60,
          droppedFrames: isEvicted ? 100 : i % 3 === 0 ? 2 : 1,
          decoderErrors: isEvicted ? 50 : i === 360 ? 3 : 0,
          totalRenderedFrames: (i + 1) * 300,
          rttMs: i === 364 ? 120 : 20,
          avDriftMs: i === 363 ? -8_450.5 : i === 364 ? 7_200.25 : 10,
        }),
      );
    }

    const summary = buffer.getSummary();
    expect(summary.sampleCount).toBe(METRICS_LIMITS.maxHistoryEntries);
    expect(summary.durationSec).toBe(3_600);
    expect(summary.currentFps).toBe(30);
    expect(summary.minFps).toBe(24);
    expect(summary.maxFps).toBe(60);
    expect(summary.maxRttMs).toBe(120);

    // Remaining indices 5..364: count of indices where i % 3 === 0 is 120 (from 6..363 inclusive).
    expect(summary.totalDroppedFrames).toBe(120 * 2 + 240 * 1);
    expect(summary.totalDecoderErrors).toBe(3);

    // Signed drift > 5,000 ms must not be clipped or rounded.
    expect(summary.minAvDriftMs).toBe(-8_450.5);
    expect(summary.maxAvDriftMs).toBe(7_200.25);
    const expectedAvgDrift = (-8_450.5 + 7_200.25 + 358 * 10) / 360;
    expect(summary.avgAvDriftMs).toBeCloseTo(expectedAvgDrift, 6);
    expect(summary.lastUpdated).toBe(new Date(1_700_000_000_000 + 364 * 10_000).toISOString());

    expect(buffer.getHistory()).toHaveLength(METRICS_LIMITS.defaultHistoryLimit);
    expect(buffer.getHistory(0)).toHaveLength(METRICS_LIMITS.defaultHistoryLimit);
    expect(buffer.getHistory(-5)).toHaveLength(METRICS_LIMITS.defaultHistoryLimit);
    expect(buffer.getHistory(Number.NaN)).toHaveLength(METRICS_LIMITS.defaultHistoryLimit);
    expect(buffer.getHistory(500)).toHaveLength(METRICS_LIMITS.maxHistoryEntries);
    expect(buffer.getHistory(2).map((item) => item.avDriftMs)).toEqual([-8_450.5, 7_200.25]);

    buffer.clear();
    expect(buffer.getSummary().sampleCount).toBe(0);
    expect(buffer.getSummary().lastUpdated).toBeNull();
  });

  it("AC-02: performs zero disk I/O when telemetryEnabled = false and creates session JSONL lazily on first valid event across all 7 categories", async () => {
    const baseDir = await makeTempDir();
    const disabledLogDir = path.join(baseDir, "disabled-telemetry");
    const clock = new FakeClock(Date.UTC(2026, 10, 27, 9, 30, 15));
    const disabledSettings = await createSettingsRepo(false);
    const fakeStore = new FakeJsonlStore(clock);

    const disabledTelemetry = new TelemetryStore({
      clock,
      settings: disabledSettings,
      jsonlStore: fakeStore,
      logDir: disabledLogDir,
    });
    await disabledTelemetry.initialize();
    const writtenDisabled = await disabledTelemetry.appendBatch([
      { category: "network", event: "ws_reconnect", data: { attempt: 1 } },
    ]);
    expect(writtenDisabled).toBe(0);
    expect(fakeStore.ensureDirCalls).toBe(0);
    expect(fakeStore.appendCalls).toBe(0);

    const enabledLogDir = path.join(baseDir, "enabled-telemetry");
    const enabledSettings = await createSettingsRepo(true);
    const store = new TelemetryStore({
      clock,
      settings: enabledSettings,
      jsonlStore: new NodeJsonlStore(),
      logDir: enabledLogDir,
    });
    await store.initialize();
    expect(store.getCurrentSessionId()).toMatch(/^session-20261127-093015-[0-9a-f]{8}$/);

    // Directory must not exist before a valid event arrives.
    await expect(fs.access(enabledLogDir)).rejects.toThrow();

    // Invalid events must not create the file either.
    expect(isValidTelemetryEvent(["not-an-object"])).toBe(false);
    expect(isValidTelemetryEvent({ category: "unknown", event: "x" })).toBe(false);
    expect(isValidTelemetryEvent({ category: "network", event: "" })).toBe(false);
    const invalidOnly = await store.appendBatch([
      { category: "invalid" as unknown as TelemetryEventInput["category"], event: "bad" },
    ]);
    expect(invalidOnly).toBe(0);
    await expect(fs.access(enabledLogDir)).rejects.toThrow();

    const circularData: Record<string, unknown> = {
      detail: "ok",
      err: new Error("decode boom"),
    };
    circularData.self = circularData;

    const validEvents: TelemetryEventInput[] = TELEMETRY_CATEGORIES.map((category, idx) => ({
      category,
      event: `event_${category}`,
      timestamp: clock.nowMs() + idx,
      data: category === "log" ? circularData : { idx },
    }));

    const written = await store.appendBatch(validEvents);
    expect(written).toBe(TELEMETRY_CATEGORIES.length);

    const content = await store.readSessionNdjson(store.getCurrentSessionId());
    expect(content).not.toBeNull();
    const lines = (content ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(TELEMETRY_CATEGORIES.length);
    expect(lines.map((entry) => entry.category)).toEqual([...TELEMETRY_CATEGORIES]);
    expect(lines[0]?.sessionId).toBe(store.getCurrentSessionId());
    expect(lines[0]?.serverTimestamp).toBe("2026-11-27T09:30:15.000Z");

    const logEntry = lines.find((entry) => entry.category === "log");
    const logData = logEntry?.data as Record<string, unknown> | undefined;
    expect(logData?.self).toBe("[Circular]");
    expect((logData?.err as Record<string, unknown>)?.message).toBe("decode boom");
  });

  it("AC-03: enforces 10 MiB per-session file cap (restored across restart) and rotates oldest session beyond 15 files", async () => {
    expect(TELEMETRY_LIMITS.maxSessionFileBytes).toBe(10 * 1024 * 1024);
    expect(TELEMETRY_LIMITS.maxSessions).toBe(15);

    const baseDir = await makeTempDir();
    const capDir = path.join(baseDir, "cap");
    const clock = new FakeClock(Date.UTC(2026, 10, 27, 10, 0, 0));
    const settings = await createSettingsRepo(true);
    const jsonlStore = new NodeJsonlStore();

    const fixedSessionId = "session-20261127-100000-00000001";
    const cappedStore = new TelemetryStore({
      clock,
      settings,
      jsonlStore,
      logDir: capDir,
      sessionId: fixedSessionId,
      maxSessionFileBytes: 400,
    });

    const firstWrite = await cappedStore.appendBatch([
      { category: "pacer", event: "tick", data: { pad: "x".repeat(120) } },
      { category: "pacer", event: "tick", data: { pad: "y".repeat(120) } },
      { category: "pacer", event: "tick", data: { pad: "z".repeat(120) } },
    ]);
    expect(firstWrite).toBeGreaterThanOrEqual(1);
    expect(firstWrite).toBeLessThan(3);

    // Subsequent write must be rejected once cap is hit.
    expect(await cappedStore.appendBatch([{ category: "pacer", event: "after_cap" }])).toBe(0);

    // Simulate process restart with the same sessionId and logDir: cap state must be restored from disk.
    const restartedStore = new TelemetryStore({
      clock,
      settings,
      jsonlStore,
      logDir: capDir,
      sessionId: fixedSessionId,
      maxSessionFileBytes: 400,
    });
    expect(await restartedStore.appendBatch([{ category: "pacer", event: "after_restart" }])).toBe(
      0,
    );
    const sessionsAfterCap = await restartedStore.listSessions();
    expect(sessionsAfterCap).toHaveLength(1);
    expect(sessionsAfterCap[0]?.lineCount).toBe(firstWrite);

    // Rotation: creating 16 sessions keeps 15 and evicts the oldest updated session.
    const rotDir = path.join(baseDir, "rotation");
    for (let i = 1; i <= 16; i += 1) {
      const sid = `session-20261127-1000${String(i).padStart(2, "0")}-${String(i).padStart(8, "0")}`;
      const sStore = new TelemetryStore({
        clock,
        settings,
        jsonlStore,
        logDir: rotDir,
        sessionId: sid,
      });
      await sStore.appendBatch([{ category: "av_sync", event: `s_${i}` }]);
      const filePath = path.join(rotDir, `${sid}.jsonl`);
      const mtimeSec = 1_700_000_000 + i * 10;
      await fs.utimes(filePath, mtimeSec, mtimeSec);
    }

    const verifier = new TelemetryStore({
      clock,
      settings,
      jsonlStore,
      logDir: rotDir,
    });
    const remaining = await verifier.listSessions();
    expect(remaining).toHaveLength(TELEMETRY_LIMITS.maxSessions);
    expect(remaining.some((s) => s.sessionId === "session-20261127-100001-00000001")).toBe(false);
    expect(remaining.some((s) => s.sessionId === "session-20261127-100016-00000016")).toBe(true);

    // Serialized write/delete queue prevents ENOENT races during concurrent delete + append.
    const raceStore = new TelemetryStore({
      clock,
      settings,
      jsonlStore,
      logDir: path.join(baseDir, "race"),
    });
    const [w1, , w2] = await Promise.all([
      raceStore.appendBatch([{ category: "audio", event: "before_delete" }]),
      raceStore.deleteAllSessions(),
      raceStore.appendBatch([{ category: "audio", event: "after_delete" }]),
    ]);
    expect(w1).toBe(1);
    expect(w2).toBe(1);
    const latestAfterRace = await raceStore.readLatestSessionNdjson();
    expect(latestAfterRace?.content).toContain("after_delete");
    expect(latestAfterRace?.content).not.toContain("before_delete");
  });

  it("AC-04: sanitizes sessionId against path traversal and caps batches at 500 events", async () => {
    expect(sanitizeTelemetrySessionId("session-20261127-090000-deadbeef")).toBe(
      "session-20261127-090000-deadbeef",
    );
    expect(sanitizeTelemetrySessionId("../etc/passwd")).toBeNull();
    expect(sanitizeTelemetrySessionId("foo/bar")).toBeNull();
    expect(sanitizeTelemetrySessionId("foo\\bar")).toBeNull();
    expect(sanitizeTelemetrySessionId("..")).toBeNull();
    expect(sanitizeTelemetrySessionId(".")).toBeNull();
    expect(sanitizeTelemetrySessionId("")).toBeNull();
    expect(sanitizeTelemetrySessionId("session id")).toBeNull();

    const baseDir = await makeTempDir();
    const clock = new FakeClock(Date.UTC(2026, 10, 27, 11, 0, 0));
    const settings = await createSettingsRepo(true);
    const store = new TelemetryStore({
      clock,
      settings,
      jsonlStore: new NodeJsonlStore(),
      logDir: path.join(baseDir, "batch-cap"),
    });

    const batch: TelemetryEventInput[] = Array.from({ length: 650 }, (_, idx) => ({
      category: "decoder",
      event: `ev_${idx}`,
    }));
    const written = await store.appendBatch(batch);
    expect(written).toBe(TELEMETRY_LIMITS.maxBatchEvents);

    const sessions = await store.listSessions();
    expect(sessions[0]?.lineCount).toBe(500);
    expect(await store.readSessionNdjson("../batch-cap")).toBeNull();

    // Spec 09 §2.4 ENV boundaries: preserve nvenc and never force LIBVA_DRIVER_NAME default.
    const defaultEnv = parseServerEnv({});
    expect(defaultEnv.encoderMode).toBe("auto");
    expect(defaultEnv.libvaDriverName).toBeNull();
    expect(defaultEnv.vaapiDevice).toBeNull();
    expect(defaultEnv.telemetryLogDir).toBe("/data/telemetry");

    const nvencEnv = parseServerEnv({
      PORT: "9090",
      DATA_DIR: "/custom-data",
      ENCODER_MODE: "nvenc",
      LIBVA_DRIVER_NAME: "auto",
      VAAPI_DEVICE: "/dev/dri/renderD129",
    });
    expect(nvencEnv.port).toBe(9090);
    expect(nvencEnv.encoderMode).toBe("nvenc");
    expect(nvencEnv.libvaDriverName).toBeNull();
    expect(nvencEnv.vaapiDevice).toBe("/dev/dri/renderD129");
    expect(nvencEnv.telemetryLogDir).toBe("/custom-data/telemetry");
  });
});
