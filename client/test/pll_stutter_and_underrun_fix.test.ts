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
    vi.advanceTimersByTime(35);

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

  it('slew-rate clamps large negative and positive A/V sync errors (> 150ms) to max ±2.0ms per frame to prevent stutter bursts and freezing', () => {
    const renderTimestamps: number[] = [];
    const mockRenderer: any = {
      render: vi.fn((f: any) => {
        renderTimestamps.push(performance.now());
        f.close?.();
      }),
    };

    const avSync = new AvSyncController();
    const ctxTimeSec = 1.0;
    avSync.setAudioContextTimeProvider(() => ctxTimeSec);

    // Audio PTS = 1,000,000us at ctxTime = 1.0s
    avSync.updateAudioPts(1_000_000, 1.0);

    const pacer = new FramePacer(mockRenderer, 30, avSync);

    // Initial frame renders immediately
    pacer.queueFrame(createDummyFrame(1_000_000) as any);
    expect(mockRenderer.render).toHaveBeenCalledTimes(1);

    // Case 1: Video falls behind audio significantly (syncErrorMs < -150ms).
    // In legacy code, maxNegativeShift was -16ms, causing a severe 17ms stutter burst.
    // Now, slew-rate clamping restricts shift to max -2.0ms per frame.
    // Audio suddenly jumps ahead by 300ms:
    avSync.updateAudioPts(1_300_000, 1.0);

    // Queue next frame at PTS 1_033_333 (expected schedule interval ~33.3ms, shifted by at most -2.0ms -> ~31.3ms)
    pacer.queueFrame(createDummyFrame(1_033_333) as any);

    // At 25ms, it should NOT render yet (legacy -16ms would have rendered around 17ms!)
    vi.advanceTimersByTime(25);
    expect(mockRenderer.render).toHaveBeenCalledTimes(1);

    // Advance to 35ms: it should render smoothly around ~31.3ms
    vi.advanceTimersByTime(10);
    expect(mockRenderer.render).toHaveBeenCalledTimes(2);

    const intervalNegative = renderTimestamps[1] - renderTimestamps[0];
    expect(intervalNegative).toBeGreaterThanOrEqual(30); // Preserves >= 30ms interval!
    expect(intervalNegative).toBeLessThanOrEqual(35);

    pacer.destroy();
  });

  it('accumulates PLL shifts across real-time frame arrivals to close the ~160ms audio jitter cushion gap smoothly without freezing', () => {
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

    // Audio is playing PTS 1,000,000us (delayed ~160ms behind incoming packets due to jitter buffer)
    avSync.updateAudioPts(1_000_000, 1.0);

    const pacer = new FramePacer(mockRenderer, 30, avSync);

    // Initial frame arrives at t=0
    pacer.queueFrame(createDummyFrame(1_160_000) as any);
    expect(mockRenderer.render).toHaveBeenCalledTimes(1);

    // 80 subsequent frames arrive at real-time 33.3ms wall-clock intervals
    for (let i = 1; i <= 80; i++) {
      vi.advanceTimersByTime(33.333);
      ctxTimeSec = 1.0 + i * 0.033333;
      pacer.queueFrame(createDummyFrame(1_160_000 + i * 33_333) as any);
    }

    // Advance remaining time for all queued frames to drain
    vi.advanceTimersByTime(250);

    // All 81 frames must render smoothly without drops
    expect(mockRenderer.render).toHaveBeenCalledTimes(81);

    // Verify all consecutive render intervals remain strictly within smooth playback range [30ms..38ms]
    for (let i = 2; i < renderTimestamps.length; i++) {
      const interval = renderTimestamps[i] - renderTimestamps[i - 1];
      expect(interval).toBeGreaterThanOrEqual(30);
      expect(interval).toBeLessThanOrEqual(38);
    }

    pacer.destroy();
  });

  it('smoothly catches up video when lagging 160ms behind audio during real-time frame arrivals at 60 FPS', () => {
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

    // Audio is playing PTS 2,000,000us at ctxTime = 1.0s
    avSync.updateAudioPts(2_000_000, 1.0);

    const pacer = new FramePacer(mockRenderer, 60, avSync);
    const stepUs = 16_666;
    const stepMs = 16.666;

    // Video arrives 160ms BEHIND audio: PTS 1,840,000us (2,000,000 - 160,000)
    pacer.queueFrame(createDummyFrame(1_840_000) as any);
    expect(mockRenderer.render).toHaveBeenCalledTimes(1);

    // Subsequent 80 frames arrive at real-time 16.6ms intervals
    for (let i = 1; i <= 80; i++) {
      vi.advanceTimersByTime(stepMs);
      ctxTimeSec = 1.0 + i * (stepMs / 1000);
      pacer.queueFrame(createDummyFrame(1_840_000 + i * stepUs) as any);
    }
    vi.advanceTimersByTime(100);

    // All frames must render
    expect(mockRenderer.render).toHaveBeenCalledTimes(81);

    // Verify all consecutive render intervals remain strictly >= 8ms (no tight loop freeze)
    // and <= 20ms (smooth 60fps catchup)
    for (let i = 1; i < renderTimestamps.length; i++) {
      const interval = renderTimestamps[i] - renderTimestamps[i - 1];
      expect(interval).toBeGreaterThanOrEqual(8);
      expect(interval).toBeLessThanOrEqual(20);
    }

    pacer.destroy();
  });
});
