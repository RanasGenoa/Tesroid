import {
  CHANNEL_ID,
  decodeMetricsFrame,
  decodeTelemetryFrame,
  FRAME_SIZE,
  METRICS_LIMITS,
  PROTOCOL_TIMING,
  TELEMETRY_CATEGORIES,
  TELEMETRY_LIMITS,
  type WsCloseCode,
} from "@tesroid/shared";
import { describe, expect, it } from "vitest";
import {
  ClientMetricsCollector,
  ClientTelemetryReporter,
  computePercentile,
  createRttTrackerState,
  readEffectiveRttMs,
  recordRttMeasurement,
  sanitizeTelemetryValue,
  type TelemetryConsoleTarget,
} from "../src/observability/index.js";
import type {
  ClientClock,
  ClientTimerHandle,
  WsClientHandlers,
  WsConnectionStatus,
  WsTransportPort,
} from "../src/transport/ports.js";

class FakeClock implements ClientClock {
  private currentMs: number;
  private nextId = 1;
  private readonly timers = new Set<{
    readonly id: number;
    readonly fireAtMs: number;
    readonly callback: () => void;
    cancelled: boolean;
  }>();

  constructor(initialMs = 1_700_000_000_000) {
    this.currentMs = initialMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  setTimeout(callback: () => void, delayMs: number): ClientTimerHandle {
    const entry = {
      id: this.nextId++,
      fireAtMs: this.currentMs + Math.max(0, delayMs),
      callback,
      cancelled: false,
    };
    this.timers.add(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
        this.timers.delete(entry);
      },
    };
  }

  clearTimeout(handle: ClientTimerHandle): void {
    handle.cancel();
  }

  advanceBy(ms: number): void {
    const targetMs = this.currentMs + ms;
    while (true) {
      let nextTimer: {
        readonly id: number;
        readonly fireAtMs: number;
        readonly callback: () => void;
        cancelled: boolean;
      } | null = null;
      for (const timer of this.timers) {
        if (!timer.cancelled && timer.fireAtMs <= targetMs) {
          if (
            nextTimer === null ||
            timer.fireAtMs < nextTimer.fireAtMs ||
            (timer.fireAtMs === nextTimer.fireAtMs && timer.id < nextTimer.id)
          ) {
            nextTimer = timer;
          }
        }
      }
      if (nextTimer === null) {
        break;
      }
      this.timers.delete(nextTimer);
      this.currentMs = Math.max(this.currentMs, nextTimer.fireAtMs);
      nextTimer.callback();
    }
    this.currentMs = targetMs;
  }
}

class FakeWsTransport implements WsTransportPort {
  readonly sentFrames: Uint8Array[] = [];
  connected = true;

  connect(_url: string, _handlers: WsClientHandlers): void {}

  sendBinary(data: Uint8Array): boolean {
    if (!this.connected) {
      return false;
    }
    this.sentFrames.push(new Uint8Array(data));
    return true;
  }

  disconnect(_code?: WsCloseCode, _reason?: string): void {
    this.connected = false;
  }

  getStatus(): WsConnectionStatus {
    return this.connected ? "CONNECTED" : "DISCONNECTED";
  }
}

