import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaapiEncoder } from '../src/encoder/ffmpeg.js';
import { AUDIO_FLAGS, VIDEO_FLAGS } from '../src/ws/protocol.js';

function buildOggPage(segments: Buffer[], magic: string = 'OggS'): Buffer {
  const segmentTable: number[] = [];
  const payloadParts: Buffer[] = [];

  for (const packet of segments) {
    let offset = 0;
    while (offset < packet.length) {
      const remaining = packet.length - offset;
      if (remaining >= 255) {
        segmentTable.push(255);
        payloadParts.push(packet.subarray(offset, offset + 255));
        offset += 255;
      } else {
        segmentTable.push(remaining);
        payloadParts.push(packet.subarray(offset));
        offset = packet.length;
      }
    }
    // Exact multiple of 255 requires a trailing 0-length lacing byte to terminate packet
    if (packet.length > 0 && packet.length % 255 === 0) {
      segmentTable.push(0);
    }
  }

  const header = Buffer.alloc(27 + segmentTable.length);
  header.write(magic, 0, 'ascii');
  header[4] = 0; // version
  header[26] = segmentTable.length;
  for (let i = 0; i < segmentTable.length; i++) {
    header[27 + i] = segmentTable[i];
  }

  return Buffer.concat([header, ...payloadParts]);
}

