import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelemetryCollector } from '../src/core/telemetry.js';
import { FramePacer } from '../src/core/frame-pacer.js';
import { CanvasRenderer } from '../src/core/canvas-renderer.js';
import { AvSyncController } from '../src/core/av-sync.js';

describe('TelemetryCollector (Client)', () => {
  let collector: TelemetryCollector;
  const mockStorage: Record<string, string> = {};

  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => mockStorage[key] ?? null,
      setItem: (key: string, val: string) => { mockStorage[key] = val; },
      removeItem: (key: string) => { delete mockStorage[key]; },
      clear: () => { Object.keys(mockStorage).forEach((k) => delete mockStorage[k]); },
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

  it('should clear queue and stop recording when disabled', () => {
    collector.setEnabled(true);
    collector.recordDecoder('test_event', { data: 123 });

    collector.setEnabled(false);
    expect(collector.isEnabled()).toBe(false);

    const onFlush = vi.fn();
    collector.onFlush = onFlush;
    collector.recordDecoder('after_disable', { data: 456 });
    collector.flush();

    expect(onFlush).not.toHaveBeenCalled();
  });

  it('should integrate seamlessly with FramePacer when enabled', () => {
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
    collector.flush();

    pacer.destroy();
    vi.useRealTimers();

    // Check that an av_sync or buffering event was captured by telemetry
    const shiftEvent = recordedEvents.find((e) => e.type === 'av_sync' && e.event === 'large_shift');
    expect(shiftEvent).toBeDefined();
    expect(shiftEvent.data.syncErrorMs).toBeGreaterThan(150);
  });
});
