import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayer } from '../src/core/audio-player.js';
import { AvSyncController } from '../src/core/av-sync.js';
import { AUDIO_FLAGS } from '../src/transport/protocol.js';

describe('Issue 25: Audio volume attenuation prevention under network jitter and underruns', () => {
  const originalWindow = (globalThis as any).window;
  const originalDocument = (globalThis as any).document;

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
    vi.restoreAllMocks();
  });

  function setupMockAudioEnvironment() {
    let ctxTime = 1.0;
    const scheduledSources: any[] = [];
    let mockGainNode: any = null;
    let decoderOutputCb: any = null;

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
        const chArrays = Array.from({ length: channels }, () => new Float32Array(frames).fill(0.8));
        return {
          numberOfChannels: channels,
          length: frames,
          sampleRate: rate,
          duration: frames / rate,
          getChannelData: (c: number) => chArrays[c],
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
          start: vi.fn((time: number) => {
            src.startTime = time;
          }),
          stop: vi.fn(),
          onended: null,
        };
        scheduledSources.push(src);
        return src;
      }
    }

    (globalThis as any).window = {
      AudioContext: MockGainContext,
      AudioDecoder: class {
        constructor(init: any) {
          decoderOutputCb = init.output;
        }
        public state = 'configured';
        public configure = vi.fn();
        public decode = vi.fn((chunk: any) => {
          decoderOutputCb?.({
            numberOfChannels: 2,
            numberOfFrames: 960, // 20ms @ 48kHz
            sampleRate: 48000,
            timestamp: chunk.timestamp,
            format: 'f32-planar',
            copyTo: vi.fn((dest: Float32Array) => dest.fill(0.8)),
            close: vi.fn(),
          });
        });
        public close = vi.fn();
      },
      EncodedAudioChunk: class {
        constructor(public init: any) {}
      },
    };

    return {
      getCtxTime: () => ctxTime,
      setCtxTime: (t: number) => {
        ctxTime = t;
      },
      scheduledSources,
      getMockGainNode: () => mockGainNode,
    };
  }

  it('prevents single-chunk chopping duty-cycle drops by rebuilding cushion on underrun and applying de-click fade-in', async () => {
    const env = setupMockAudioEnvironment();
    const avSync = new AvSyncController();
    const player = new AudioPlayer(avSync);
    await player.unlock();

    player.handleAudioPacket(AUDIO_FLAGS.CONFIG, 0n, new Uint8Array(19));

    // 1. Initial buffering: 8 packets (160ms) to start playback
    for (let i = 0; i < 8; i++) {
      const pts = 1_000_000 + i * 20_000;
      env.setCtxTime(1.0 + i * 0.02);
      player.handleAudioPacket(0, BigInt(pts), new Uint8Array(100));
    }

    // Playback started, 8 sources scheduled gap-less
    expect(env.scheduledSources.length).toBe(8);
    const initialSources = [...env.scheduledSources];

    // First source in burst must have de-click fade-in applied (first sample close to 0, smoothly ramping to 0.8)
    const firstBufData = initialSources[0].buffer.getChannelData(0);
    expect(firstBufData[0]).toBe(0); // 0.8 * 0/48 = 0
    expect(firstBufData[24]).toBeCloseTo(0.4, 2); // 0.8 * 24/48 = 0.4
    expect(firstBufData[48]).toBeCloseTo(0.8, 2); // Full scale unattenuated

    // Second source must NOT have fade-in applied (fully seamless contiguous playout)
    const secondBufData = initialSources[1].buffer.getChannelData(0);
    expect(secondBufData[0]).toBeCloseTo(0.8, 2);

    // 2. Simulate network disruption:
    // currentTime advances by 300ms (1.16s -> 1.46s) with NO audio packets arriving -> hardware underruns!
    env.setCtxTime(1.5); // Well past scheduled sources (~1.185s)

    // 3. First packet arrives after the disruption:
    // Under the old bug, this packet would immediately schedule at (now + 80ms) for 20ms, leaving an 80ms hole,
    // causing an 80% duty cycle / volume attenuation loop!
    // With the fix, the player enters cushion rebuilding mode and holds it in bufferQueue.
    const packet1Pts = 1_160_000;
    player.handleAudioPacket(0, BigInt(packet1Pts), new Uint8Array(100));

    // Must NOT immediately schedule an isolated 20ms packet into the future!
    expect(env.scheduledSources.length).toBe(8);

    // Packets 2 and 3 arrive (accumulating in buffer)
    player.handleAudioPacket(0, BigInt(packet1Pts + 20_000), new Uint8Array(100));
    player.handleAudioPacket(0, BigInt(packet1Pts + 40_000), new Uint8Array(100));
    expect(env.scheduledSources.length).toBe(8);

    // Packet 4 arrives (reaches REBUFFER_CUSHION_SEC = 80ms cushion: 4 x 20ms)
    player.handleAudioPacket(0, BigInt(packet1Pts + 60_000), new Uint8Array(100));

    // Playback resumes with 4 contiguous packets scheduled at once!
    expect(env.scheduledSources.length).toBe(12);

    const resumedSources = env.scheduledSources.slice(8);
    // Verify all 4 packets are scheduled contiguously without 80ms holes between them
    expect(resumedSources[0].startTime).toBeCloseTo(1.5 + 0.025, 3); // now + HARDWARE_LOOKAHEAD_SEC
    expect(resumedSources[1].startTime).toBeCloseTo(resumedSources[0].startTime + 0.02, 3);
    expect(resumedSources[2].startTime).toBeCloseTo(resumedSources[1].startTime + 0.02, 3);
    expect(resumedSources[3].startTime).toBeCloseTo(resumedSources[2].startTime + 0.02, 3);

    // First resumed source has de-click applied
    expect(resumedSources[0].buffer.getChannelData(0)[0]).toBe(0);
    // Second resumed source is untouched
    expect(resumedSources[1].buffer.getChannelData(0)[0]).toBeCloseTo(0.8, 2);

    // Volume level remains constant (0.88 headroom maintained)
    expect(env.getMockGainNode().gain.value).toBe(0.88);
    expect(player.getVolume()).toBe(0.88);

    player.close();
  });

  it('syncWithVideo requires healthy cushion before resuming playout, preventing rapid re-underruns', async () => {
    const env = setupMockAudioEnvironment();
    const avSync = new AvSyncController();
    const player = new AudioPlayer(avSync);
    await player.unlock();

    player.handleAudioPacket(AUDIO_FLAGS.CONFIG, 0n, new Uint8Array(19));

    // Video is buffering: hold packets in overflowQueue
    avSync.setVideoBuffering(true);
    // Send only 1 packet (20ms < REBUFFER_CUSHION_SEC 80ms)
    player.handleAudioPacket(0, 1_000_000n, new Uint8Array(100));
    expect(env.scheduledSources.length).toBe(0);

    // Video exits buffering, but only 1 audio packet is buffered
    avSync.setVideoBuffering(false);
    player.syncWithVideo();

    // Must NOT start playing with insufficient cushion (< 80ms / < 4 packets)
    expect(env.scheduledSources.length).toBe(0);

    // Add 3 more packets to reach healthy cushion (4 packets = 80ms)
    player.handleAudioPacket(0, 1_020_000n, new Uint8Array(100));
    player.handleAudioPacket(0, 1_040_000n, new Uint8Array(100));
    player.handleAudioPacket(0, 1_060_000n, new Uint8Array(100));

    // Now syncWithVideo or incoming packet cleanly resumes playout
    player.syncWithVideo();
    expect(env.scheduledSources.length).toBe(4);

    player.close();
  });

  it('maintains continuous 100% duty-cycle and constant MasterGain volume across varying packet arrival jitter', async () => {
    const env = setupMockAudioEnvironment();
    const avSync = new AvSyncController();
    const player = new AudioPlayer(avSync);
    await player.unlock();

    player.handleAudioPacket(AUDIO_FLAGS.CONFIG, 0n, new Uint8Array(19));

    // Initial buffering
    for (let i = 0; i < 8; i++) {
      const pts = 1_000_000 + i * 20_000;
      env.setCtxTime(1.0 + i * 0.02);
      player.handleAudioPacket(0, BigInt(pts), new Uint8Array(100));
    }
    expect(env.scheduledSources.length).toBe(8);

    // Variable packet arrival intervals simulating LTE jitter: [10ms, 35ms, 15ms, 40ms, 10ms, 30ms]
    const jitterIntervals = [0.01, 0.035, 0.015, 0.04, 0.01, 0.03];
    let currentTime = 1.16;
    for (let i = 0; i < jitterIntervals.length; i++) {
      currentTime += jitterIntervals[i];
      env.setCtxTime(currentTime);
      const pts = 1_160_000 + i * 20_000;
      player.handleAudioPacket(0, BigInt(pts), new Uint8Array(100));
    }

    // All packets are scheduled
    expect(env.scheduledSources.length).toBe(8 + jitterIntervals.length);

    // Verify all scheduled sources are contiguous in hardware timeline
    for (let i = 1; i < env.scheduledSources.length; i++) {
      const prev = env.scheduledSources[i - 1];
      const curr = env.scheduledSources[i];
      expect(curr.startTime).toBeCloseTo(prev.startTime + 0.02, 3);
    }

    // Verify MasterGain volume is strictly preserved at 0.88 headroom
    expect(env.getMockGainNode().gain.value).toBe(0.88);
    expect(player.getVolume()).toBe(0.88);

    player.close();
  });
});
