import { describe, expect, it, vi } from 'vitest';
import { AudioPlayer } from '../src/core/audio-player.js';

// Issue #103 (2026-11-25 モバイル回線インシデント): JUMP_TO_LIVE 直後に経路を漂流して到着する
// 古い音声（straggler）がゼロギャップスケジューリングでライブ音声の後ろに連結され、
// A/V 固定オフセット (~2秒) が通信回復でも元に戻らない不具合の回帰テスト。
describe('Issue #103: post-LIVE-jump straggler audio barrier', () => {
  const makePlayer = (): AudioPlayer => {
    const avSync: any = {
      setAudioContextTimeProvider: vi.fn(),
      updateAudioPts: vi.fn(),
      clearAudioAnchor: vi.fn(),
      isVideoBuffering: () => false,
    };
    return new AudioPlayer(avSync);
  };

  const isStale = (player: AudioPlayer, ptsUs: number): boolean =>
    (player as any).isStaleByLiveBarrier(ptsUs);

  it('ストリーム再構築（resetJitterBuffer）では旧ストリームの PTS 基準も破棄される', () => {
    const player = makePlayer();
    (player as any).lastChunkPtsUs = 50_000_000; // 旧ストリームの音声受信済み状態
    expect(player.getLastKnownPtsUs()).toBe(50_000_000);

    player.resetJitterBuffer();
    expect(player.getLastKnownPtsUs()).toBe(0); // 再構築直後の外挿フォールバックに旧値は混入しない
  });

  it('バリア未満の音声は破棄し、バリア以上のライブ音声最初の1フレームでガードを解く', () => {
    const player = makePlayer();
    player.setLiveEdgeBarrier(10_000_000);

    // ジャンプ前に送信済みだった straggler（バリアより古い）は破棄
    expect(isStale(player, 9_999_999)).toBe(true);
    expect(isStale(player, 5_000_000)).toBe(true);

    // ライブ音声（バリア以上）が届いた時点で役割終了 → 以後は古い PTS でも通す
    expect(isStale(player, 10_500_000)).toBe(false);
    expect(isStale(player, 9_000_000)).toBe(false);
  });

  it('TTL 自動失効: 外挿誤差や PTS 再基準化（ストリーム再構築）で音声が永久に失われない', () => {
    vi.useFakeTimers();
    try {
      const player = makePlayer();
      player.setLiveEdgeBarrier(10_000_000, 5000);
      vi.advanceTimersByTime(6000);
      expect(isStale(player, 1_000)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('setLiveEdgeBarrier(0以下) は無効、clearLiveEdgeBarrier で即解除（ストリームリセット経路）', () => {
    const player = makePlayer();
    player.setLiveEdgeBarrier(0);
    expect(isStale(player, 1)).toBe(false);

    player.setLiveEdgeBarrier(8_000_000);
    expect(isStale(player, 7_000_000)).toBe(true);
    player.clearLiveEdgeBarrier();
    expect(isStale(player, 7_000_000)).toBe(false);
  });

  it('TTL 下限 1000ms: straggler の到着遅延より短い TTL で早期解除しない', () => {
    vi.useFakeTimers();
    try {
      const player = makePlayer();
      player.setLiveEdgeBarrier(10_000_000, 10); // 下限へクランプされる
      vi.advanceTimersByTime(900);
      expect(isStale(player, 9_000_000)).toBe(true); // 900ms ではまだ有効
      vi.advanceTimersByTime(200);
      expect(isStale(player, 9_000_000)).toBe(false); // 1100ms > TTL 1000ms で失効
    } finally {
      vi.useRealTimers();
    }
  });

  it('TCP FIFO で LIVE_JUMPED 前に滑り込んだ古い straggler キュー/スケジュールは setLiveEdgeBarrier 時に即パージされる', () => {
    const player = makePlayer();
    const stopSpy = vi.fn();
    (player as any).scheduledSources.add({ stop: stopSpy, disconnect: vi.fn() });
    (player as any).lastScheduledPtsUs = 8_000_000;
    (player as any).bufferQueue.push({ buffer: { duration: 0.02 } as any, ptsUs: 8_020_000 });
    (player as any).isPlaying = true;

    // ライブエッジ 10_000_000us を設定 → 8s の straggler が既に滑り込んでいるためパージされる
    player.setLiveEdgeBarrier(10_000_000);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect((player as any).bufferQueue.length).toBe(0);
    expect((player as any).isPlaying).toBe(false);

    // すでにバリア以上の健全なライブ音声のみ再生中の場合はパージしない
    const liveStopSpy = vi.fn();
    (player as any).scheduledSources.add({ stop: liveStopSpy, disconnect: vi.fn() });
    (player as any).lastScheduledPtsUs = 10_500_000;
    (player as any).isPlaying = true;
    player.setLiveEdgeBarrier(10_000_000);
    expect(liveStopSpy).not.toHaveBeenCalled();
  });

  it('非同期 AudioDecoder.output で遅れて出てきた pre-jump straggler も playAudioData で破棄される', () => {
    const player = makePlayer();
    (player as any).ctx = { state: 'running', currentTime: 1.0, createBuffer: vi.fn() };
    player.setLiveEdgeBarrier(10_000_000);

    // 新しいライブ音声が decodeAndPlayChunk を通過して liveBarrierPtsUs が解除された状態を模擬
    expect(isStale(player, 10_040_000)).toBe(false);
    expect((player as any).liveBarrierPtsUs).toBe(0);

    // しかし AudioDecoder 内に残っていた古い pre-jump straggler (9_900_000) が output で到着
    const staleClose = vi.fn();
    (player as any).playAudioData({
      numberOfChannels: 2,
      numberOfFrames: 960,
      sampleRate: 48000,
      timestamp: 9_900_000,
      close: staleClose,
    });
    expect(staleClose).toHaveBeenCalledTimes(1);
    expect((player as any).ctx.createBuffer).not.toHaveBeenCalled();
  });
});
