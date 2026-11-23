// Issue #11: クライアント負荷プロファイル関連のクライアント側追加挙動
// - D5: 1フレーム描画処理時間の p50/p95 計測 (MetricsCollector + FramePacer)
// - Issue #90 拡張: エンコーダー状態のエンコード出力寸法表示
import { describe, expect, it, vi } from 'vitest';

// MetricsCollector は window.setInterval / window.innerWidth を使用するため最小限のスタブを置く
(globalThis as unknown as { window: unknown }).window = {
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  innerWidth: 1024,
  innerHeight: 600,
  devicePixelRatio: 1,
};

import { FramePacer } from '../src/core/frame-pacer.js';
import { MetricsCollector } from '../src/core/metrics.js';
import { describeEncoderStatus } from '../src/views/encoder-policy.js';

describe('Frame render timing metrics (Issue #11 D5)', () => {
  it('FramePacer は描画のたびに onFrameRenderTimed で所要時間を報告する', () => {
    const renderer = { render: vi.fn(), resize: vi.fn() };
    const pacer = new FramePacer(renderer as never, 30);
    const durations: number[] = [];
    pacer.onFrameRenderTimed = (d) => durations.push(d);

    pacer.setMode('ACTIVE_INTERACTION');
    pacer.queueFrame({ close: vi.fn(), timestamp: 1000 } as never);

    expect(renderer.render).toHaveBeenCalled();
    expect(durations.length).toBe(1);
    expect(durations[0]).toBeGreaterThanOrEqual(0);
    pacer.destroy();
  });

  it('MetricsCollector は 10 秒ウィンドウの p50/p95 を報告する', () => {
    vi.useFakeTimers();
    try {
      const collector = new MetricsCollector();
      const reports: Array<{ frameProcessP50Ms?: number; frameProcessP95Ms?: number }> = [];
      collector.onReport = (m) => reports.push(m);

      for (let i = 1; i <= 100; i++) {
        collector.recordFrameProcessed(i);
      }
      vi.advanceTimersByTime(10_000);

      expect(reports.length).toBe(1);
      // 1..100 の中央値 index=floor(0.5*100)=50 → 値 51、p95 index=95 → 値 96
      expect(reports[0].frameProcessP50Ms).toBe(51);
      expect(reports[0].frameProcessP95Ms).toBe(96);

      collector.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('サンプルが無いウィンドウの p50/p95 は 0', () => {
    vi.useFakeTimers();
    try {
      const collector = new MetricsCollector();
      const reports: Array<{ frameProcessP50Ms?: number; frameProcessP95Ms?: number }> = [];
      collector.onReport = (m) => reports.push(m);
      vi.advanceTimersByTime(10_000);
      expect(reports[0].frameProcessP50Ms).toBe(0);
      expect(reports[0].frameProcessP95Ms).toBe(0);
      collector.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Encoder status encode dimensions display (Issue #11)', () => {
  it('レイアウトとエンコード寸法が異なる場合は縮小を明示する', () => {
    const text = describeEncoderStatus({
      running: true,
      backend: 'vaapi',
      encoderMode: 'auto',
      libvaDriverName: 'iHD',
      lastFallback: null,
      captureWidth: 1280,
      captureHeight: 768,
      encodeWidth: 832,
      encodeHeight: 512,
    });
    expect(text).toContain('VAAPI ハードウェア');
    expect(text).toContain('映像出力 832x512 (レイアウト 1280x768 から縮小)');
  });

  it('寸法が同一なら縮小表記なしで出力解像度のみ', () => {
    const text = describeEncoderStatus({
      running: true,
      backend: 'vaapi',
      encoderMode: 'auto',
      captureWidth: 1280,
      captureHeight: 768,
      encodeWidth: 1280,
      encodeHeight: 768,
    });
    expect(text).toContain('映像出力 1280x768');
    expect(text).not.toContain('から縮小');
  });

  it('寸法情報なしの従来ペイロードでも動作する', () => {
    const text = describeEncoderStatus({
      running: true,
      backend: 'software',
      encoderMode: 'auto',
      x264Preset: 'veryfast',
    });
    expect(text).toContain('CPU ソフトウェア (libx264 / -preset veryfast)');
    expect(text).not.toContain('映像出力');
  });
});
