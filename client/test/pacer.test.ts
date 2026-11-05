import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FramePacer } from '../src/core/frame-pacer.js';

describe('FramePacer Tests', () => {
  let mockRenderer: any;
  let pacer: FramePacer;

  beforeEach(() => {
    mockRenderer = {
      render: vi.fn(),
    };
    pacer = new FramePacer(mockRenderer, 60);
  });

  it('should initialize with target FPS 60 and calculate frame time', () => {
    expect(pacer.getTargetFps()).toBe(60);
    pacer.setTargetFps(30);
    expect(pacer.getTargetFps()).toBe(30);
  });

  it('should render immediately in ACTIVE_INTERACTION mode', () => {
    pacer.setMode('ACTIVE_INTERACTION');
    const mockFrame = { close: vi.fn(), timestamp: 1000 } as any;

    pacer.queueFrame(mockFrame);
    expect(mockRenderer.render).toHaveBeenCalledWith(mockFrame);
  });

  it('should clean up on destroy without errors', () => {
    expect(() => pacer.destroy()).not.toThrow();
  });

  it('should queue and delay frames when additionalDelay is set, and flush immediately on interaction', async () => {
    vi.useFakeTimers();
    pacer.setAdditionalDelay(100);
    expect(pacer.getAdditionalDelay()).toBe(100);

    const mockFrame = { close: vi.fn(), timestamp: 1000 } as any;
    pacer.queueFrame(mockFrame);

    // まだ描画されていない
    expect(mockRenderer.render).not.toHaveBeenCalled();

    // 100ms 進めると描画される
    vi.advanceTimersByTime(105);
    expect(mockRenderer.render).toHaveBeenCalledWith(mockFrame);

    // インタラクションモードに遷移すると即時フラッシュされる
    const mockFrame2 = { close: vi.fn(), timestamp: 2000 } as any;
    pacer.queueFrame(mockFrame2);
    expect(mockRenderer.render).toHaveBeenCalledTimes(1);

    pacer.setMode('ACTIVE_INTERACTION');
    expect(mockRenderer.render).toHaveBeenCalledWith(mockFrame2);
    expect(mockRenderer.render).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
