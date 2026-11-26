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

  it('Issue #112 F-4b: jumpToLive(true) はネットワークストールで形成された自適応クッションを保持し、既定の jumpToLive() はゼロにする', () => {
    vi.useFakeTimers();
    try {
      pacer.setTargetFps(30);

      // 1フレーム目: 正常到着 → 予約後、時刻進行で描画 (hasRenderedAny=true)
      const f1 = { close: vi.fn(), timestamp: 0 } as any;
      pacer.queueFrame(f1);
      vi.advanceTimersByTime(60);

      // 2フレーム目: PTS差33msに対し実時間500ms後に到着 → ネットワークストール検出で
      // autoCushionMs が minCushionMs (180ms) まで引き上げられる
      const f2 = { close: vi.fn(), timestamp: 33_000 } as any;
      pacer.queueFrame(f2);
      vi.advanceTimersByTime(500);
      const f3 = { close: vi.fn(), timestamp: 66_000 } as any;
      pacer.queueFrame(f3);
      expect(pacer.getAutoCushionMs()).toBeGreaterThanOrEqual(180);

      // サーバー起因の早送り (preserveCushion=true): キューは空になるがクッションは維持
      pacer.jumpToLive(true);
      expect(pacer.getBufferedDurationMs()).toBeLessThanOrEqual(0);
      expect(pacer.getAutoCushionMs()).toBeGreaterThanOrEqual(180);

      // ユーザー LIVE tap (既定): 従来どおりクッションもリセット
      pacer.jumpToLive();
      expect(pacer.getAutoCushionMs()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
