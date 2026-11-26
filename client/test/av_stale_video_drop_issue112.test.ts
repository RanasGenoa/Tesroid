import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvSyncController } from '../src/core/av-sync';
import { FramePacer } from '../src/core/frame-pacer';

/**
 * Issue #112 F-5: HOLD サイクル経過後の残留音ズレ (音声先行・映像遅れ) に対する映像側吸収。
 * A/V PLL の負方向シフトは 1x 間隔クランプ (maxNegativeShiftAllowed ≤ 0) で構造的に止まるため、
 * backlog (キュー滞留 > 8 フレーム) かつ 150ms 超の音声先行時に、再生中音声より 40ms 以上古い
 * 映像フレームを 1 tick あたり最大 4 フレームまで破棄して吸収する。
 */

function createDummyFrame(timestampUs: number) {
  return { timestamp: timestampUs, close: vi.fn() };
}

describe('FramePacer stale video drop for audio-ahead (Issue #112 F-5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const buildPacer = (audioPtsUs: number | null) => {
    const rendered: any[] = [];
    const mockRenderer: any = {
      render: vi.fn((f: any) => {
        rendered.push(f);
        f.close?.();
      }),
    };
    const avSync = new AvSyncController();
    avSync.setAudioContextTimeProvider(() => 10.0);
    if (audioPtsUs !== null) {
      avSync.updateAudioPts(audioPtsUs, 10.0);
    }
    const pacer = new FramePacer(mockRenderer, 30, avSync);
    return { pacer, rendered, mockRenderer };
  };

  it('absorbs a genuine backlog (queue>8, audio-ahead>150ms) with bounded stale drops', () => {
    // 音声は 1.5s を再生中。映像 PTS 1.0〜1.333s = 167〜500ms の音声先行 (2s 安全弁より小さい)
    const frames: any[] = [];
    const { pacer, rendered } = buildPacer(1_500_000);

    const f0 = createDummyFrame(1_000_000);
    pacer.queueFrame(f0 as any); // 初回は即時レンダリング
    expect(pacer.getQueueLength()).toBe(0);

    for (let i = 1; i <= 10; i++) {
      const f = createDummyFrame(1_000_000 + i * 33_333);
      frames.push(f);
      pacer.queueFrame(f as any);
    }
    expect(pacer.getQueueLength()).toBe(10);

    // 1 tick: f1 を描画後、gate (q>8) が許す範囲で stale 破棄。上限 4/tick にboundされ全消えしない
    vi.advanceTimersByTime(36);
    expect(rendered.length).toBe(2); // f0 + f1
    const after1 = pacer.getQueueLength();
    expect(after1).toBeGreaterThanOrEqual(5); // 破棄は ≤4/tick
    expect(after1).toBeLessThanOrEqual(8); // gate により q<=8 までしか破棄しない

    // 破棄されたフレームは描画されず close される (VideoFrame リークなし)
    const renderedPts = rendered.map((f: any) => f.timestamp);
    const dropped = frames.filter(
      (f) => !renderedPts.includes(f.timestamp) && f.close.mock.calls.length > 0,
    );
    expect(dropped.length).toBeGreaterThan(0);
    // 未处理でキューに残るフレームは close されていない
    const stillQueued = pacer.getQueueLength();
    const untouched = frames.filter(
      (f) => !renderedPts.includes(f.timestamp) && f.close.mock.calls.length === 0,
    );
    expect(untouched.length).toBe(stillQueued);

    pacer.destroy();
  });

  it('does not drop when queue depth is below the backlog gate, even if frames lag audio', () => {
    // q=6 (gate の 8 未満): 音声 1.5s / 映像 1.43s 台。破棄せず 1x 再生のみ = PLL 領域のまま
    const { pacer } = buildPacer(1_500_000);
    pacer.queueFrame(createDummyFrame(1_400_000) as any);
    for (let i = 1; i <= 6; i++) {
      pacer.queueFrame(createDummyFrame(1_400_000 + i * 33_333) as any);
    }
    const q0 = pacer.getQueueLength();
    expect(q0).toBe(6);

    vi.advanceTimersByTime(36); // 1 tick: 描画1のみ、stale 破棄は起きない
    expect(pacer.getQueueLength()).toBe(q0 - 1);

    pacer.destroy();
  });

  it('never starves the display while a large backlog is absorbed', () => {
    // 音声 2.6s / 映像 1.0〜1.367s (1.23〜1.6s の先行、安全弁 2s 未満)。上限付き破棄で吸収しつつ、
    // PTS ギャップを維持しながら再生が継続し (毎フレームは描画され) 表示が完全に止まらないこと。
    const { pacer, rendered } = buildPacer(2_600_000);
    pacer.queueFrame(createDummyFrame(1_000_000) as any);
    for (let i = 1; i <= 12; i++) {
      pacer.queueFrame(createDummyFrame(1_000_000 + i * 33_333) as any);
    }
    vi.advanceTimersByTime(432); // ~13 frame intervals
    expect(rendered.length).toBeGreaterThanOrEqual(5); // f0 + f1 + 1x 再生継続
    expect(pacer.getQueueLength()).toBeLessThan(12); // 純粋な 1x より速く消化 (破棄が吸収に寄与)

    pacer.destroy();
  });
});
