import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayer } from '../src/core/audio-player.js';
import { AvSyncController } from '../src/core/av-sync.js';
import { FramePacer } from '../src/core/frame-pacer.js';
import { AUDIO_FLAGS } from '../src/transport/protocol.js';

describe('A/V Sync Stutter Elimination & Audio Underrun Guard', () => {
  const originalWindow = (globalThis as any).window;
  const originalDocument = (globalThis as any).document;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const createDummyFrame = (ptsUs: number) => ({
    timestamp: ptsUs,
    close: vi.fn(),
  });

  it('eliminates PLL stuttering and hunting under normal playout with active audio', () => {
    const renderTimestamps: number[] = [];
    const mockRenderer: any = {
      render: vi.fn((f: any) => {
        renderTimestamps.push(performance.now());
        f.close?.();
      }),
    };

    const avSync = new AvSyncController();
    let ctxTimeSec = 1.0;
    avSync.setAudioContextTimeProvider(() => ctxTimeSec);

    // Audio is playing normally with 160ms playout cushion (playingAudioPts lags by ~160ms)
    // Audio PTS = 1,000,000us at ctxTime = 1.0s
    avSync.updateAudioPts(1_000_000, 1.0);

    const pacer = new FramePacer(mockRenderer, 30, avSync);

    // Initial video frame arrives at PTS 1,160,000us (~160ms ahead of playing audio PTS)
    pacer.queueFrame(createDummyFrame(1_160_000) as any);
    expect(mockRenderer.render).toHaveBeenCalledTimes(1);

    // Subsequent frames arrive at steady 30fps (33.3ms intervals)
    for (let i = 1; i <= 15; i++) {
      ctxTimeSec = 1.0 + i * 0.033333;
      pacer.queueFrame(createDummyFrame(1_160_000 + i * 33_333) as any);
      vi.advanceTimersByTime(33.333);
    }

    // All frames render smoothly at steady ~30 FPS without being dragged down to 27.5 FPS!
    expect(mockRenderer.render).toHaveBeenCalledTimes(16);

    // Verify inter-frame intervals remain stable (~33.3ms) without micro-hunting spikes
    for (let i = 2; i < renderTimestamps.length; i++) {
      const interval = renderTimestamps[i] - renderTimestamps[i - 1];
      expect(interval).toBeGreaterThanOrEqual(30);
      expect(interval).toBeLessThanOrEqual(38);
    }

    pacer.destroy();
  });

  it('does NOT trigger audio underrun / anchor clearing on minor sub-40ms timing jitter', async () => {
    let ctxTime = 1.0;
    const scheduledSources: any[] = [];
    let decoderOutputCallback: any = null;

    class MockAudioContext {
      public state = 'running';
      public sampleRate = 48000;
      public destination = { id: 'destination' };
      public get currentTime() {
        return ctxTime;
      }
      public resume = vi.fn(async () => {});
      public close = vi.fn(async () => {});
      public createBuffer(ch: number, frames: number, rate: number) {
        return {
          numberOfChannels: ch,
          length: frames,
          sampleRate: rate,
          duration: frames / rate,
          getChannelData: () => new Float32Array(frames),
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
        const source: any = {
          buffer: null,
          playbackRate: { value: 1.0 },
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn((at: number) => {
            source.startTime = at;
            scheduledSources.push(source);
          }),
          stop: vi.fn(),
          onended: null,
        };
        return source;
      }
    }

    (globalThis as any).window = {
      AudioContext: MockAudioContext,
      AudioDecoder: class {
        constructor(init: any) {
          decoderOutputCallback = init.output;
        }
        public state = 'configured';
        public configure = vi.fn();
        public decode = vi.fn((chunk: any) => {
          decoderOutputCallback?.({
            numberOfChannels: 2,
            numberOfFrames: 960,
            sampleRate: 48000,
            timestamp: chunk.timestamp,
            format: 'f32-planar',
            copyTo: vi.fn(),
            close: vi.fn(),
          });
        });
        public close = vi.fn();
      },
      EncodedAudioChunk: class {
        public type: string;
        public timestamp: number;
        public data: Uint8Array;
        constructor(init: any) {
          this.type = init.type;
          this.timestamp = init.timestamp;
          this.data = init.data;
        }
      },
    };

    const avSync = new AvSyncController();
    avSync.setAudioContextTimeProvider(() => ctxTime);

    const player = new AudioPlayer(avSync);
    await player.unlock();

    player.handleAudioPacket(AUDIO_FLAGS.CONFIG, 0n, new Uint8Array(19));

    // Buffer 8 packets (160ms) to start playback
    for (let i = 0; i < 8; i++) {
      ctxTime = 1.0 + i * 0.02;
      player.handleAudioPacket(0, BigInt(1_000_000 + i * 20_000), new Uint8Array(100));
    }

    expect(scheduledSources.length).toBe(8);
    expect(avSync.getCurrentPlayingAudioPtsUs()).not.toBeNull();

    // Advance time such that nextPlayTime (1.325s) is overtaken by only 15ms (minor main-thread hiccup)
    ctxTime = 1.34;

    // A new packet arrives: with the 40ms threshold, this must NOT be flagged as major underrun!
    player.handleAudioPacket(0, BigInt(1_160_000), new Uint8Array(100));

    // Must NOT stop sources or wipe audio anchor on 15ms jitter!
    expect(avSync.getCurrentPlayingAudioPtsUs()).not.toBeNull();
    expect(scheduledSources.length).toBe(9);

    // Now advance time by > 50ms past latest nextPlayTime (1.385s -> 1.450s: genuine network stall / exhaustion)
    ctxTime = 1.45;
    player.handleAudioPacket(0, BigInt(1_180_000), new Uint8Array(100));

    // Genuine underrun (>40ms): enters cushion rebuilding mode and clears anchor
    expect(avSync.getCurrentPlayingAudioPtsUs()).toBeNull();

    player.close();
  });
});
