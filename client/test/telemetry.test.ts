import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvSyncController } from '../src/core/av-sync.js';
import { CanvasRenderer } from '../src/core/canvas-renderer.js';
import { FramePacer } from '../src/core/frame-pacer.js';
import { TelemetryCollector } from '../src/core/telemetry.js';

describe('TelemetryCollector (Client)', () => {
  let collector: TelemetryCollector;
  const mockStorage: Record<string, string> = {};

  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => mockStorage[key] ?? null,
      setItem: (key: string, val: string) => {
        mockStorage[key] = val;
      },
      removeItem: (key: string) => {
        delete mockStorage[key];
      },
      clear: () => {
        Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
      },
    });
    mockStorage['tesroid_detailed_telemetry'] = 'false';
    collector = new TelemetryCollector();
  });

  afterEach(() => {
    collector.destroy();
    vi.unstubAllGlobals();
  });

  it('should be disabled by default (zero overhead)', () => {
    expect(collector.isEnabled()).toBe(false);

    const onFlush = vi.fn();
    collector.onFlush = onFlush;

    collector.recordAvSync('test_sync', { diff: 100 });
    collector.recordBuffering('test_buf', { queue: 5 });
    collector.recordDecoder('test_dec', { count: 1 });
    collector.flush();

    expect(onFlush).not.toHaveBeenCalled();
  });

  it('should record events and flush when enabled', () => {
    collector.setEnabled(true);
    expect(collector.isEnabled()).toBe(true);

    const flushedBatches: any[] = [];
    collector.onFlush = (events) => {
      flushedBatches.push(events);
    };

    collector.recordAvSync('large_shift', { syncErrorMs: 200, shift: 200 });
    collector.recordBuffering('enter', { autoCushionMs: 180 });
    collector.flush();

    expect(flushedBatches.length).toBe(1);
    const events = flushedBatches[0];
    // 'telemetry_enabled' + 'large_shift' + 'enter'
    expect(events.some((e: any) => e.type === 'av_sync' && e.event === 'large_shift')).toBe(true);
    expect(events.some((e: any) => e.type === 'buffering' && e.event === 'enter')).toBe(true);
  });

  it('should flush telemetry_disabled event before stopping when disabled', () => {
    const flushedBatches: any[][] = [];
    collector.onFlush = (events) => {
      flushedBatches.push(events);
    };

    collector.setEnabled(true);
    collector.recordDecoder('test_event', { data: 123 });

    collector.setEnabled(false);
    expect(collector.isEnabled()).toBe(false);

    const allEvents = flushedBatches.flat();
    expect(allEvents.some((e) => e.type === 'log' && e.event === 'telemetry_enabled')).toBe(true);
    expect(allEvents.some((e) => e.type === 'decoder' && e.event === 'test_event')).toBe(true);
    expect(allEvents.some((e) => e.type === 'log' && e.event === 'telemetry_disabled')).toBe(true);

    const countAfterDisable = flushedBatches.length;
    collector.recordDecoder('after_disable', { data: 456 });
    collector.flush();

    expect(flushedBatches.length).toBe(countAfterDisable);
  });

  it('should safely capture Error and circular objects in console hooks without recursion', () => {
    const quietCollector = new TelemetryCollector({ maxQueueSize: 2 });
    const flushed: any[] = [];
    let throwOnce = true;
    quietCollector.onFlush = (batch) => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error('simulated flush failure');
      }
      flushed.push(...batch);
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    quietCollector.setEnabled(true);

    const circular: any = { label: 'node' };
    circular.self = circular;

    // Trigger console.warn with circular object & console.error with Error instance
    console.warn('Circular payload:', circular);
    console.error('Boom:', new Error('decoder crashed'));
    quietCollector.flush();

    quietCollector.setEnabled(false);
    quietCollector.destroy();
    warnSpy.mockRestore();
    errSpy.mockRestore();

    const errorLog = flushed.find((e) => e.type === 'log' && e.event === 'error');
    expect(errorLog).toBeDefined();
    expect(errorLog.data.message).toContain('decoder crashed');
  });

  it('should integrate with FramePacer and throttle high-frequency pll_nudge logs', () => {
    vi.useFakeTimers();
    collector.setEnabled(true);
    const recordedEvents: any[] = [];
    collector.onFlush = (batch) => {
      recordedEvents.push(...batch);
    };

    const mockCanvas = {
      getContext: () => ({
        drawImage: vi.fn(),
        clearRect: vi.fn(),
      }),
      width: 1280,
      height: 720,
    } as any;
    const renderer = new CanvasRenderer(mockCanvas);
    const avSync = new AvSyncController();
    const pacer = new FramePacer(renderer, 30, avSync);
    pacer.setTelemetryCollector(collector);

    // Set additional delay so frames are held in queue
    pacer.setAdditionalDelay(150);

    // Render 1 frame to establish timeline
    const mockFrame1 = { timestamp: 1_000_000, close: vi.fn() } as any;
    pacer.queueFrame(mockFrame1);
    vi.advanceTimersByTime(160);

    // Set audio to lag 2 seconds behind video (trigger large A/V Sync shift)
    avSync.setAudioContextTimeProvider(() => 10.0);
    avSync.updateAudioPts(5_000_000, 10.0); // 5s

    // Queue frame 2 & frame 3
    const mockFrame2 = { timestamp: 7_000_000, close: vi.fn() } as any;
    const mockFrame3 = { timestamp: 7_033_000, close: vi.fn() } as any;
    pacer.queueFrame(mockFrame2);
    pacer.queueFrame(mockFrame3);

    // Advance timer to process frame 2 and calculate PLL shift for remaining queued frame 3
    vi.advanceTimersByTime(200);

    // Now simulate minor drift (~40ms) across 10 rapid frames within 350ms to verify pll_nudge throttling
    let basePts = 7_100_000;
    for (let i = 0; i < 10; i++) {
      avSync.updateAudioPts(basePts - 40_000, 10.0); // ~40ms drift (within 15..150ms PLL range)
      pacer.queueFrame({ timestamp: basePts, close: vi.fn() } as any);
      basePts += 33_000;
      vi.advanceTimersByTime(33);
    }

    collector.flush();

    pacer.destroy();
    vi.useRealTimers();

    const shiftEvent = recordedEvents.find(
      (e) => e.type === 'av_sync' && e.event === 'large_shift',
    );
    expect(shiftEvent).toBeDefined();
    expect(shiftEvent.data.syncErrorMs).toBeGreaterThan(150);

    const nudgeEvents = recordedEvents.filter(
      (e) => e.type === 'av_sync' && e.event === 'pll_nudge',
    );
    expect(nudgeEvents.length).toBeLessThanOrEqual(2);
  });
});
