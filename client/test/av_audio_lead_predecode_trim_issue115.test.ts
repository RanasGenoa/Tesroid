import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvSyncController } from '../src/core/av-sync';
import { VideoStreamDecoder } from '../src/core/decoder.js';
import { FramePacer } from '../src/core/frame-pacer';
import { VIDEO_FLAGS } from '../src/transport/protocol.js';

/**
 * Issue #115: 音声先行 ~2s の滞留平衡 (デコーダ手前 pendingPackets ~300枚) に対する
 * A/V ズレ駆動の GOP 境界トリムの受け入れ基準。
 *
 * 実機実測 (2026-11-26 TrueNAS/車載): DirectLive→LIVE 切替後に decodeQueueSize=301、
 * drift −2000ms の平衡に落ちる。ペーサーの stale drop (4/tick) は自分のキュー (10-11枚)
 * にしか届かず、供給元 (デコーダ手前) が 2 秒前のコンテンツであり収束しない。
 * JUMP_TO_LIVE で一瞬復帰しても ~30s で再発する。
 *
 * 期待する結果:
 * 1. ペーサーは lead ≥ 800ms の検知点で、上流 (デコーダ手前) へ trim を 1s 間隔で要求する。
 * 2. デコーダは目標 PTS 直前のキーフレーム境界まで pre-decode キューを破棄し、
 *    残った GOP 境界から復号継続できる (破棄数は戻り値で観測可能)。
 */

const FRAME_INTERVAL_MS = 33;

function createDummyFrame(timestampUs: number) {
  return { timestamp: timestampUs, close: vi.fn() } as any;
}

