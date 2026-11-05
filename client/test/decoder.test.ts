import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoStreamDecoder } from '../src/core/decoder.js';
import { VIDEO_FLAGS } from '../src/transport/protocol.js';

describe('VideoStreamDecoder - Reconnection & Keyframe Gate', () => {
  let mockTarget: any;
  let mockDecoderInstance: any;

  beforeEach(() => {
    mockTarget = vi.fn();
    let hasKeyframeAfterConfig = false;
    mockDecoderInstance = {
      configure: vi.fn(() => {
        hasKeyframeAfterConfig = false;
      }),
      decode: vi.fn((chunk: any) => {
        if (chunk.type === 'key') {
          hasKeyframeAfterConfig = true;
          mockDecoderInstance._init?.output?.({ timestamp: chunk.timestamp, close: vi.fn() });
        } else if (chunk.type === 'delta') {
          if (hasKeyframeAfterConfig) {
            mockDecoderInstance._init?.output?.({ timestamp: chunk.timestamp, close: vi.fn() });
          }
        }
      }),
      reset: vi.fn(() => {
        hasKeyframeAfterConfig = false;
      }),
      close: vi.fn(),
      decodeQueueSize: 0,
      state: 'configured',
    };

    // Mock global VideoDecoder and EncodedVideoChunk
    // 注意: 生産コードは new で呼ぶため、mockImplementation は矢印関数ではなく
    // 正規の function で定義せねばならない（矢印関数は new 不可）
    const mockConstructor: any = function (this: any, init: any) {
      mockDecoderInstance._init = init;
      return mockDecoderInstance;
    };
    mockConstructor.isConfigSupported = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { supported: true };
    });
    (globalThis as any).VideoDecoder = mockConstructor;
    const chunkCtor: any = function (this: any, init: any) {
      return init;
    };
    (globalThis as any).EncodedVideoChunk = chunkCtor;
  });

  it('should drop delta frames after initialization until a keyframe arrives', async () => {
    const decoder = new VideoStreamDecoder(mockTarget);

    // Feed SPS (NAL 7) + PPS (NAL 8) + IDR (NAL 5) packet to configure
    // Annex-B format: 0x00, 0x00, 0x00, 0x01, <NAL>
    const spsPpsData = new Uint8Array([
      0,
      0,
      0,
      1,
      0x67,
      0x42,
      0xc0,
      0x1f, // SPS
      0,
      0,
      0,
      1,
      0x68,
      0xce,
      0x3c,
      0x80, // PPS
    ]);

    // Send config packet without slices
    await decoder.handlePacket(VIDEO_FLAGS.CONFIG, 0n, spsPpsData);
    await new Promise((r) => setTimeout(r, 15));
    expect(mockDecoderInstance.configure).toHaveBeenCalled();

    // Now send a DELTA frame (not a keyframe)
    const deltaFrameData = new Uint8Array([
      0,
      0,
      0,
      1,
      0x41,
      0x9a,
      0x12,
      0x34, // P-slice (NAL 1)
    ]);
    await decoder.handlePacket(0, 1000n, deltaFrameData);

    // Delta frame must be dropped because no keyframe arrived yet
    expect(mockDecoderInstance.decode).not.toHaveBeenCalled();

    // Now send a KEYFRAME
    const keyframeData = new Uint8Array([
      0,
      0,
      0,
      1,
      0x65,
      0x88,
      0x84,
      0x00, // IDR slice (NAL 5)
    ]);
    await decoder.handlePacket(VIDEO_FLAGS.KEYFRAME, 2000n, keyframeData);

    // Keyframe must be decoded
    expect(mockDecoderInstance.decode).toHaveBeenCalledTimes(1);

    // Subsequent DELTA frames should now be allowed
    await decoder.handlePacket(0, 3000n, deltaFrameData);
    expect(mockDecoderInstance.decode).toHaveBeenCalledTimes(2);
  });

  it('should reset keyframe gate on decoder.reset() and drop subsequent deltas until new keyframe', async () => {
    const decoder = new VideoStreamDecoder(mockTarget);

    const spsPpsKeyData = new Uint8Array([
      0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 0, 1, 0x65,
      0x88, 0x84, 0x00,
    ]);
    decoder.handlePacket(VIDEO_FLAGS.CONFIG | VIDEO_FLAGS.KEYFRAME, 1000n, spsPpsKeyData);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockDecoderInstance.decode).toHaveBeenCalledTimes(1);

    // Reset decoder (simulating WS disconnect / reconnect)
    decoder.reset();
    expect(mockDecoderInstance.reset).toHaveBeenCalledTimes(1);

    // Send delta frame after reset -> must be dropped
    const deltaFrameData = new Uint8Array([0, 0, 0, 1, 0x41, 0x9a, 0x12, 0x34]);
    decoder.handlePacket(0, 2000n, deltaFrameData);
    expect(mockDecoderInstance.decode).toHaveBeenCalledTimes(1); // Still 1

    // Re-send config + keyframe -> now decoded
    decoder.handlePacket(VIDEO_FLAGS.CONFIG | VIDEO_FLAGS.KEYFRAME, 3000n, spsPpsKeyData);
    await new Promise((r) => setTimeout(r, 15));
    expect(mockDecoderInstance.decode).toHaveBeenCalledTimes(2);
  });

  it('should deliver onFrameOutput for every frame (IDR and delta) across GOP boundaries without falling into 0.5fps', async () => {
    const decoder = new VideoStreamDecoder(mockTarget);

    const spsPpsKeyData = new Uint8Array([
      0,
      0,
      0,
      1,
      0x67,
      0x42,
      0xc0,
      0x1f, // SPS
      0,
      0,
      0,
      1,
      0x68,
      0xce,
      0x3c,
      0x80, // PPS
      0,
      0,
      0,
      1,
      0x65,
      0x88,
      0x84,
      0x00, // IDR
    ]);
    const deltaFrameData1 = new Uint8Array([
      0,
      0,
      0,
      1,
      0x41,
      0x9a,
      0x12,
      0x34, // Delta 1
    ]);
    const deltaFrameData2 = new Uint8Array([
      0,
      0,
      0,
      1,
      0x41,
      0x9a,
      0x12,
      0x56, // Delta 2
    ]);

    // 1. Initial GOP: CONFIG + KEYFRAME
    await decoder.handlePacket(VIDEO_FLAGS.CONFIG | VIDEO_FLAGS.KEYFRAME, 1000n, spsPpsKeyData);
    await new Promise((r) => setTimeout(r, 20)); // wait for configureDecoder
    expect(mockTarget).toHaveBeenCalledTimes(1);

    // 2. Deliver deltas in 1st GOP
    await decoder.handlePacket(0, 1033n, deltaFrameData1);
    await decoder.handlePacket(0, 1066n, deltaFrameData2);
    expect(mockTarget).toHaveBeenCalledTimes(3);

    // 3. Second GOP: arrives with identical SPS/PPS + CONFIG | KEYFRAME
    // In buggy code: isConfig=true forces needsConfig=true -> calls configureDecoder again,
    // which does NOT await because isConfigured is true, causing configure() to race and reset the codec
    // after the IDR is decoded, dropping subsequent deltas!
    await decoder.handlePacket(VIDEO_FLAGS.CONFIG | VIDEO_FLAGS.KEYFRAME, 2000n, spsPpsKeyData);
    await new Promise((r) => setTimeout(r, 20)); // allow any background async configure to settle
    expect(mockTarget).toHaveBeenCalledTimes(4);

    // 4. Deliver deltas in 2nd GOP -> In buggy code, these are dropped by codec reset!
    await decoder.handlePacket(0, 2033n, deltaFrameData1);
    await decoder.handlePacket(0, 2066n, deltaFrameData2);

    // ALL 6 frames must be delivered to mockTarget (onFrameOutput)
    expect(mockTarget).toHaveBeenCalledTimes(6);
  });

  it('should properly await configure on resolution change and deliver both keyframe and deltas', async () => {
    const decoder = new VideoStreamDecoder(mockTarget);

    const spsPpsKeyDataInitial = new Uint8Array([
      0,
      0,
      0,
      1,
      0x67,
      0x42,
      0xc0,
      0x1f, // SPS 1
      0,
      0,
      0,
      1,
      0x68,
      0xce,
      0x3c,
      0x80, // PPS 1
      0,
      0,
      0,
      1,
      0x65,
      0x88,
      0x84,
      0x00, // IDR
    ]);

    // Resized resolution (different SPS)
    const spsPpsKeyDataResized = new Uint8Array([
      0,
      0,
      0,
      1,
      0x67,
      0x42,
      0xc0,
      0x28, // SPS 2 (level changed)
      0,
      0,
      0,
      1,
      0x68,
      0xce,
      0x3c,
      0x80, // PPS 2
      0,
      0,
      0,
      1,
      0x65,
      0x88,
      0x84,
      0x00, // IDR
    ]);

    const deltaFrameData = new Uint8Array([
      0,
      0,
      0,
      1,
      0x41,
      0x9a,
      0x12,
      0x34, // Delta
    ]);

    // Initial setup
    await decoder.handlePacket(
      VIDEO_FLAGS.CONFIG | VIDEO_FLAGS.KEYFRAME,
      1000n,
      spsPpsKeyDataInitial,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(mockTarget).toHaveBeenCalledTimes(1);

    // Delta after initial
    await decoder.handlePacket(0, 1033n, deltaFrameData);
    expect(mockTarget).toHaveBeenCalledTimes(2);

    // Dynamic resize happens: new SPS arrives with IDR
    // In buggy code: configPromise is NOT awaited because isConfigured is true!
    // The IDR is decoded on old config, then configure() completes and resets the codec,
    // causing subsequent deltas to be dropped!
    await decoder.handlePacket(
      VIDEO_FLAGS.CONFIG | VIDEO_FLAGS.KEYFRAME,
      2000n,
      spsPpsKeyDataResized,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(mockTarget).toHaveBeenCalledTimes(3);

    // Delta after resize
    await decoder.handlePacket(0, 2033n, deltaFrameData);
    expect(mockTarget).toHaveBeenCalledTimes(4);
  });

  it('should manage prefetch buffer depth, byte size, and trim on limit exceed', async () => {
    const downstreamQueueLength = 100; // Simulate downstream busy/full so packets are queued in pendingPackets
    const decoder = new VideoStreamDecoder({
      queueFrame: vi.fn(),
      getQueueLength: () => downstreamQueueLength,
    });

    // Configure 2000ms / 500KB buffer (e.g. Intel MCU2 profile)
    decoder.setBufferDepth({ targetDurationMs: 2000, maxBytes: 500 * 1024 });
    expect(decoder.getTargetPendingDurationMs()).toBe(2000);
    expect(decoder.getMaxPendingDurationMs()).toBeGreaterThanOrEqual(2000);
    expect(decoder.getMaxPendingBytes()).toBe(500 * 1024);

    const spsPpsKeyData = new Uint8Array([
      0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 0, 1, 0x65,
      0x88, 0x84, 0x00,
    ]);
    const deltaFrameData = new Uint8Array([0, 0, 0, 1, 0x41, 0x9a, 0x12, 0x34]);

    // Enqueue packets into pending
    await decoder.handlePacket(
      VIDEO_FLAGS.CONFIG | VIDEO_FLAGS.KEYFRAME,
      1_000_000n,
      spsPpsKeyData,
    );
    await decoder.handlePacket(0, 1_033_000n, deltaFrameData);
    await decoder.handlePacket(0, 1_066_000n, deltaFrameData);

    expect(decoder.getPendingPacketsCount()).toBe(3);
    expect(decoder.getPendingBytes()).toBeGreaterThan(0);
    expect(decoder.getPendingBufferedMs()).toBe(66);

    // Clear pending packets
    decoder.clearPendingPackets();
    expect(decoder.getPendingPacketsCount()).toBe(0);
    expect(decoder.getPendingBytes()).toBe(0);
    expect(decoder.getPendingBufferedMs()).toBe(0);
  });
});
