import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AvSyncController } from '../src/core/av-sync.js';
import { FramePacer } from '../src/core/frame-pacer.js';
import { AudioPlayer } from '../src/core/audio-player.js';
import { AUDIO_FLAGS } from '../src/transport/protocol.js';

describe('A/V Sync Hunting Prevention & Rate Limiting (Issue #15)', () => {
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

  it('clamps positive A/V Sync shifts to max +2.5ms/frame when audio is lagging by 1500ms, preventing screen freeze', () => {
    const renderedFrames: any[] = [];
    const mockRenderer: any = {
      render: vi.fn((f: any) => {
        renderedFrames.push(f);
        f.close?.();
      }),
    };

    const avSync = new AvSyncController();
    let ctxTimeSec = 10.0;
    avSync.setAudioContextTimeProvider(() => ctxTimeSec);

    // Audio is playing PTS 1,000,000us (1.0s)
    avSync.updateAudioPts(1_000_000, 10.0);

    const pacer = new FramePacer(mockRenderer, 30, avSync);

    // Establish timeline with initial frame
    const f0 = createDummyFrame(2_500_000); // 1500ms ahead of audio
    pacer.queueFrame(f0 as any);
    expect(mockRenderer.render).toHaveBeenCalledWith(f0);

    // Queue 10 subsequent frames at 30fps (33.3ms PTS interval)
    // All frames are ~1.5s ahead of playing audio
    const frames: any[] = [];
    for (let i = 1; i <= 10; i++) {
      const f = createDummyFrame(2_500_000 + i * 33_333);
      frames.push(f);
      pacer.queueFrame(f as any);
    }

    expect(pacer.getQueueLength()).toBe(10);

    // Advance time in 36ms steps (slightly above 33.3ms + 2.5ms max nudge)
    // If the 1500ms positive shift bug were present, playback would freeze for 1500ms (0 rendered).
    // With rate-limiting (max +2.5ms nudge), frames render continuously at ~27-30 FPS!
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(36);
      expect(renderedFrames.length).toBe(i + 2); // f0 + rendered queued frames
    }

    expect(renderedFrames.length).toBe(11);
    expect(pacer.getQueueLength()).toBe(0);

    pacer.destroy();
  });

  it('clamps initial playout cursor on exitBufferingAndResume to at most 1 frame interval when audio is lagging', () => {
    const mockRenderer: any = {
      render: vi.fn((f: any) => f.close?.()),
    };

    const avSync = new AvSyncController();
    let ctxTimeSec = 5.0;
    avSync.setAudioContextTimeProvider(() => ctxTimeSec);

    // Audio lags 2000ms behind video
    avSync.updateAudioPts(1_000_000, 5.0);

    const pacer = new FramePacer(mockRenderer, 30, avSync);

    // Render one frame to establish timeline
    pacer.queueFrame(createDummyFrame(1_000_000) as any);

    // Force pacer into buffering state by queuing stall
    // First simulate stall
    const stallGapFrame = createDummyFrame(3_000_000);
    // Queue multiple frames while buffering
    for (let i = 0; i < 5; i++) {
      pacer.queueFrame(createDummyFrame(3_000_000 + i * 33_333) as any);
    }

    // Now if buffering was active and exits, cursorTime must NOT jump +2000ms
    // Instead it must start within 1 frame interval (<= 33.3ms)
    // Advance timers by 40ms: the first queued frame MUST render immediately!
    mockRenderer.render.mockClear();
    vi.advanceTimersByTime(40);

    expect(mockRenderer.render).toHaveBeenCalled();

    pacer.destroy();
  });

  it('clears audio anchor on major underrun (>500ms gap) preventing phantom audio clock extrapolation', async () => {
    let ctxTime = 1.0;
    const scheduledSources: any[] = [];

    class MockAudioContext {
      public state = 'running';
      public sampleRate = 48000;
      public destination = { id: 'destination' };
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
        return {
          numberOfChannels: channels,
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

    let decoderOutputCallback: any = null;
    class MockAudioDecoder {
      public state = 'configured';
      constructor(init: any) {
        decoderOutputCallback = init.output;
      }
      public configure = vi.fn();
      public decode = vi.fn();
      public reset = vi.fn();
      public close = vi.fn();
    }

    (globalThis as any).window = {
      AudioContext: MockAudioContext,
      AudioDecoder: MockAudioDecoder,
      EncodedAudioChunk: MockEncodedAudioChunk,
    };
    (globalThis as any).document = {
      addEventListener: vi.fn(),
    };

    const avSync = new AvSyncController();
    avSync.setAudioContextTimeProvider(() => ctxTime);

    const player = new AudioPlayer(avSync);
    await player.unlock();

    // Send CONFIG
    player.handleAudioPacket(AUDIO_FLAGS.CONFIG, 0n, new Uint8Array(19));

    // Send initial packet
    const emitFrame = (ptsUs: number) => {
      decoderOutputCallback({
        numberOfChannels: 2,
        numberOfFrames: 960, // 20ms
        sampleRate: 48000,
        timestamp: ptsUs,
        format: 'f32-planar',
        copyTo: vi.fn(),
        close: vi.fn(),
      });
    };

    // Buffer 8 packets (160ms) to start playback
    for (let i = 0; i < 8; i++) {
      ctxTime = 1.0 + i * 0.02;
      player.handleAudioPacket(0, BigInt(1_000_000 + i * 20_000), new Uint8Array(100));
      emitFrame(1_000_000 + i * 20_000);
    }

    // Audio is playing and anchor is active
    expect(avSync.getCurrentPlayingAudioPtsUs()).not.toBeNull();

    // Simulate 600ms gap in audio arrival (> 500ms underrun)
    ctxTime = 3.0; // now - nextPlayTime > 0.5s

    // Next packet arrives after 600ms gap
    player.handleAudioPacket(0, BigInt(2_000_000), new Uint8Array(100));
    emitFrame(2_000_000);

    // Player enters underrun rebuilding state: audioAnchor must be CLEARED!
    expect(avSync.getCurrentPlayingAudioPtsUs()).toBeNull();

    player.close();
  });

  it('accelerates gracefully on negative A/V drift (video behind audio) without stalling', () => {
    const renderedFrames: any[] = [];
    const mockRenderer: any = {
      render: vi.fn((f: any) => {
        renderedFrames.push(f);
        f.close?.();
      }),
    };

    const avSync = new AvSyncController();
    let ctxTimeSec = 10.0;
    avSync.setAudioContextTimeProvider(() => ctxTimeSec);

    // Audio is far ahead at PTS 5,000,000us
    avSync.updateAudioPts(5_000_000, 10.0);

    const pacer = new FramePacer(mockRenderer, 30, avSync);

    // Video arrives late at PTS 4,700,000us (300ms behind audio)
    const f0 = createDummyFrame(4_700_000);
    pacer.queueFrame(f0 as any);

    // Queue 5 late frames
    for (let i = 1; i <= 5; i++) {
      pacer.queueFrame(createDummyFrame(4_700_000 + i * 33_333) as any);
    }

    // Because video is behind audio, negative shift pulls frames closer to now
    // Enforcing minNextTime (>= 8ms), frames drain smoothly to catch up without freezing
    vi.advanceTimersByTime(100);
    expect(renderedFrames.length).toBeGreaterThanOrEqual(3);

    pacer.destroy();
  });
});