describe('VaapiEncoder H.264 Annex-B & OggOpus Stream Parsers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses Annex-B H.264 stream (SPS + PPS + AUD + IDR + P-frame) even when fragmented at 1-byte and 7-byte boundaries', () => {
    // 4-byte and 3-byte start codes mixed:
    // AU 1 (IDR + config): AUD(9) + SPS(7) + PPS(8) + IDR(5)
    // AU 2 (Delta P):      AUD(9) + Non-IDR(1)
    // Trailing AUD(9) to flush AU 2
    const annexBStream = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0x10]), // AUD
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xc0, 0x1f, 0xda]), // SPS (type 7)
      Buffer.from([0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80]), // PPS (type 8, 3-byte start code)
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x21, 0xa0]), // IDR slice (type 5)
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0x30]), // AUD -> flushes AU 1!
      Buffer.from([0x00, 0x00, 0x01, 0x41, 0x9a, 0x22, 0x11, 0x05]), // P-slice (type 1, 3-byte start code)
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0x30, 0x00, 0x00, 0x00, 0x01, 0x06]), // AUD + trailing bytes so scanner reaches last start code
    ]);

    for (const chunkSize of [annexBStream.length, 7, 1]) {
      const encoder = new VaapiEncoder();
      const emitted: Array<{ flags: number; pts: bigint; data: Buffer }> = [];
      encoder.on('video', (pkt) => emitted.push(pkt));

      for (let i = 0; i < annexBStream.length; i += chunkSize) {
        (encoder as any).handleVideoChunk(annexBStream.subarray(i, i + chunkSize));
      }

      expect(emitted).toHaveLength(3);
      // Packet 1: Parameter sets (CONFIG) in Annex-B
      expect(emitted[0].flags).toBe(VIDEO_FLAGS.CONFIG);
      expect(encoder.getCachedSpsPps()).not.toBeNull();

      // Packet 2: IDR Keyframe in AVCC format (4-byte length prefix)
      expect(emitted[1].flags).toBe(VIDEO_FLAGS.KEYFRAME | VIDEO_FLAGS.AVCC);
      expect(encoder.getCachedKeyframe()).not.toBeNull();
      // Length prefix must match IDR payload length (5 bytes)
      expect(emitted[1].data.readUInt32BE(0)).toBe(5);
      expect(emitted[1].data.subarray(4)).toEqual(Buffer.from([0x65, 0x88, 0x84, 0x21, 0xa0]));

      // Packet 3: Delta P-frame in AVCC format (4-byte length prefix)
      expect(emitted[2].flags).toBe(VIDEO_FLAGS.AVCC);
      expect(emitted[2].data.readUInt32BE(0)).toBe(5);
      expect(emitted[2].data.subarray(4)).toEqual(Buffer.from([0x41, 0x9a, 0x22, 0x11, 0x05]));
    }
  });

  it('flushes Access Units on fallback slice boundary when AUD NALs are absent', () => {
    const encoder = new VaapiEncoder();
    const emitted: Array<{ flags: number; data: Buffer }> = [];
    encoder.on('video', (pkt) => emitted.push(pkt));

    const noAudStream = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x11, 0x22, 0x33]), // IDR 1
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, 0x44, 0x55, 0x66]), // P-slice -> flushes IDR 1
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, 0x77, 0x88, 0x99, 0x00, 0x00, 0x00, 0x01, 0x01]), // flushes P-slice 1
    ]);

    (encoder as any).handleVideoChunk(noAudStream);
    expect(emitted).toHaveLength(2);
    expect(emitted[0].flags).toBe(VIDEO_FLAGS.KEYFRAME | VIDEO_FLAGS.AVCC);
    expect(emitted[0].data.readUInt32BE(0)).toBe(4);
    expect(emitted[1].flags).toBe(VIDEO_FLAGS.AVCC);
    expect(emitted[1].data.readUInt32BE(0)).toBe(4);
  });

  it('packs multiple slices within a single Access Unit into a contiguous AVCC buffer with 4-byte length prefixes', () => {
    const encoder = new VaapiEncoder();
    const emitted: Array<{ flags: number; data: Buffer }> = [];
    encoder.on('video', (pkt) => emitted.push(pkt));

    // Access Unit with AUD + IDR slice 1 (4 bytes payload) + IDR slice 2 (3 bytes payload) + AUD (flush)
    const multiSliceStream = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0x10]), // AUD
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0xaa, 0xbb, 0xcc]), // IDR Slice 1 (4 bytes)
      Buffer.from([0x00, 0x00, 0x01, 0x65, 0xdd, 0xee]), // IDR Slice 2 (3 bytes)
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0x10]), // AUD -> flushes AU
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x06]), // trailing bytes
    ]);

    (encoder as any).handleVideoChunk(multiSliceStream);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].flags).toBe(VIDEO_FLAGS.KEYFRAME | VIDEO_FLAGS.AVCC);

    // Total length: (4 + 4) + (4 + 3) = 15 bytes
    expect(emitted[0].data.length).toBe(15);

    // Slice 1: length prefix = 4
    expect(emitted[0].data.readUInt32BE(0)).toBe(4);
    expect(emitted[0].data.subarray(4, 8)).toEqual(Buffer.from([0x65, 0xaa, 0xbb, 0xcc]));

    // Slice 2: length prefix = 3
    expect(emitted[0].data.readUInt32BE(8)).toBe(3);
    expect(emitted[0].data.subarray(12, 15)).toEqual(Buffer.from([0x65, 0xdd, 0xee]));

    // Verify 100% byte-exact coverage (no uninitialized memory gaps)
    const expectedFullBuffer = Buffer.from([
      0x00, 0x00, 0x00, 0x04, 0x65, 0xaa, 0xbb, 0xcc, 0x00, 0x00, 0x00, 0x03, 0x65, 0xdd, 0xee,
    ]);
    expect(emitted[0].data).toEqual(expectedFullBuffer);
  });

  it('parses OggOpus pages (OpusHead, OpusTags skip, >255B multi-lacing audio, chunk splits, and OggS resync)', () => {
    const opusHead = Buffer.concat([Buffer.from('OpusHead', 'ascii'), Buffer.alloc(11, 0x02)]); // 19 bytes
    const opusTags = Buffer.concat([
      Buffer.from('OpusTags', 'ascii'),
      Buffer.from('TesroidEncoder'),
    ]);
    const smallAudio = Buffer.alloc(80, 0xaa);
    const largeMultiSegmentAudio = Buffer.alloc(300, 0x55); // 255 + 45 lacing segments

    const garbagePrefix = Buffer.from('JUNK_BYTES_BEFORE_SYNC');
    const oggStream = Buffer.concat([
      garbagePrefix,
      buildOggPage([opusHead]),
      buildOggPage([opusTags]),
      buildOggPage([smallAudio, largeMultiSegmentAudio]),
    ]);

    for (const chunkSize of [oggStream.length, 13, 3]) {
      const encoder = new VaapiEncoder();
      const audioEvents: Array<{ flags: number; pts: bigint; data: Buffer }> = [];
      encoder.on('audio', (pkt) => audioEvents.push(pkt));

      for (let i = 0; i < oggStream.length; i += chunkSize) {
        (encoder as any).handleAudioChunk(oggStream.subarray(i, i + chunkSize));
      }

      // OpusTags must be filtered out; OpusHead + 2 audio packets emitted = 3 events
      expect(audioEvents).toHaveLength(3);
      expect(audioEvents[0].flags).toBe(AUDIO_FLAGS.CONFIG);
      expect(audioEvents[0].pts).toBe(0n);
      expect(audioEvents[0].data).toEqual(opusHead);
      expect(encoder.getCachedOpusHead()).toEqual(opusHead);

      expect(audioEvents[1].flags).toBe(AUDIO_FLAGS.KEYFRAME);
      expect(audioEvents[1].data).toEqual(smallAudio);

      expect(audioEvents[2].flags).toBe(AUDIO_FLAGS.KEYFRAME);
      expect(audioEvents[2].data.length).toBe(300);
      expect(audioEvents[2].data).toEqual(largeMultiSegmentAudio);
    }
  });

  it('parses bitrate strings/numbers accurately and distinguishes video-only restart() from full restartAll()', async () => {
    const encoder = new VaapiEncoder({ width: 1280, height: 720, fps: 30, bitrate: '1500k' });
    const parseBps = (v: string | number) => (encoder as any).parseBitrateBps(v);

    expect(parseBps(2500000)).toBe(2500000);
    expect(parseBps('2500k')).toBe(2500000);
    expect(parseBps('4m')).toBe(4000000);
    expect(parseBps('800000')).toBe(800000);
    expect(parseBps('invalid')).toBe(1000000);

    // Mock startVideo / stopVideo / startAudio / stopAudio to avoid spawning real ffmpeg
    const startVideoSpy = vi.spyOn(encoder as any, 'startVideo').mockImplementation(() => {});
    const stopVideoSpy = vi.spyOn(encoder as any, 'stopVideo').mockImplementation(() => {});
    const startAudioSpy = vi.spyOn(encoder as any, 'startAudio').mockImplementation(() => {});
    const stopAudioSpy = vi.spyOn(encoder as any, 'stopAudio').mockImplementation(() => {});

    // Seed caches
    const fakeOpusHead = Buffer.from('OpusHead01234567890');
    (encoder as any).cachedOpusHead = fakeOpusHead;
    (encoder as any).cachedSpsPps = Buffer.from([1, 2, 3]);
    (encoder as any).cachedKeyframe = { data: Buffer.from([4, 5]), pts: 100n };

    // 1. restart() must ONLY restart video (leaving audio & cachedOpusHead completely undisturbed!)
    await encoder.restart(1921, 1081, 60, '3000k');
    expect(stopVideoSpy).toHaveBeenCalledTimes(1);
    expect(startVideoSpy).toHaveBeenCalledTimes(1);
    expect(stopAudioSpy).not.toHaveBeenCalled();
    expect(startAudioSpy).not.toHaveBeenCalled();
    expect(encoder.getCachedOpusHead()).toEqual(fakeOpusHead);
    expect(encoder.getCachedSpsPps()).toBeNull();
    // Odd dimensions aligned to even (& ~1)
    expect((encoder as any).width).toBe(1920);
    expect((encoder as any).height).toBe(1080);

    // 2. restartAll() must restart BOTH video and audio and reset OpusHead + PTS baseline
    await encoder.restartAll(1280, 720, 30, 1000000);
    expect(stopAudioSpy).toHaveBeenCalledTimes(1);
    expect(startAudioSpy).toHaveBeenCalledTimes(1);
    expect(encoder.getCachedOpusHead()).toBeNull();
    expect((encoder as any).videoPts).toBe(0n);
    expect((encoder as any).audioPts).toBe(0n);
  });
});
