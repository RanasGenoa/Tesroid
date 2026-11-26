import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayer } from '../src/core/audio-player.js';
import { AvSyncController } from '../src/core/av-sync.js';
import { FramePacer } from '../src/core/frame-pacer.js';
import { AUDIO_FLAGS } from '../src/transport/protocol.js';

/**
 * Issue #112: STREAM_RESET 後の AudioDecoder PTS エポック残留と
 * FramePacer stale 破棄無限 WAIT ループの多層防御テスト。
 */
describe('AudioDecoder PTS epoch reset & FramePacer epoch guard (Issue #112)', () => {
  const originalWindow = (globalThis as any).window;

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setupAudioMocks() {
    const decoderInstances: any[] = [];
    const ctxTime = 10.0;

    class MockAudioContext {
      public state = 'running';
      public sampleRate = 48000;
      public destination = {};
      public get currentTime() {
        return ctxTime;
      }
      public resume = vi.fn(async () => {
        this.state = 'running';
      });
      public close = vi.fn(async () => {
        this.state = 'closed';
      });
      public createBuffer(channels: number, frames: number, rate: number) {
        const chArrays = Array.from({ length: channels }, () => new Float32Array(frames));
        return {
          numberOfChannels: channels,
          length: frames,
          sampleRate: rate,
          duration: frames / rate,
          getChannelData: (c: number) => chArrays[c],
        };
      }
      public createGain() {
        return {
          gain: { value: 1.0, setValueAtTime: vi.fn() },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
      }
      public createBufferSource() {
        return {
          buffer: null,
          playbackRate: { value: 1.0 },
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null,
        };
      }
    }

    class MockAudioDecoder {
      public state = 'unconfigured';
      public cbs: any;
      public decode = vi.fn();
      public configure = vi.fn(() => {
        this.state = 'configured';
      });
      public close = vi.fn(() => {
        this.state = 'closed';
      });
      constructor(cbs: any) {
        this.cbs = cbs;
        decoderInstances.push(this);
      }
    }

    class MockEncodedAudioChunk {
      public type: string;
      public timestamp: number;
      public data: Uint8Array;
      constructor(init: any) {
        this.type = init.type;
        this.timestamp = init.timestamp;
        this.data = init.data;
      }
    }

    (globalThis as any).window = {
      AudioContext: MockAudioContext,
      AudioDecoder: MockAudioDecoder,
      EncodedAudioChunk: MockEncodedAudioChunk,
    };

    const avSync = new AvSyncController();
    const player = new AudioPlayer(avSync);
    return { avSync, player, decoderInstances };
  }

  it('resetDecoder() closes AudioDecoder so subsequent identical OpusHead re-initializes a fresh decoder (while non-reset CONFIG stays idempotent)', async () => {
    const { player, decoderInstances } = setupAudioMocks();
    await player.unlock();

    const opusHead = new Uint8Array(19);
    opusHead.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"

    player.handleAudioPacket(AUDIO_FLAGS.CONFIG, 0n, opusHead);
    expect(decoderInstances.length).toBe(1);
    const dec1 = decoderInstances[0];
    expect(dec1.state).toBe('configured');

    // Issue #111: 通常の同一 OpusHead 再送（CATCHUP / Hold 復帰）では再初期化をスキップ
    player.handleAudioPacket(AUDIO_FLAGS.CONFIG, 0n, opusHead);
    expect(decoderInstances.length).toBe(1);
    expect(dec1.close).not.toHaveBeenCalled();

    // STREAM_RESET 用の明示リセット: 旧 AudioDecoder を閉じて破棄し、次の同一 CONFIG で新生成させる
    player.resetDecoder();
    expect(dec1.close).toHaveBeenCalledTimes(1);

    player.handleAudioPacket(AUDIO_FLAGS.CONFIG, 0n, opusHead);
    expect(decoderInstances.length).toBe(2);
    expect(decoderInstances[1].state).toBe('configured');
  });

  it('ignores late async output from closed old AudioDecoder instances without poisoning AvSyncController', async () => {
    const { avSync, player, decoderInstances } = setupAudioMocks();
    await player.unlock();

    const opusHead = new Uint8Array(19);
    opusHead.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);

    player.handleAudioPacket(AUDIO_FLAGS.CONFIG, 0n, opusHead);
    const oldDecoder = decoderInstances[0];
    player.resetDecoder();
    player.handleAudioPacket(AUDIO_FLAGS.CONFIG, 0n, opusHead);
    expect(decoderInstances.length).toBe(2);

    const lateAudioData = {
      numberOfChannels: 2,
      numberOfFrames: 960,
      sampleRate: 48000,
      timestamp: 2_324_410_498,
      format: 'f32-planar',
      copyTo: vi.fn(),
      close: vi.fn(),
    };

    oldDecoder.cbs.output(lateAudioData);
    expect(lateAudioData.close).toHaveBeenCalledTimes(1);
    expect(avSync.getCurrentPlayingAudioPtsUs()).toBeNull();
    expect(avSync.getLastAudioPts()).toBe(0);
  });

  it('auto-reinitializes AudioDecoder when incoming audio PTS jumps backward >1s across epoch boundaries', async () => {
    const { player, decoderInstances } = setupAudioMocks();
    await player.unlock();

    const opusHead = new Uint8Array(19);
    opusHead.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);
    player.handleAudioPacket(AUDIO_FLAGS.CONFIG, 0n, opusHead);
    const dec1 = decoderInstances[0];

    player.handleAudioPacket(AUDIO_FLAGS.KEYFRAME, 2_324_000_000n, new Uint8Array([1, 2, 3]));
    expect(dec1.decode).toHaveBeenCalledTimes(1);

    // 予告なく新 PTS エポック（~40ms）が来た場合も旧デコーダを破棄し新デコーダで処理する
    player.handleAudioPacket(AUDIO_FLAGS.KEYFRAME, 40_000n, new Uint8Array([4, 5, 6]));
    expect(dec1.close).toHaveBeenCalledTimes(1);
    expect(decoderInstances.length).toBe(2);
    expect(decoderInstances[1].decode).toHaveBeenCalledTimes(1);
  });

  it('FramePacer ignores >60s epoch-diverged audio lead in exitBufferingAndResume, processQueue, and stale_video_drop while keeping genuine 2.5s drops', () => {
    vi.useFakeTimers();

    const setupPacer = (audioPtsUs: number) => {
      const rendered: any[] = [];
      const droppedSpy = vi.fn();
      const mockRenderer: any = {
        render: vi.fn((f: any) => {
          rendered.push(f);
          f.close?.();
        }),
      };
      const avSync = new AvSyncController();
      avSync.setAudioContextTimeProvider(() => 10.0);
      avSync.updateAudioPts(audioPtsUs, 10.0);
      const pacer = new FramePacer(mockRenderer, 30, avSync, {
        stallThresholdMs: 120,
        minCushionMs: 180,
        maxCushionMs: 450,
        maxWaitMs: 450,
      });
      pacer.onFrameDropped = droppedSpy;
      return { pacer, rendered, droppedSpy };
    };

    const frame = (ptsUs: number) => ({ timestamp: ptsUs, close: vi.fn() }) as any;

    // Case A: エポック不整合（playingAudioPts = 2,324s >> 映像 = 100s -> lead > 60s）
    // buffering exit 時も processQueue 中もキューを破棄せず 1x 再生を継続する
    const epochCase = setupPacer(2_324_000_000);
    epochCase.pacer.queueFrame(frame(100_000_000)); // 初回描画
    vi.advanceTimersByTime(130); // network_stall トリガ -> enterBufferingState
    epochCase.pacer.queueFrame(frame(100_033_333));
    expect(epochCase.pacer.getIsBuffering()).toBe(true);

    for (let i = 2; i <= 11; i++) {
      epochCase.pacer.queueFrame(frame(100_000_000 + i * 33_333));
    }
    // バッファ蓄積完了で exitBufferingAndResume が走るが、>60s 乖離のため 1枚も破棄しない
    expect(epochCase.pacer.getIsBuffering()).toBe(false);
    expect(epochCase.droppedSpy).not.toHaveBeenCalled();
    expect(epochCase.pacer.getQueueLength()).toBe(10); // i=6 で 1 枚描画し、残り i=2..5,7..11 の 10 枚を保持
    // さらに 1 tick 進めても stale_video_drop / processQueue 2000ms ドロップは発動しない
    const qAfterExit = epochCase.pacer.getQueueLength();
    vi.advanceTimersByTime(36);
    expect(epochCase.droppedSpy).not.toHaveBeenCalled();
    expect(epochCase.pacer.getQueueLength()).toBe(qAfterExit - 1);
    epochCase.pacer.destroy();

    // Case B: 同一エポック内の本物の音声先行（+2.5s < 60s）は従来どおり stale 破棄して追従する
    const realStaleCase = setupPacer(102_500_000);
    realStaleCase.pacer.queueFrame(frame(100_000_000));
    vi.advanceTimersByTime(130);
    for (let i = 1; i <= 6; i++) {
      realStaleCase.pacer.queueFrame(frame(100_000_000 + i * 33_333));
    }
    expect(realStaleCase.pacer.getIsBuffering()).toBe(false);
    expect(realStaleCase.droppedSpy).toHaveBeenCalledTimes(5);
    expect(realStaleCase.pacer.getQueueLength()).toBe(0);
    realStaleCase.pacer.destroy();
  });
});
