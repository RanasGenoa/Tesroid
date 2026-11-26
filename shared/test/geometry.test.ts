import {
  alignEncodeDimensions,
  alignLayoutDimensions,
  calculateAutoSleepDelayMs,
  calculateBufferHoldThresholds,
  calculateCatchupFlowProfile,
  calculateLiveWatermarks,
  calculateServerRemainingBufferMs,
  computeContainRect,
  mapTouchToStreamCoordinates,
} from "@tesroid/shared";
import { describe, expect, it } from "vitest";

describe("shared/geometry (Spec 03, 05, 06, 10)", () => {
  it("Spec 03 §2.1 & Spec 05 AC-02: aligns layout width to 8px (>=640), height to 2px ([360, min(1080, maxSize)]), and clamps DPR to [1.25, 1.5] when width < 1000", () => {
    const smallWindow = alignLayoutDimensions({
      width: 773,
      height: 553,
      dpr: 1.53,
      maxSize: 1_280,
    });
    expect(smallWindow).toEqual({ width: 1_160, height: 830 });
    expect(smallWindow.width % 8).toBe(0);
    expect(smallWindow.height % 2).toBe(0);

    // Different DPR (e.g. 1.2x) clamps to 1.25x instead of assuming hardcoded 1.53
    const lowDprWindow = alignLayoutDimensions({
      width: 773,
      height: 553,
      dpr: 1.1,
      maxSize: 1_280,
    });
    expect(lowDprWindow).toEqual({ width: 960, height: 690 });

    // Unspecified DPR when width < 1000 uses fallback 1.35x
    const fallbackDprWindow = alignLayoutDimensions({
      width: 800,
      height: 600,
    });
    expect(fallbackDprWindow).toEqual({ width: 1_080, height: 810 });

    // Floor & ceiling bounds
    expect(alignLayoutDimensions({ width: 400, height: 200, maxSize: 1_280 })).toEqual({
      width: 640,
      height: 360,
    });
    expect(alignLayoutDimensions({ width: 1_920, height: 1_200, maxSize: 1_920 })).toEqual({
      width: 1_920,
      height: 1_080,
    });
    expect(alignLayoutDimensions({ width: 1_920, height: 1_080, maxSize: 960 })).toEqual({
      width: 960,
      height: 540,
    });
  });

  it("Spec 05 AC-03: scales layout 966x752 with 0.65x lightweight profile to 624x488 across all encoder backends", () => {
    const scaled = alignEncodeDimensions({ width: 966, height: 752 }, 0.65);
    expect(scaled).toEqual({ width: 624, height: 488 });
    expect(scaled.width % 8).toBe(0);
    expect(scaled.height % 2).toBe(0);

    // scale >= 1.0 keeps original layout dimensions without scaling
    expect(alignEncodeDimensions({ width: 966, height: 752 }, 1.0)).toEqual({
      width: 966,
      height: 752,
    });

    // Clamps below minScale (0.4) and respects minimum 320x240 bounds
    expect(alignEncodeDimensions({ width: 640, height: 360 }, 0.1)).toEqual({
      width: 320,
      height: 240,
    });
  });

  it("Spec 06 AC-02: computes object-fit: contain rect and maps client touch coordinates while excluding letterbox/pillarbox margins and top 20px guard", () => {
    // Letterbox: 16:9 stream in 800x600 viewport -> drawWidth=800, drawHeight=450, offsetY=75
    const letterbox = computeContainRect(800, 600, 1280, 720);
    expect(letterbox).toEqual({ offsetX: 0, offsetY: 75, drawWidth: 800, drawHeight: 450 });

    // Top 20px guard ignores touch at or above y=20
    expect(mapTouchToStreamCoordinates(400, 20, 800, 600, 1280, 720)).toBeNull();
    expect(mapTouchToStreamCoordinates(400, 5, 800, 600, 1280, 720)).toBeNull();

    // Touch inside active image maps accurately
    const insideCenter = mapTouchToStreamCoordinates(400, 300, 800, 600, 1280, 720);
    expect(insideCenter).toEqual({ x: 640, y: 360, inside: true });

    // Touch in bottom letterbox margin reports inside: false and clamps y to streamHeight
    const bottomMargin = mapTouchToStreamCoordinates(400, 560, 800, 600, 1280, 720);
    expect(bottomMargin).toEqual({ x: 640, y: 720, inside: false });

    // Pillarbox: 4:3 stream in 1000x500 viewport -> drawHeight=500, drawWidth=666.666..., offsetX=166.666...
    const pillar = computeContainRect(1000, 500, 800, 600);
    expect(pillar.offsetY).toBe(0);
    expect(pillar.drawHeight).toBe(500);
    expect(pillar.drawWidth).toBeCloseTo(666.6667, 3);
    expect(mapTouchToStreamCoordinates(50, 250, 1000, 500, 800, 600)).toEqual({
      x: 0,
      y: 300,
      inside: false,
    });
  });

  it("Spec 06 §4.1: safely ignores touch mapping when viewport or stream dimensions are <= 0", () => {
    expect(computeContainRect(0, 600, 1280, 720)).toEqual({
      offsetX: 0,
      offsetY: 0,
      drawWidth: 0,
      drawHeight: 0,
    });
    expect(mapTouchToStreamCoordinates(100, 100, 0, 600, 1280, 720)).toBeNull();
    expect(mapTouchToStreamCoordinates(100, 100, 800, -1, 1280, 720)).toBeNull();
    expect(mapTouchToStreamCoordinates(100, 100, 800, 600, 0, 720)).toBeNull();
    expect(mapTouchToStreamCoordinates(100, 100, 800, 600, 1280, 0)).toBeNull();
  });

  it("Spec 03 AC-02: calculates bitrate-linked LIVE highWaterBytes [512 KiB, 1536 KiB] and lowWaterBytes max(96 KiB, 20% of high)", () => {
    // 250 kbps -> (250000/8)*3 = 93750 -> clamped to 512 KiB; 20% = 104858 (> 96 KiB)
    expect(calculateLiveWatermarks(250_000)).toEqual({
      highWaterBytes: 512 * 1024,
      lowWaterBytes: Math.round(512 * 1024 * 0.2),
    });

    // 2 Mbps -> (2000000/8)*3 = 750000 bytes; 20% = 150000 bytes
    expect(calculateLiveWatermarks(2_000_000)).toEqual({
      highWaterBytes: 750_000,
      lowWaterBytes: 150_000,
    });

    // 10 Mbps -> clamped to 1536 KiB
    expect(calculateLiveWatermarks(10_000_000)).toEqual({
      highWaterBytes: 1_536 * 1024,
      lowWaterBytes: Math.round(1_536 * 1024 * 0.2),
    });
  });

  it("Spec 03 AC-03: adapts CATCHUP window, socket guard (32-64 KiB vs 128 KiB), and burst interval (10ms vs 2ms) when drainRate < 0.85x or stalls >= 3", () => {
    expect(calculateCatchupFlowProfile(10_000, 1.0, 0)).toEqual({
      congested: false,
      effectiveWindowMs: 10_000,
      socketGuardBytes: 128 * 1024,
      burstIntervalMs: 2,
    });

    // Target 0 ms guarantees minimum 400 ms window
    expect(calculateCatchupFlowProfile(0, 1.0, 0)).toEqual({
      congested: false,
      effectiveWindowMs: 400,
      socketGuardBytes: 128 * 1024,
      burstIntervalMs: 2,
    });

    // Congested by drainRate < 0.85
    const lowRate = calculateCatchupFlowProfile(10_000, 0.5, 0);
    expect(lowRate.congested).toBe(true);
    expect(lowRate.effectiveWindowMs).toBe(5_000);
    expect(lowRate.socketGuardBytes).toBeGreaterThanOrEqual(32 * 1024);
    expect(lowRate.socketGuardBytes).toBeLessThanOrEqual(64 * 1024);
    expect(lowRate.burstIntervalMs).toBe(10);

    // Congested by consecutiveStalls >= 3
    const stalled = calculateCatchupFlowProfile(10_000, 1.0, 3);
    expect(stalled.congested).toBe(true);
    expect(stalled.effectiveWindowMs).toBe(10_000);
    expect(stalled.socketGuardBytes).toBe(32 * 1024);
    expect(stalled.burstIntervalMs).toBe(10);
  });

  it("Spec 03 AC-03: calculates Buffer-Hold trigger [10s, 30s] and resume thresholds preserving >= 7,200 ms hysteresis span for HW (2s) and SW (3s) encoders", () => {
    expect(calculateBufferHoldThresholds(0, true)).toEqual({
      enabled: false,
      triggerMs: 0,
      resumeMs: 0,
      bufferUsageTriggerRatio: 0.85,
    });

    const hwLow = calculateBufferHoldThresholds(2_000, true);
    expect(hwLow).toEqual({
      enabled: true,
      triggerMs: 10_000,
      resumeMs: 2_000,
      bufferUsageTriggerRatio: 0.85,
    });
    expect(hwLow.triggerMs - hwLow.resumeMs).toBeGreaterThanOrEqual(7_200);

    // Software encoder at 10s trigger clamps resumeMs to 2,800 ms so span >= 7,200 ms
    const swLow = calculateBufferHoldThresholds(10_000, false);
    expect(swLow.triggerMs).toBe(10_000);
    expect(swLow.resumeMs).toBe(2_800);
    expect(swLow.triggerMs - swLow.resumeMs).toBe(7_200);

    // Software encoder at 20s trigger allows full 3,000 ms headroom
    const swMid = calculateBufferHoldThresholds(20_000, false);
    expect(swMid.triggerMs).toBe(20_000);
    expect(swMid.resumeMs).toBe(3_000);

    // Upper clamp 30s
    expect(calculateBufferHoldThresholds(60_000, true).triggerMs).toBe(30_000);
  });

  it("Spec 03 AC-05: computes serverRemainingBufferMs accounting for max(clientVideoBufferedMs, clientAudioBufferedMs)", () => {
    expect(calculateServerRemainingBufferMs(2_000, 400, 900)).toBe(1_100);
    expect(calculateServerRemainingBufferMs(2_000, 1_200, 500)).toBe(800);
    expect(calculateServerRemainingBufferMs(500, 300, 800)).toBe(0);
  });

  it("Spec 10 AC-02/04: computes auto-sleep delay with 15,000 ms floor, holdTriggerMs + 5,000 ms margin, and null when autoSleepMinutes = 0", () => {
    expect(calculateAutoSleepDelayMs(0, 10_000)).toBeNull();
    expect(calculateAutoSleepDelayMs(-1, null)).toBeNull();
    expect(calculateAutoSleepDelayMs(0.1, null)).toBe(15_000);
    expect(calculateAutoSleepDelayMs(3, 10_000)).toBe(180_000);
    expect(calculateAutoSleepDelayMs(0.25, 30_000)).toBe(35_000);
  });
});
