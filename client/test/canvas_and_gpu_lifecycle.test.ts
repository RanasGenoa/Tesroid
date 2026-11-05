import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvSyncController } from '../src/core/av-sync.js';
import { CanvasRenderer } from '../src/core/canvas-renderer.js';
import { FramePacer } from '../src/core/frame-pacer.js';

function createMockCanvas(contextNull: boolean = false) {
  const ctx = contextNull
    ? null
    : {
        drawImage: vi.fn(),
        fillRect: vi.fn(),
        fillStyle: '',
      };

  const canvas: any = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ctx),
  };

  return { canvas, ctx };
}

function createTrackedFrame(
  timestampUs: number = 0,
  displayWidth: number = 1280,
  displayHeight: number = 720,
) {
  let closeCount = 0;
  const frame: any = {
    timestamp: timestampUs,
    displayWidth,
    displayHeight,
    close: vi.fn(() => {
      closeCount++;
    }),
    getCloseCount: () => closeCount,
  };
  return frame;
}

describe('CanvasRenderer & Tesla GPU VideoFrame Lifecycle Guarantees', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('requests a 2d context with { alpha: false, desynchronized: true } and throws if unavailable', () => {
    const { canvas: brokenCanvas } = createMockCanvas(true);
    expect(() => new CanvasRenderer(brokenCanvas)).toThrow(/CanvasRenderingContext2D/);

    const { canvas, ctx } = createMockCanvas(false);
    const renderer = new CanvasRenderer(canvas);
    expect(canvas.getContext).toHaveBeenCalledWith('2d', {
      alpha: false,
      desynchronized: true,
    });

    // Clear paints black background
    renderer.resize(1280, 720);
    renderer.clear();
    expect(ctx!.fillStyle).toBe('#000000');
    expect(ctx!.fillRect).toHaveBeenCalledWith(0, 0, 1280, 720);
  });

  it('auto-resizes canvas to VideoFrame dimensions, fires onFirstFrameRendered once, closes every frame, and zeroes FPS on idle', () => {
    let fakeNow = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => fakeNow);

    const { canvas, ctx } = createMockCanvas(false);
    const renderer = new CanvasRenderer(canvas);
    const firstFrameSpy = vi.fn();
    renderer.onFirstFrameRendered = firstFrameSpy;

    // Render 30 frames over 1000ms -> ~30 FPS, first frame callback fired once
    for (let i = 0; i < 30; i++) {
      fakeNow += 34;
      const frame = createTrackedFrame(i * 33_333, 1920, 1080);
      renderer.render(frame);
      expect(frame.getCloseCount()).toBe(1);
    }

    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
    expect(ctx!.drawImage).toHaveBeenCalledTimes(30);
    expect(firstFrameSpy).toHaveBeenCalledTimes(1);
    expect(renderer.getFps()).toBeGreaterThanOrEqual(28);

    // Idle > 1500ms -> getFps() drops to 0
    fakeNow += 1600;
    expect(renderer.getFps()).toBe(0);

    // resetFirstFrame re-arms first-frame callback
    renderer.resetFirstFrame();
    const f2 = createTrackedFrame(1_000_000, 1920, 1080);
    renderer.render(f2);
    expect(firstFrameSpy).toHaveBeenCalledTimes(2);
    expect(f2.getCloseCount()).toBe(1);
  });

  it('closes 100% of VideoFrames across FramePacer maxQueueSize drops, jumpToLive(), and reset() (0 GPU leaks)', () => {
    vi.useFakeTimers();
    const { canvas } = createMockCanvas(false);
    const renderer = new CanvasRenderer(canvas);
    const avSync = new AvSyncController();
    const droppedSpy = vi.fn();

    const pacer = new FramePacer(renderer, 30, avSync, { maxQueueSize: 5 });
    pacer.onFrameDropped = droppedSpy;

    const allFrames: Array<ReturnType<typeof createTrackedFrame>> = [];

    // 1. Burst 10 frames simultaneously: 1 renders immediately, 9 enter queue -> 4 overflow frames dropped & closed!
    for (let i = 0; i < 10; i++) {
      const f = createTrackedFrame(i * 33_333);
      allFrames.push(f);
      pacer.queueFrame(f);
    }
    expect(droppedSpy).toHaveBeenCalledTimes(4);

    // 2. jumpToLive() flushes remaining 5 queued frames (4 closed immediately, 5th rendered & closed by CanvasRenderer)
    pacer.jumpToLive();
    for (const f of allFrames) {
      expect(f.getCloseCount()).toBe(1);
    }

    // 3. Enqueue 4 more frames and call reset() -> all queued frames closed immediately
    const resetBatch: Array<ReturnType<typeof createTrackedFrame>> = [];
    for (let i = 0; i < 4; i++) {
      const f = createTrackedFrame((20 + i) * 33_333);
      resetBatch.push(f);
      pacer.queueFrame(f);
    }
    pacer.reset();
    for (const f of resetBatch) {
      expect(f.getCloseCount()).toBe(1);
    }

    pacer.destroy();
  });
});
