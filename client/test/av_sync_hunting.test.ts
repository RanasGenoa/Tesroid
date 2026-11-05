import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayer } from '../src/core/audio-player.js';
import { AvSyncController } from '../src/core/av-sync.js';
import { FramePacer } from '../src/core/frame-pacer.js';
import { TelemetryCollector } from '../src/core/telemetry.js';
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

  const setupMockWebAudioEnv = (getCtxTime: () => number) => {
    const scheduledSources: any[] = [];
    let decoderOutputCallback: any = null;

    class MockAudioContext {
      public state = 'running';
      public sampleRate = 48000;
      public destination = { id: 'destination' };
      public get currentTime() {
        return getCtxTime();
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

    const emitFrame = (ptsUs: number) => {
      decoderOutputCallback({
        numberOfChannels: 2,
        numberOfFrames: 960, // 20ms @ 48kHz
        sampleRate: 48000,
        timestamp: ptsUs,
        format: 'f32-planar',
        copyTo: vi.fn(),
        close: vi.fn(),
      });
    };

    return { scheduledSources, emitFrame };
  };

  it('clamps positive A/V Sync shifts to max +2.5ms/frame when audio is lagging by 1500ms, preventing screen freeze', () => {
    const renderedFrames: any[] = [];
    const mockRenderer: any = {
      render: vi.fn((f: any) => {
        renderedFrames.push(f);
        f.close?.();
      }),
    };

    const avSync = new AvSyncController();
    const ctxTimeSec = 10.0;
    avSync.setAudioContextTimeProvider(() => ctxTimeSec);

    // Audio is playing PTS 1,000,000us (1.0s)
    avSync.updateAudioPts(1_000_000, 10.0);

    const pacer = new FramePacer(mockRenderer, 30, avSync);

    // Establish timeline with initial frame
    const f0 = createDummyFrame(2_500_000); // 1500ms ahead of audio
    pacer.queueFrame(f0 as any);
    expect(mockRenderer.render).toHaveBeenCalledWith(f0);

    // Queue 10 subsequent frames at 30fps (33.3ms PTS interval)
    for (let i = 1; i <= 10; i++) {
      pacer.queueFrame(createDummyFrame(2_500_000 + i * 33_333) as any);
    }

    expect(pacer.getQueueLength()).toBe(10);

    // Advance time in 36ms steps (slightly above 33.3ms + 2.5ms max nudge)
    // With rate-limiting (max +2.5ms nudge), frames render continuously at ~28 FPS without stalling!
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(36);
      expect(renderedFrames.length).toBe(i + 2);
    }

    expect(renderedFrames.length).toBe(11);
    expect(pacer.getQueueLength()).toBe(0);

    pacer.destroy();
  });

  it('genuinely enters buffering on network stall and clamps initial playout cursor on exitBufferingAndResume to <= 1 frame interval', () => {
    const mockRenderer: any = {
      render: vi.fn((f: any) => f.close?.()),
    };

    const avSync = new AvSyncController();
    const ctxTimeSec = 5.0;
    avSync.setAudioContextTimeProvider(() => ctxTimeSec);

    // Audio is playing PTS 1,000,000us (lags ~2000ms behind upcoming video)
    avSync.updateAudioPts(1_000_000, 5.0);

    const pacer = new FramePacer(mockRenderer, 30, avSync);

    // Render initial frame at t=0 (PTS = 3,000,000us, already 2000ms ahead of audio)
    pacer.queueFrame(createDummyFrame(3_000_000) as any);
    expect(mockRenderer.render).toHaveBeenCalledTimes(1);
    expect(pacer.getIsBuffering()).toBe(false);

    // Simulate genuine network transit stall: 220ms wall-clock gap, but only 33.3ms PTS advance!
    vi.advanceTimersByTime(220);
    pacer.queueFrame(createDummyFrame(3_033_333) as any);
    expect(pacer.getIsBuffering()).toBe(true);

    // Deliver cushion burst (6 more frames = ~233ms queued PTS >= 180ms target cushion) to exit buffering
    mockRenderer.render.mockClear();
    for (let i = 2; i <= 7; i++) {
      pacer.queueFrame(createDummyFrame(3_000_000 + i * 33_333) as any);
    }

    // Buffering must have exited, and cursorTime must NOT have jumped +2000ms into the future!
    expect(pacer.getIsBuffering()).toBe(false);

    // Within 1 frame interval (~35ms), the head frame MUST render smoothly
    vi.advanceTimersByTime(35);
    expect(mockRenderer.render).toHaveBeenCalled();

    pacer.destroy();
  });

  it('clears audio anchor on major underrun (>500ms gap) preventing phantom audio clock extrapolation', async () => {
    let ctxTime = 1.0;
    const { emitFrame } = setupMockWebAudioEnv(() => ctxTime);

    const avSync = new AvSyncController();
    avSync.setAudioContextTimeProvider(() => ctxTime);

    const player = new AudioPlayer(avSync);
    await player.unlock();

    player.handleAudioPacket(AUDIO_FLAGS.CONFIG, 0n, new Uint8Array(19));

    // Buffer 8 packets (160ms) to start playback
    for (let i = 0; i < 8; i++) {
      ctxTime = 1.0 + i * 0.02;
      player.handleAudioPacket(0, BigInt(1_000_000 + i * 20_000), new Uint8Array(100));
      emitFrame(1_000_000 + i * 20_000);
    }

    expect(avSync.getCurrentPlayingAudioPtsUs()).not.toBeNull();

    // Simulate > 500ms gap in audio arrival
    ctxTime = 3.0;
    player.handleAudioPacket(0, BigInt(2_000_000), new Uint8Array(100));
    emitFrame(2_000_000);

    // Player enters underrun rebuilding state: audioAnchor must be CLEARED!
    expect(avSync.getCurrentPlayingAudioPtsUs()).toBeNull();

    player.close();
  });

  it('accelerates gracefully on negative A/V drift at both 30 FPS and 60 FPS while enforcing >= 8ms frame spacing', () => {
    for (const fps of [30, 60]) {
      const renderTimesMs: number[] = [];
      const mockRenderer: any = {
        render: vi.fn((f: any) => {
          renderTimesMs.push(performance.now());
          f.close?.();
        }),
      };

      const avSync = new AvSyncController();
      avSync.setAudioContextTimeProvider(() => 10.0);
      // Audio is 400ms ahead at PTS 5,000,000us
      avSync.updateAudioPts(5_000_000, 10.0);

      const pacer = new FramePacer(mockRenderer, fps, avSync);
      const stepUs = Math.round(1_000_000 / fps);

      // Video arrives late at PTS 4,600,000us (400ms behind audio)
      pacer.queueFrame(createDummyFrame(4_600_000) as any);
      for (let i = 1; i <= 8; i++) {
        pacer.queueFrame(createDummyFrame(4_600_000 + i * stepUs) as any);
      }

      vi.advanceTimersByTime(150);
      expect(renderTimesMs.length).toBeGreaterThanOrEqual(4);

      // Verify strict minimum 8ms spacing between consecutive rendered frames (no 1ms tight burst at 60fps!)
      for (let i = 1; i < renderTimesMs.length; i++) {
        expect(renderTimesMs[i] - renderTimesMs[i - 1]).toBeGreaterThanOrEqual(8);
      }

      pacer.destroy();
    }
  });

  it('throttles large_shift telemetry logs to once per 500ms with suppressedCount during rate-limited convergence', () => {
    const collector = new TelemetryCollector();
    collector.setEnabled(true);
    const events: any[] = [];
    collector.onFlush = (batch) => events.push(...batch);

    const mockRenderer: any = {
      render: vi.fn((f: any) => f.close?.()),
    };

    const avSync = new AvSyncController();
    avSync.setAudioContextTimeProvider(() => 10.0);
    avSync.updateAudioPts(1_000_000, 10.0);

    const pacer = new FramePacer(mockRenderer, 30, avSync);
    pacer.setTelemetryCollector(collector);

    // Render initial frame & queue 25 frames 1500ms ahead of audio (~900ms of playback)
    pacer.queueFrame(createDummyFrame(2_500_000) as any);
    for (let i = 1; i <= 25; i++) {
      pacer.queueFrame(createDummyFrame(2_500_000 + i * 33_333) as any);
    }

    for (let i = 0; i < 25; i++) {
      vi.advanceTimersByTime(36);
    }
    collector.flush();

    const largeShifts = events.filter((e) => e.type === 'av_sync' && e.event === 'large_shift');
    // Over ~900ms (25 frames), 500ms throttling must emit only 2 events instead of 24!
    expect(largeShifts.length).toBe(2);
    expect(largeShifts[0].data.suppressedCount).toBe(0);
    expect(largeShifts[1].data.suppressedCount).toBeGreaterThanOrEqual(10);

    collector.destroy();
    pacer.destroy();
  });

  it('AudioPlayer.syncWithVideo preserves chunks on <=1500ms jitter and cleanly resyncs within 60ms on >1500ms GOP jump', async () => {
    const ctxTime = 2.0;
    const { emitFrame } = setupMockWebAudioEnv(() => ctxTime);

    const avSync = new AvSyncController();
    avSync.setAudioContextTimeProvider(() => ctxTime);

    const collector = new TelemetryCollector();
    collector.setEnabled(true);
    const events: any[] = [];
    collector.onFlush = (batch) => events.push(...batch);

    const player = new AudioPlayer(avSync);
    player.setTelemetryCollector(collector);
    await player.unlock();
    player.handleAudioPacket(AUDIO_FLAGS.CONFIG, 0n, new Uint8Array(19));

    // Hold incoming audio in overflowQueue while video is buffering (100 chunks = 2.0s: PTS 1.00s .. 2.98s)
    avSync.setVideoBuffering(true);
    for (let i = 0; i < 100; i++) {
      const ptsUs = 1_000_000 + i * 20_000;
      player.handleAudioPacket(0, BigInt(ptsUs), new Uint8Array(100));
      emitFrame(ptsUs);
    }

    // 1. Sub-threshold lag (1200ms <= 1500ms): MUST NOT drop any audio chunks!
    avSync.setVideoBuffering(false);
    avSync.updateVideoPts(2_175_000); // targetAudioPtsUs = 2,175,000 + 25,000 = 2,200,000 (1200ms > 1,000,000)
    player.syncWithVideo();
    collector.flush();
    expect(events.filter((e) => e.type === 'audio' && e.event === 'drop_stale_audio')).toHaveLength(
      0,
    );

    // 2. Major GOP jump (> 1500ms lag): hold another batch up to 4.50s, then jump video to 4.20s
    avSync.setVideoBuffering(true);
    for (let i = 100; i < 175; i++) {
      const ptsUs = 1_000_000 + i * 20_000; // up to 4,480,000us
      player.handleAudioPacket(0, BigInt(ptsUs), new Uint8Array(100));
      emitFrame(ptsUs);
    }

    avSync.setVideoBuffering(false);
    avSync.updateVideoPts(4_000_000); // > 2s ahead of overflowQueue head (~1.52s)
    player.syncWithVideo();
    collector.flush();

    const dropEvents = events.filter((e) => e.type === 'audio' && e.event === 'drop_stale_audio');
    expect(dropEvents).toHaveLength(1);
    const dropData = dropEvents[0].data;
    // Residual lag between targetAudioPtsUs and next remaining chunk must be <= 60ms (NOT 1500ms!)
    const nextRemainingPtsUs = dropData.lastDroppedPtsUs + 20_000;
    expect((dropData.targetAudioPtsUs - nextRemainingPtsUs) / 1000).toBeLessThanOrEqual(60);

    collector.destroy();
    player.close();
  });

  it('re-anchors PassiveStreaming after DirectLive cleanly even at large performance.now() and caps lag to <=200ms', () => {
    const mockRenderer: any = {
      render: vi.fn((f: any) => f.close?.()),
    };
    const avSync = new AvSyncController();
    avSync.setAudioContextTimeProvider(() => 10.0);
    avSync.updateAudioPts(2_000_000, 10.0);

    const pacer = new FramePacer(mockRenderer, 30, avSync);

    // Advance fake session clock to 60 seconds (performance.now() = 60,000ms)
    vi.advanceTimersByTime(60_000);

    pacer.setMode('ACTIVE_INTERACTION');
    pacer.queueFrame(createDummyFrame(2_200_000) as any);
    expect(mockRenderer.render).toHaveBeenCalledTimes(1);

    pacer.setMode('PASSIVE_STREAMING');
    mockRenderer.render.mockClear();

    // Case A: Frame is 160ms ahead of audio -> waits ~160ms even when performance.now() === 60,000ms!
    const fAhead160 = createDummyFrame(2_160_000);
    pacer.queueFrame(fAhead160 as any);
    expect(mockRenderer.render).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(mockRenderer.render).not.toHaveBeenCalled();
    vi.advanceTimersByTime(65);
    expect(mockRenderer.render).toHaveBeenCalledWith(fAhead160);

    // Case B: Audio lags by 2000ms on DirectLive -> PassiveStreaming transition -> capped to ~200ms (no 2s freeze!)
    pacer.setMode('ACTIVE_INTERACTION');
    pacer.queueFrame(createDummyFrame(4_000_000) as any);
    pacer.setMode('PASSIVE_STREAMING');
    mockRenderer.render.mockClear();

    const fAhead2000 = createDummyFrame(4_033_333);
    pacer.queueFrame(fAhead2000 as any);
    vi.advanceTimersByTime(210);
    expect(mockRenderer.render).toHaveBeenCalledWith(fAhead2000);

    pacer.destroy();
  });
});
