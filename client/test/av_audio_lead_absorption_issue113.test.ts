import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvSyncController } from '../src/core/av-sync';
import { FramePacer } from '../src/core/frame-pacer';

/**
 * Issue #113: DIRECT LIVE→LIVE 復帰後の音声先行 (~300ms) 残留に対する映像側吸収の受け入れ基準。
 *
 * 音声は常に有効なマスタークロック (1x 再生継続、av-sync の 1.5s 外挿上限を通るよう
 * 仮想時間 1s 以内に再アンカー) としてモデル化する。
 * 期待する結果: 配信停滞→復帰後も、映像側の有界フレーム破棄とスケジュール前倒しで
 * |再生中音声PTS − 最終描画PTS| ≤ 60ms に収束し、過補正で再拡大しない。
 */

const FRAME_INTERVAL_MS = 33;
// 受け入れ基準: デッドバンド 45ms + 余裕 15ms。実装の破棄停止目標 (next-head 基準 20ms + 1フレーム込みで ~53ms@30fps) より緩い
const MAX_ACCEPTABLE_LEAD_MS = 60;

function createDummyFrame(timestampUs: number) {
  return { timestamp: timestampUs, close: vi.fn() } as any;
}

describe('audio-lead absorption on video side (Issue #113)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const nowMs = () => Number((performance as any).now());

  const setup = (audioDepthUs: number) => {
    const avSync = new AvSyncController();
    avSync.setAudioContextTimeProvider(() => nowMs() / 1000);
    // 音声は常に 1x で再生継続 (深さ audioDepthUs 一定)。tick 毎の再アンカーで master clock を常に有効に保つ
    const reAnchor = () => {
      const t = nowMs();
      avSync.updateAudioPts(t * 1000 - audioDepthUs, t / 1000);
    };
    reAnchor();
    const renderedPts: number[] = [];
    const mockRenderer: any = {
      render: vi.fn((f: any) => {
        renderedPts.push(f.timestamp);
        f.close?.();
      }),
    };
    const pacer = new FramePacer(mockRenderer, 30, avSync);
    const avSyncEvents: { kind: string; data: any }[] = [];
    const telemetry: any = {
      isEnabled: () => true,
      recordAvSync: vi.fn((kind: string, data: any) => avSyncEvents.push({ kind, data })),
      recordPacer: vi.fn(),
      recordBuffering: vi.fn(),
    };
    pacer.setTelemetryCollector(telemetry);
    const leadMs = () => {
      const playing = avSync.getCurrentPlayingAudioPtsUs() ?? 0;
      return Math.round((playing - pacer.getLastRenderedPtsUs()) / 1000);
    };
    // tick 進める毎に音声再アンカーし、frameCb があればその tick で映像フレーム配送
    const advance = (ms: number, frameCb?: (wallNowUs: number) => void) => {
      let remaining = ms;
      while (remaining > 0) {
        const step = Math.min(FRAME_INTERVAL_MS, remaining);
        vi.advanceTimersByTime(step);
        remaining -= step;
        reAnchor();
        frameCb?.(nowMs() * 1000);
      }
    };
    return { pacer, advance, leadMs, renderedPts, avSyncEvents };
  };

  it('converges audio lead to deadband within 4s after delivery-stall recovery', () => {
    const AUDIO_DEPTH_US = 400_000; // 音声は最大 0.5s 先までスケジュール済み (audio-player MAX_SCHEDULE_AHEAD 相当)
    const { pacer, advance, leadMs, avSyncEvents } = setup(AUDIO_DEPTH_US);

    // 1) 定常 2s: PTS=実時間で 1x 配送
    advance(2000, (w) => pacer.queueFrame(createDummyFrame(w)));

    // 2) サーバー生成継続中、配信のみ 700ms 停滞 (音声はスケジュール済み分を再生継続)
    let gen = nowMs() * 1000;
    const backlog: number[] = [];
    for (let i = 0; i < 21; i++) {
      gen += 33_333;
      backlog.push(gen);
    }
    advance(700);

    // 3) バースト到着 (network stall 検知 -> autoCushion >= 180)。以後 1x 配送が連続
    for (const pts of backlog) {
      pacer.queueFrame(createDummyFrame(pts));
    }
    advance(4000, () => {
      gen += 33_333;
      pacer.queueFrame(createDummyFrame(gen));
    });

    // 受け入れ: 復帰 4s 以内に |音声先行| ≤ 60ms へ収束
    expect(Math.abs(leadMs())).toBeLessThanOrEqual(MAX_ACCEPTABLE_LEAD_MS);
    // 吸収機構 (stale 映像破棄) が実際に働いた痕跡
    expect(avSyncEvents.some((e) => e.kind === 'stale_video_drop')).toBe(true);
  });

  it('holds convergence for 8s after the initial absorption without over-correction', () => {
    const AUDIO_DEPTH_US = 400_000;
    const { pacer, advance, leadMs } = setup(AUDIO_DEPTH_US);

    advance(2000, (w) => pacer.queueFrame(createDummyFrame(w)));
    let gen = nowMs() * 1000;
    const backlog: number[] = [];
    for (let i = 0; i < 21; i++) {
      gen += 33_333;
      backlog.push(gen);
    }
    advance(700);
    for (const pts of backlog) {
      pacer.queueFrame(createDummyFrame(pts));
    }
    const feed = () => {
      gen += 33_333;
      pacer.queueFrame(createDummyFrame(gen));
    };
    advance(4000, feed);
    const leadAtConvergence = leadMs();

    // 収束後さらに 8s 観測: 過補正で逆方向 (映像先行) にも +60ms 超へ拡大しない
    advance(8000, feed);
    const leadAfter8s = leadMs();
    expect(Math.abs(leadAfter8s)).toBeLessThanOrEqual(MAX_ACCEPTABLE_LEAD_MS);
    // 収束した値が壊れていないこと
    expect(Math.abs(leadAtConvergence)).toBeLessThanOrEqual(MAX_ACCEPTABLE_LEAD_MS);
  });

  it('never drops video during normal 1x arrival with audio behind (no interference)', () => {
    const AUDIO_DEPTH_US = 300_000; // 音声は到着より 300ms 遅れて再生中 (正常な遅延側)
    const { pacer, advance, avSyncEvents, renderedPts } = setup(AUDIO_DEPTH_US);

    advance(6000, (w) => pacer.queueFrame(createDummyFrame(w)));

    // 正常な 1x 到着では stale 映像破棄が 1 件も発生しない
    expect(avSyncEvents.filter((e) => e.kind === 'stale_video_drop')).toHaveLength(0);
    // 描画 PTS が連続している (フレーム落ち=PTSギャップなし)。初回は即時描画、以降は 1x ペース
    let prevPts = -1;
    for (const pts of renderedPts) {
      if (prevPts >= 0) {
        expect(pts - prevPts).toBeLessThanOrEqual(FRAME_INTERVAL_MS * 2 * 1000);
      }
      prevPts = pts;
    }
    expect(renderedPts.length).toBeGreaterThan(50);
  });

  it('reports current audio lead (leadMs) in stale_video_drop telemetry for field verification', () => {
    const AUDIO_DEPTH_US = 400_000;
    const { pacer, advance, avSyncEvents } = setup(AUDIO_DEPTH_US);

    advance(2000, (w) => pacer.queueFrame(createDummyFrame(w)));
    let gen = nowMs() * 1000;
    const backlog: number[] = [];
    for (let i = 0; i < 21; i++) {
      gen += 33_333;
      backlog.push(gen);
    }
    advance(700);
    for (const pts of backlog) {
      pacer.queueFrame(createDummyFrame(pts));
    }
    advance(2000, () => {
      gen += 33_333;
      pacer.queueFrame(createDummyFrame(gen));
    });

    const drops = avSyncEvents.filter((e) => e.kind === 'stale_video_drop');
    expect(drops.length).toBeGreaterThan(0);
    // 実機テレメトリで収束を追跡できるよう、その時点の音声先行量 leadMs を必ず含む
    for (const d of drops) {
      expect(Number.isFinite(d.data.leadMs)).toBe(true);
      expect(d.data.leadMs).toBeGreaterThan(0);
    }
  });
});
