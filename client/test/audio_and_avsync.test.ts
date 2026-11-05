import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayer } from '../src/core/audio-player.js';
import { AvSyncController } from '../src/core/av-sync.js';
import { FramePacer } from '../src/core/frame-pacer.js';
import { AUDIO_FLAGS } from '../src/transport/protocol.js';

describe('AvSyncController & AudioPlayer (Opus WebCodecs, Planar/Interleaved & Lockstep Sync)', () => {
  const originalWindow = (globalThis as any).window;
  const originalDocument = (globalThis as any).document;

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
    vi.restoreAllMocks();
  });

  it('AvSyncController maintains 1.0x native rate, interpolates real-time speaker PTS, and realigns >2000ms drift', () => {
    const sync = new AvSyncController();
    expect(sync.getPlaybackRate()).toBe(1.0);
    expect(sync.getCurrentPlayingAudioPtsUs()).toBeNull();

    let ctxTimeSec = 10.0;
    sync.setAudioContextTimeProvider(() => ctxTimeSec);

    // Anchor audio PTS 1,000,000us (1.0s) scheduled at AudioContext t=10.20s
    sync.updateAudioPts(1_000_000, 10.2);
    // At t=10.50s (+0.30s past anchor), speaker is playing PTS 1,300,000us (1.3s)
    ctxTimeSec = 10.5;
    expect(sync.getCurrentPlayingAudioPtsUs()).toBe(1_300_000);

    // Video is at 1,340,000us -> +40ms drift
    sync.updateVideoPts(1_340_000);
    expect(sync.getDriftMs()).toBe(40);

    // If AudioContext advances >1.5s without new audio packets, stream is silent -> returns null
    ctxTimeSec = 12.5;
    expect(sync.getCurrentPlayingAudioPtsUs()).toBeNull();

    // Fallback baseline drift realignment when jump exceeds >2000ms
    const sync2 = new AvSyncController();
    sync2.updateVideoPts(1_000_000);
    sync2.updateAudioPts(1_000_000);
    sync2.updateVideoPts(5_000_000); // +4000ms jump -> realigns baselines and returns 0
    expect(sync2.getDriftMs()).toBe(0);

    // clearAudioAnchor() resets audio playback clock tracking
    sync.clearAudioAnchor();
    expect(sync.getCurrentPlayingAudioPtsUs()).toBeNull();
  });

  it('AudioPlayer configures OpusHead (with fallback), decodes planar & interleaved f32, closes AudioData, and holds audio during video buffering', async () => {
    const ctxTime = 5.0;
    const scheduledSources: any[] = [];
    let decoderCallbacks: any = null;
    const configuredCalls: any[] = [];
    let rejectWithDescriptionOnce = true;

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
          gain: {
            value: 1.0,
            setValueAtTime: vi.fn((val: number) => {}),
          },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
      }
      public createBufferSource() {
        const src: any = {
          buffer: null,
          playbackRate: { value: 1.0 },
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null,
        };
        scheduledSources.push(src);
        return src;
      }
    }

    class MockAudioDecoder {
      public state = 'unconfigured';
      public decode = vi.fn();
      public close = vi.fn(() => {
        this.state = 'closed';
      });
      constructor(cbs: any) {
        decoderCallbacks = cbs;
      }
      public configure(cfg: any) {
        configuredCalls.push({ ...cfg });
        if (cfg.description && rejectWithDescriptionOnce) {
          rejectWithDescriptionOnce = false;
          throw new Error('Description not supported on this platform');
        }
        this.state = 'configured';
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
    (globalThis as any).document = {
      addEventListener: vi.fn(),
    };

    const avSync = new AvSyncController();
    const player = new AudioPlayer(avSync);
    await player.unlock();

    // 1. CONFIG packet (OpusHead >= 19B): retries without description when rejected, and does NOT decode config bytes!
    const opusHead = new Uint8Array(19);
    opusHead.set(new TextEncoder().encode('OpusHead'), 0);
    player.handleAudioPacket(AUDIO_FLAGS.CONFIG, 0n, opusHead);
    expect(configuredCalls).toHaveLength(2);
    expect(configuredCalls[0].description).toBeDefined();
    expect(configuredCalls[1].description).toBeUndefined();

    // 2. While video is buffering, decoded audio frames MUST be held in overflowQueue (never scheduled early!)
    avSync.setVideoBuffering(true);
    let closedCount = 0;

    const emitDecodedFrame = (ptsUs: number, format: 'f32-planar' | 'f32') => {
      const audioData = {
        numberOfChannels: 2,
        numberOfFrames: 960, // 20ms @ 48kHz
        sampleRate: 48000,
        timestamp: ptsUs,
        format,
        copyTo: vi.fn((dest: Float32Array, opts: any) => {
          if (opts.format === 'f32') {
            // Interleaved L=0.25, R=-0.25
            for (let i = 0; i < dest.length; i += 2) {
              dest[i] = 0.25;
              dest[i + 1] = -0.25;
            }
          } else {
            dest.fill(opts.planeIndex === 0 ? 0.5 : -0.5);
          }
        }),
        close: vi.fn(() => {
          closedCount++;
        }),
      };
      decoderCallbacks.output(audioData);
      return audioData;
    };

    // Emit 10 chunks (200ms total > 140ms cushion) mixing planar and interleaved formats while video is buffering
    for (let i = 0; i < 10; i++) {
      emitDecodedFrame((i + 1) * 20_000, i % 2 === 0 ? 'f32-planar' : 'f32');
    }
    expect(closedCount).toBe(10); // Every AudioData closed!
    expect(scheduledSources).toHaveLength(0); // Held waiting for video!

    // 3. Video exits buffering and advances to 400ms -> syncWithVideo drops >220ms stale chunks and schedules at 1.0x!
    avSync.setVideoBuffering(false);
    avSync.updateVideoPts(400_000);
    player.syncWithVideo();

    expect(scheduledSources.length).toBeGreaterThan(0);
    for (const src of scheduledSources) {
      expect(src.playbackRate.value).toBe(1.0);
    }

    // 4. Muted audioData is closed immediately without scheduling
    player.toggleMute();
    expect(player.getIsMuted()).toBe(true);
    const prevScheduled = scheduledSources.length;
    emitDecodedFrame(500_000, 'f32-planar');
    expect(closedCount).toBe(11);
    expect(scheduledSources.length).toBe(prevScheduled);

    player.close();
  });

  it('FramePacer anchors video playout to playing audio PTS when returning from DirectLive to PassiveStreaming', () => {
    vi.useFakeTimers();
    const mockRenderer: any = {
      render: vi.fn((f: any) => f.close?.()),
    };
    const avSync = new AvSyncController();
    const ctxTimeSec = 10.0;
    avSync.setAudioContextTimeProvider(() => ctxTimeSec);

    // Audio is playing PTS 2,000,000us (2.0s) at AudioContext t=10.0s
    avSync.updateAudioPts(2_000_000, 10.0);

    const pacer = new FramePacer(mockRenderer, 30, avSync);

    const createDummyFrame = (ptsUs: number) => ({
      timestamp: ptsUs,
      close: vi.fn(),
    });

    // 1. In ACTIVE_INTERACTION (DirectLive), frames render immediately (0ms delay)
    pacer.setMode('ACTIVE_INTERACTION');
    const f1 = createDummyFrame(2_200_000);
    pacer.queueFrame(f1 as any);
    expect(mockRenderer.render).toHaveBeenCalledWith(f1);

    // 2. Transition back to PASSIVE_STREAMING (DirectLive ended, watching video)
    pacer.setMode('PASSIVE_STREAMING');

    // Next video frame arrives at PTS 2,160,000us (160ms ahead of current playing audio 2,000,000us)
    const f2 = createDummyFrame(2_160_000);
    mockRenderer.render.mockClear();
    pacer.queueFrame(f2 as any);

    // Because audio is currently playing 2,000,000us, this video frame must NOT be rendered immediately!
    // It must wait in the queue until audio catches up to +160ms
    expect(mockRenderer.render).not.toHaveBeenCalled();
    expect(pacer.getQueueLength()).toBe(1);

    // Advance timers by 160ms -> frame renders perfectly in sync!
    vi.advanceTimersByTime(160);
    expect(mockRenderer.render).toHaveBeenCalledWith(f2);

    pacer.destroy();
  });

  it('maintains consistent audio volume and MasterGain safety headroom across LIVE to buffer transition without limiter ducking', async () => {
    let ctxTime = 1.0;
    const scheduledSources: any[] = [];
    let mockGainNode: any = null;

    class MockGainContext {
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
        mockGainNode = {
          gain: {
            value: 1.0,
            setValueAtTime: vi.fn((val: number) => {
              mockGainNode.gain.value = val;
            }),
          },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        return mockGainNode;
      }
      public createBufferSource() {
        const src: any = {
          buffer: null,
          playbackRate: { value: 1.0 },
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null,
        };
        scheduledSources.push(src);
        return src;
      }
    }

    let decoderOutputCb: any = null;
    (globalThis as any).window = {
      AudioContext: MockGainContext,
      AudioDecoder: class {
        constructor(init: any) {
          decoderOutputCb = init.output;
        }
        public state = 'unconfigured';
        public configure = vi.fn(() => {
          this.state = 'configured';
        });
        public decode = vi.fn((chunk: any) => {
          decoderOutputCb?.({
            numberOfChannels: 2,
            numberOfFrames: 960, // 20ms
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
        constructor(public init: any) {}
      },
    };

    const avSync = new AvSyncController();
    const player = new AudioPlayer(avSync);
    await player.unlock();

    // 1. Verify MasterGainNode is created with safe headroom (default 0.88 = ~ -1.1dB)
    expect(mockGainNode).not.toBeNull();
    expect(mockGainNode.gain.value).toBe(0.88);
    expect(mockGainNode.connect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'destination' }),
    );

    // Send CONFIG packet to initialize decoder
    player.handleAudioPacket(AUDIO_FLAGS.CONFIG, 0n, new Uint8Array(19));

    // 2. Simulate LIVE streaming: send 10 consecutive packets at 20ms intervals
    for (let i = 0; i < 10; i++) {
      const pts = 1_000_000 + i * 20_000;
      ctxTime = 1.0 + i * 0.02;
      avSync.updateVideoPts(pts);
      player.handleAudioPacket(0, BigInt(pts), new Uint8Array(100));
    }

    // Verify initial sources connected to MasterGainNode (NOT directly to destination)
    expect(scheduledSources.length).toBeGreaterThan(0);
    for (const src of scheduledSources) {
      expect(src.connect).toHaveBeenCalledWith(mockGainNode);
      expect(src.playbackRate.value).toBe(1.0);
    }

    // Verify volume is constant throughout LIVE
    expect(mockGainNode.gain.value).toBe(0.88);
    expect(player.getVolume()).toBe(0.88);

    // 3. Simulate transition to BUFFER mode (Prefetch Buffer accumulation):
    // Video stalls or buffers while audio packets continue arriving (accumulating in buffer)
    for (let i = 10; i < 25; i++) {
      const pts = 1_000_000 + i * 20_000;
      // Audio packets continue while currentTime advances
      ctxTime = 1.0 + i * 0.02;
      player.handleAudioPacket(0, BigInt(pts), new Uint8Array(100));
    }

    // Verify MasterGain gain has NOT dropped or ducked across the LIVE -> BUF boundary!
    expect(mockGainNode.gain.value).toBe(0.88);

    // 4. Verify volume control API
    player.setVolume(0.75);
    expect(mockGainNode.gain.value).toBe(0.75);
    expect(player.getVolume()).toBe(0.75);

    // 5. Verify mute control
    player.toggleMute();
    expect(player.getIsMuted()).toBe(true);
    expect(mockGainNode.gain.setValueAtTime).toHaveBeenCalledWith(0, ctxTime);

    player.toggleMute();
    expect(player.getIsMuted()).toBe(false);
    expect(mockGainNode.gain.setValueAtTime).toHaveBeenCalledWith(0.75, ctxTime);

    player.close();
  });
});