describe("client/observability (Spec 03, 08)", () => {
  it("Spec 08 AC-01: computes 10-second delta metrics (FPS, p50/p95 frame time, dropped frames, decoder errors, signed avDriftMs) and emits exclusively over WS 0x14", () => {
    expect(computePercentile([10, 2, 8, 4, 6], 50)).toBe(6);
    expect(computePercentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 95)).toBe(100);
    expect(computePercentile([], 95)).toBe(0);

    const clock = new FakeClock(10_000);
    const transport = new FakeWsTransport();
    const collector = new ClientMetricsCollector({ transport, clock });

    collector.setViewportMetrics(773, 553, 1.5);
    collector.setDecodeQueueSize(3);
    collector.setAvDriftMs(6_250.5);
    collector.recordRttSample(40, true);
    collector.start();

    // Window 1: spread frames across seconds within 10s window, plus drops, errors, packets.
    for (let sec = 0; sec < 10; sec += 1) {
      const framesInSec = sec === 0 ? 2 : 6;
      for (let i = 0; i < framesInSec; i += 1) {
        collector.recordFrameRendered(sec === 9 && i === framesInSec - 1 ? 25 : 4);
      }
      collector.recordVideoPacket(25_000);
      collector.recordAudioPacket();
      clock.advanceBy(1_000);
    }

    // Add 3 dropped frames and 2 decoder errors before the 10-second tick fired?
    // Advancing 10 * 1_000 already triggered the 10_000ms timer at t=20_000.
    // Let's verify window 1 and then record drops/errors in window 2 to test both delta isolation & unclipped negative drift.
    expect(transport.sentFrames).toHaveLength(1);
    const frame1 = transport.sentFrames[0];
    expect(frame1?.[0]).toBe(CHANNEL_ID.METRICS);
    if (frame1 === undefined) {
      throw new Error("Expected frame 1");
    }
    const sample1 = decodeMetricsFrame(frame1);
    expect(sample1.windowMs).toBe(METRICS_LIMITS.windowMs);
    expect(sample1.totalRenderedFrames).toBe(56);
    expect(sample1.fps).toBeCloseTo(5.6, 5);
    expect(sample1.minFps).toBe(2);
    expect(sample1.maxFps).toBe(6);
    expect(sample1.videoPackets).toBe(10);
    expect(sample1.videoBytes).toBe(250_000);
    expect(sample1.audioPackets).toBe(10);
    expect(sample1.bitrateKbps).toBeCloseTo(200, 5);
    expect(sample1.frameTimeP50Ms).toBe(4);
    expect(sample1.frameTimeP95Ms).toBe(4);
    expect(sample1.decodeQueueSize).toBe(3);
    expect(sample1.avDriftMs).toBe(6_250.5);
    expect(sample1.displayWidth).toBe(773);
    expect(sample1.displayHeight).toBe(553);
    expect(sample1.dpr).toBe(1.5);

    // Window 2: verify delta counters reset while totalRenderedFrames accumulates and signed negative >5s drift is preserved.
    collector.recordFrameRendered(12);
    collector.recordDroppedFrames(4);
    collector.recordDecoderError();
    collector.setAvDriftMs(-7_125.25);
    clock.advanceBy(METRICS_LIMITS.windowMs);

    expect(transport.sentFrames).toHaveLength(2);
    const frame2 = transport.sentFrames[1];
    expect(frame2?.[0]).toBe(CHANNEL_ID.METRICS);
    if (frame2 === undefined) {
      throw new Error("Expected frame 2");
    }
    const sample2 = decodeMetricsFrame(frame2);
    expect(sample2.droppedFrames).toBe(4);
    expect(sample2.decoderErrors).toBe(1);
    expect(sample2.totalRenderedFrames).toBe(57);
    expect(sample2.videoPackets).toBe(0);
    expect(sample2.videoBytes).toBe(0);
    expect(sample2.audioPackets).toBe(0);
    expect(sample2.avDriftMs).toBe(-7_125.25);
    expect(sample2.rttMs).toBe(0); // > 5,000 ms since last RTT sample

    collector.stop();
  });

  it("Spec 08 AC-02: performs zero collection or console hooks when telemetryEnabled = false, batches over WS 0x15 every 1,000 ms (500 limit) when enabled, throttles sync logs (500 ms), and survives circular objects", () => {
    // Pure circular/error/bigint sanitizer check.
    const circular: Record<string, unknown> = { label: "root", count: 42n };
    circular.self = circular;
    const err = new Error("boom");
    const sanitized = sanitizeTelemetryValue({ circular, err }) as Record<string, unknown>;
    expect(() => JSON.stringify(sanitized)).not.toThrow();
    expect((sanitized.circular as Record<string, unknown>).self).toBe("[Circular]");
    expect((sanitized.circular as Record<string, unknown>).count).toBe("42");
    expect((sanitized.err as Record<string, unknown>).message).toBe("boom");

    const clock = new FakeClock(1_000);
    const transport = new FakeWsTransport();
    const originalWarnLogs: unknown[][] = [];
    const originalErrorLogs: unknown[][] = [];
    const warnFn = (...args: unknown[]) => {
      originalWarnLogs.push(args);
    };
    const errorFn = (...args: unknown[]) => {
      originalErrorLogs.push(args);
    };
    const consoleTarget: TelemetryConsoleTarget = { warn: warnFn, error: errorFn };

    const reporter = new ClientTelemetryReporter({ transport, clock, consoleTarget });
    expect(reporter.isEnabled()).toBe(false);

    // Disabled state: zero collection, zero console hooks, zero WS traffic.
    reporter.record("network", "should_ignore", { ok: true });
    reporter.recordThrottledSync("sync_ignored", { driftMs: 10 });
    consoleTarget.warn("warn_while_off");
    reporter.flush();
    clock.advanceBy(TELEMETRY_LIMITS.flushIntervalMs * 2);
    expect(consoleTarget.warn).toBe(warnFn);
    expect(consoleTarget.error).toBe(errorFn);
    expect(transport.sentFrames).toHaveLength(0);
    expect(originalWarnLogs).toHaveLength(1);

    // Enable telemetry: console hooks active, all categories including network/log accepted, 500 cap enforced.
    reporter.setEnabled(true);
    expect(reporter.isEnabled()).toBe(true);
    expect(consoleTarget.warn).not.toBe(warnFn);
    expect(consoleTarget.error).not.toBe(errorFn);

    for (const category of TELEMETRY_CATEGORIES) {
      reporter.record(category, `evt_${category}`, { category });
    }
    consoleTarget.error("bad_state", circular);
    expect(originalErrorLogs).toHaveLength(1);

    // Sync throttling: 500 ms window suppresses rapid duplicates and records suppressedCount on next emit.
    reporter.recordThrottledSync("drift_adjust", { driftMs: 120 });
    clock.advanceBy(200);
    reporter.recordThrottledSync("drift_adjust", { driftMs: 130 });
    clock.advanceBy(200);
    reporter.recordThrottledSync("drift_adjust", { driftMs: 140 });
    clock.advanceBy(150);
    reporter.recordThrottledSync("drift_adjust", { driftMs: 150 });

    clock.advanceBy(TELEMETRY_LIMITS.flushIntervalMs);
    expect(transport.sentFrames).toHaveLength(1);
    const batchFrame = transport.sentFrames[0];
    expect(batchFrame?.[0]).toBe(CHANNEL_ID.TELEMETRY);
    if (batchFrame === undefined) {
      throw new Error("Expected telemetry batch frame");
    }
    const decoded = decodeTelemetryFrame(batchFrame);
    expect(decoded.events.some((e) => e.category === "network" && e.event === "evt_network")).toBe(
      true,
    );
    expect(decoded.events.some((e) => e.category === "log" && e.event === "console_error")).toBe(
      true,
    );
    const syncEvents = decoded.events.filter((e) => e.event === "drift_adjust");
    expect(syncEvents).toHaveLength(2);
    expect(syncEvents[1]?.data?.suppressedCount).toBe(2);

    // Queue cap 500: pushing 550 events keeps the latest 500.
    for (let i = 0; i < 550; i += 1) {
      reporter.record("pacer", `p_${i}`);
    }
    clock.advanceBy(TELEMETRY_LIMITS.flushIntervalMs);
    const cappedFrame = transport.sentFrames[1];
    if (cappedFrame === undefined) {
      throw new Error("Expected capped frame");
    }
    const cappedBatch = decodeTelemetryFrame(cappedFrame);
    expect(cappedBatch.events).toHaveLength(TELEMETRY_LIMITS.maxBatchEvents);
    expect(cappedBatch.events[0]?.event).toBe("p_50");
    expect(cappedBatch.events[499]?.event).toBe("p_549");

    // Large payload (> 512 KiB) splits automatically so each frame stays <= 512 KiB.
    const bigChunk = "x".repeat(4_000);
    for (let i = 0; i < 200; i += 1) {
      reporter.record("decoder", `big_${i}`, { payload: bigChunk });
    }
    clock.advanceBy(TELEMETRY_LIMITS.flushIntervalMs);
    const splitFrames = transport.sentFrames.slice(2);
    expect(splitFrames.length).toBeGreaterThan(1);
    for (const frame of splitFrames) {
      expect(frame.byteLength).toBeLessThanOrEqual(FRAME_SIZE.MAX_TELEMETRY_BYTES);
    }

    // Disabling restores console hooks, flushes telemetry_disabled, and stops further buffering.
    const countBeforeDisable = transport.sentFrames.length;
    reporter.setEnabled(false);
    expect(reporter.isEnabled()).toBe(false);
    expect(consoleTarget.warn).toBe(warnFn);
    expect(consoleTarget.error).toBe(errorFn);
    expect(transport.sentFrames).toHaveLength(countBeforeDisable + 1);
    const finalFrame = transport.sentFrames[countBeforeDisable];
    if (finalFrame === undefined) {
      throw new Error("Expected telemetry_disabled frame");
    }
    expect(decodeTelemetryFrame(finalFrame).events).toEqual([
      expect.objectContaining({ category: "log", event: "telemetry_disabled" }),
    ]);

    reporter.record("network", "after_disable");
    clock.advanceBy(TELEMETRY_LIMITS.flushIntervalMs * 2);
    expect(transport.sentFrames).toHaveLength(countBeforeDisable + 1);
    reporter.dispose();
  });

  it("Spec 03 AC-05: RTT is updated only during LIVE zero-queue samples, the effective value is the minimum of the 8-sample history window (spike-excluded), and stale RTT (> 5,000 ms) resets to connecting state", () => {
    // Pure RTT state verification.
    let state = createRttTrackerState();
    expect(readEffectiveRttMs(state, 1_000)).toBe(0);

    // Non-LIVE or queued sample does not update RTT.
    state = recordRttMeasurement(state, 50, false, 1_000);
    expect(readEffectiveRttMs(state, 1_000)).toBe(0);

    // First valid LIVE zero-queue sample initializes both the EWMA and the min window.
    state = recordRttMeasurement(state, 100, true, 1_000);
    expect(readEffectiveRttMs(state, 1_000)).toBe(100);

    // Second valid sample: EWMA updates (0.7*100 + 0.3*200 = 130) but the effective value stays at the window minimum.
    state = recordRttMeasurement(state, 200, true, 2_000);
    expect(state.ewmaRttMs).toBeCloseTo(130, 5);
    expect(readEffectiveRttMs(state, 2_000)).toBe(100);

    // Congestion spike never raises the effective baseline while a cleaner sample remains in the window.
    state = recordRttMeasurement(state, 500, true, 3_000);
    expect(readEffectiveRttMs(state, 3_000)).toBe(100);

    // The window holds at most 8 samples; once older clean samples slide out, the baseline rises.
    for (let i = 0; i < 8; i += 1) {
      state = recordRttMeasurement(state, 200, true, 4_000 + i * 100);
    }
    expect(state.minHistory.length).toBe(8);
    expect(readEffectiveRttMs(state, 5_000)).toBe(200);

    // At exactly 5,000 ms elapsed, still valid; > 5,000 ms resets to 0.
    expect(readEffectiveRttMs(state, 9_000)).toBe(200);
    expect(readEffectiveRttMs(state, 10_001)).toBe(0);

    // Collector integration check.
    const clock = new FakeClock(10_000);
    const transport = new FakeWsTransport();
    const collector = new ClientMetricsCollector({ transport, clock });

    collector.recordRttSample(80, false);
    expect(collector.getEffectiveRttMs()).toBe(0);

    collector.recordRttSample(80, true);
    expect(collector.getEffectiveRttMs()).toBe(80);

    clock.advanceBy(1_000);
    collector.recordRttSample(120, true);
    expect(collector.getEffectiveRttMs()).toBe(80);

    clock.advanceBy(PROTOCOL_TIMING.rttStaleTimeoutMs + 1);
    expect(collector.getEffectiveRttMs()).toBe(0);
  });
});