describe('pre-decode GOP trim driven by A/V lead (Issue #115)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const nowMs = () => performance.now();

  it('pacer requests an upstream trim while audio lead >= 800ms, rate-limited to 1/s', () => {
    const avSync = new AvSyncController();
    avSync.setAudioContextTimeProvider(() => nowMs() / 1000);
    // 音声は 0.5s 先まで再生済み (audio-player MAX_SCHEDULE_AHEAD 相当の live 近傍)、
    // 映像フレームは実時間から 2.6s 後方 -> 実測 leadMs≈1980 と同条件の音声先行を作る
    const reAnchor = () => {
      const t = nowMs();
      avSync.updateAudioPts(t * 1000 - 500_000, t / 1000);
    };
    reAnchor();

    const mockRenderer: any = {
      render: vi.fn((f: any) => f.close?.()),
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

    const trimRequests: number[] = [];
    pacer.onSustainedAudioLead = (playingAudioPtsUs: number) => {
      trimRequests.push(playingAudioPtsUs);
    };

    // 実測平衡と同じ: ペーサーキューは 10-11 枚のみ (供給元はデコーダ手前)
    const base = nowMs() * 1000 - 2_600_000;
    for (let i = 0; i < 10; i++) {
      pacer.queueFrame(createDummyFrame(base + i * FRAME_INTERVAL_MS * 1000));
    }

    // 5 秒間 1x で供給し続ける (毎フレーム到着、音声は 1x 再生継続)
    for (let tick = 0; tick < 150; tick++) {
      vi.advanceTimersByTime(FRAME_INTERVAL_MS);
      reAnchor();
      pacer.queueFrame(createDummyFrame(base + (10 + tick) * FRAME_INTERVAL_MS * 1000));
      vi.advanceTimersByTime(0);
    }

    // 要求は最低 3 回 (5s 間・レート制限 1 回/秒)、かつ 6 回以下 (1 秒未満の間隔で連続発火しない)
    expect(trimRequests.length).toBeGreaterThanOrEqual(3);
    expect(trimRequests.length).toBeLessThanOrEqual(6);
    // 引数は要求時点の再生中音声 PTS (µs・有限・正)
    for (const pts of trimRequests) {
      expect(Number.isFinite(pts)).toBe(true);
      expect(pts).toBeGreaterThan(0);
    }
    // テレメトリに predecode_trim_request が要求回数分残っていること
    const trimEvents = avSyncEvents.filter((e) => e.kind === 'predecode_trim_request');
    expect(trimEvents.length).toBe(trimRequests.length);
  });

  it('does not request an upstream trim while audio lead stays below the 800ms threshold', () => {
    const avSync = new AvSyncController();
    avSync.setAudioContextTimeProvider(() => nowMs() / 1000);
    // 音声 0.5s 先再生、映像は実時間から 1.2s 後方 -> lead≈700ms (< 800ms 閾値)
    const reAnchor = () => {
      const t = nowMs();
      avSync.updateAudioPts(t * 1000 - 500_000, t / 1000);
    };
    reAnchor();
    const mockRenderer: any = { render: vi.fn((f: any) => f.close?.()) };
    const pacer = new FramePacer(mockRenderer, 30, avSync);
    const telemetry: any = {
      isEnabled: () => true,
      recordAvSync: vi.fn(),
      recordPacer: vi.fn(),
      recordBuffering: vi.fn(),
    };
    pacer.setTelemetryCollector(telemetry);
    const trimRequests: number[] = [];
    pacer.onSustainedAudioLead = (ptsUs: number) => {
      trimRequests.push(ptsUs);
    };

    const base = nowMs() * 1000 - 1_200_000;
    for (let i = 0; i < 10; i++) {
      pacer.queueFrame(createDummyFrame(base + i * FRAME_INTERVAL_MS * 1000));
    }
    for (let tick = 0; tick < 150; tick++) {
      vi.advanceTimersByTime(FRAME_INTERVAL_MS);
      reAnchor();
      pacer.queueFrame(createDummyFrame(base + (10 + tick) * FRAME_INTERVAL_MS * 1000));
    }
    // 閾値未満の音声先行では上流トリムを要求しない (Issue #113 の有界破棄領域のまま)
    expect(trimRequests.length).toBe(0);
  });

  it('decoder trims pre-decode packets up to the last keyframe before the target PTS', async () => {
    // decoder.test.ts と同一の WebCodecs モック構成
    const mockDecoderInstance: any = {
      configure: vi.fn(),
      decode: vi.fn(),
      reset: vi.fn(),
      close: vi.fn(),
      decodeQueueSize: 0,
      state: 'configured',
    };
    const mockConstructor: any = function (this: any, init: any) {
      mockDecoderInstance._init = init;
      return mockDecoderInstance;
    };
    mockConstructor.isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
    vi.stubGlobal('VideoDecoder', mockConstructor);
    vi.stubGlobal('EncodedVideoChunk', function (this: any, init: any) {
      return init;
    } as any);

    const decoder = new VideoStreamDecoder(vi.fn());
    // 下流 (ペーサー) 満杯を模擬 → 全パケットが pre-decode キューに滞留する実測状態と同じ
    (decoder as any).getDownstreamQueueLength = () => 999;

    // GOP=2.0s (サーバー ffmpeg 実設定) で 6 秒分のパケットを投入:
    // KF@0, P..KF@2s, P..KF@4s, P.. → target=3.5s なら KF@2s が目標直前のキーフレーム
    const idr = new Uint8Array([0, 0, 0, 1, 0x65, 0x01, 0x02, 0x03]);
    const pFrame = new Uint8Array([0, 0, 0, 1, 0x41, 0x01, 0x02, 0x03]);
    for (let i = 0; i < 180; i++) {
      // GOP=2.0s 相当: 60フレーム (=1980ms) 毎にキーフレーム (サーバー ffmpeg gop=2.0fps と同等)
      const isKey = i % 60 === 0;
      const ptsUs = BigInt(i * FRAME_INTERVAL_MS * 1000);
      await decoder.handlePacket(isKey ? VIDEO_FLAGS.KEYFRAME : 0, ptsUs, isKey ? idr : pFrame);
    }
    const queued = decoder.getPendingPacketsCount();
    expect(queued).toBeGreaterThan(100);

    // 目標 = 音声再生 PTS − 250ms クッション相当。KF@2.0s が保持され、それ以前が破棄されること
    // KF@1.98s (i=60) が目標 3.5s 直前のキーフレーム -> その前 60 パケットが完全な破棄対象
    const trimEvents: { event: string; data: any }[] = [];
    decoder.setTelemetryCollector({
      isEnabled: () => true,
      recordDecoder: (event: string, data: any) => trimEvents.push({ event, data }),
    } as any);
    const dropped = decoder.trimPendingBeforePts(3_500_000);
    expect(dropped).toBe(60);
    expect(trimEvents.length).toBe(1);
    expect(trimEvents[0].event).toBe('av_trim_gop');
    expect(trimEvents[0].data.droppedCount).toBe(60);
    const remaining = decoder.getPendingPacketsCount();
    expect(remaining).toBe(queued - dropped);

    // トリム後の先頭は期待するキーフレーム (i=60, PTS=1.98s) そのもの、pendingBytes は減少し非負
    const pp = (decoder as any).pendingPackets;
    expect(Number(pp[0].pts)).toBe(60 * FRAME_INTERVAL_MS * 1000);
    expect((pp[0].flags & VIDEO_FLAGS.KEYFRAME) !== 0).toBe(true);
    const bytesAfter = (decoder as any).pendingBytes;
    expect(bytesAfter).toBeGreaterThanOrEqual(0);
    expect(bytesAfter).toBeLessThan(queued * 8); // 元は 8byte x queued 件。減少していること

    // 冪等: 同じ目標での再 trim は追加破棄しない
    expect(decoder.trimPendingBeforePts(3_500_000)).toBe(0);
    // 目標より古い要求も無害 (no-op)
    expect(decoder.trimPendingBeforePts(1_000_000)).toBe(0);
  });

  it('clearPendingPackets + FORCE_VIDEO_IDR flow: no old deltas decoded until the new keyframe', async () => {
    // Issue #115 実機続報: 局所 trim は GOP 格子手前までしか切れない (平衡 1965ms・no-op 率98%)。
    // サーバーへ FORCE_VIDEO_IDR を要求する同時点で pre-decode を全破棄し、ライブエッジの
    // 新 IDR が届くまで旧コンテンツ (delta) をデコーダへ一切供給しない。
    const mockDecoderInstance: any = {
      configure: vi.fn(),
      decode: vi.fn(),
      reset: vi.fn(),
      close: vi.fn(),
      decodeQueueSize: 0,
      state: 'configured',
    };
    const mockConstructor: any = function (this: any, init: any) {
      mockDecoderInstance._init = init;
      return mockDecoderInstance;
    };
    mockConstructor.isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
    vi.stubGlobal('VideoDecoder', mockConstructor);
    vi.stubGlobal('EncodedVideoChunk', function (this: any, init: any) {
      return init;
    } as any);

    const decoder = new VideoStreamDecoder(vi.fn());
    // 下流に余裕がある状態 (実測平衡ではなく、ゲート自体の挙動を検証する)
    (decoder as any).getDownstreamQueueLength = () => 0;

    const decodeCalls = () => mockDecoderInstance.decode.mock.calls.length;
    // decoder.test.ts と同一の実 SPS/PPS フィクスチャ
    const kfData = new Uint8Array([
      0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 0, 1, 0x65,
      0x01, 0x02, 0x03,
    ]);
    const pFrame = new Uint8Array([0, 0, 0, 1, 0x41, 0x01, 0x02, 0x03]);

    await decoder.handlePacket(VIDEO_FLAGS.CONFIG | VIDEO_FLAGS.KEYFRAME, 0n, kfData);
    await decoder.handlePacket(0, BigInt(FRAME_INTERVAL_MS * 1000), pFrame);
    expect(decodeCalls()).toBe(2);

    // FORCE_VIDEO_IDR 要求と同時点で pre-decode 全破棄 (既存 clearPendingPackets を再利用)
    decoder.clearPendingPackets();
    expect(decoder.getPendingPacketsCount()).toBe(0);
    expect((decoder as any).waitingForKeyframe).toBe(true);

    // サーバー再起動の間に届く古い delta (経路上の straggler) はデコーダへ供給されない
    await decoder.handlePacket(0, BigInt(2 * FRAME_INTERVAL_MS * 1000), pFrame);
    await decoder.handlePacket(0, BigInt(3 * FRAME_INTERVAL_MS * 1000), pFrame);
    expect(decodeCalls()).toBe(2);

    // ライブエッジの新 IDR からデコードが再開される
    await decoder.handlePacket(VIDEO_FLAGS.KEYFRAME, BigInt(4 * FRAME_INTERVAL_MS * 1000), kfData);
    expect(decodeCalls()).toBe(3);
    expect((decoder as any).waitingForKeyframe).toBe(false);
  });
});
