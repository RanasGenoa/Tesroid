import { describe, expect, it } from 'vitest';
import { H264Parser } from '../src/core/h264-parser.js';

describe('H264Parser (Annex-B <-> AVCC & WebCodecs Configuration)', () => {
  it('extracts NAL units cleanly across mixed 3-byte and 4-byte Annex-B start codes', () => {
    expect(H264Parser.extractNalUnits(new Uint8Array([]))).toEqual([]);
    expect(H264Parser.extractNalUnits(new Uint8Array([0x11, 0x22, 0x33]))).toEqual([]);

    const bitstream = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x01,
      0x09,
      0x10, // AUD (type 9)
      0x00,
      0x00,
      0x00,
      0x01,
      0x67,
      0x42,
      0xc0,
      0x1f, // SPS (type 7)
      0x00,
      0x00,
      0x01,
      0x68,
      0xce,
      0x3c,
      0x80, // PPS (type 8, 3-byte start code)
      0x00,
      0x00,
      0x01,
      0x06,
      0x05,
      0x01,
      0xff, // SEI (type 6, 3-byte start code)
      0x00,
      0x00,
      0x00,
      0x01,
      0x65,
      0x88,
      0x84, // IDR (type 5)
    ]);

    const nals = H264Parser.extractNalUnits(bitstream);
    expect(nals.map((n) => n.type)).toEqual([9, 7, 8, 6, 5]);
    expect(Array.from(nals[1].data)).toEqual([0x67, 0x42, 0xc0, 0x1f]);
    expect(Array.from(nals[4].data)).toEqual([0x65, 0x88, 0x84]);
  });

  it('converts Annex-B to AVCC (4-byte BE length prefix), stripping SPS/PPS/AUD while retaining SEI and slices', () => {
    // 1. Config-only buffer (SPS + PPS + AUD) -> returns empty Uint8Array(0)
    const configOnly = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x09, 0x10, 0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xc0, 0x1f, 0x00,
      0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80,
    ]);
    expect(H264Parser.annexBToAvcc(configOnly).length).toBe(0);

    // 2. Full IDR Access Unit -> keeps SEI(6) + IDR(5) with 4-byte length prefixes
    const idrAu = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x01,
      0x67,
      0x42,
      0xc0,
      0x1f, // SPS (stripped)
      0x00,
      0x00,
      0x01,
      0x06,
      0xaa, // SEI (len 2)
      0x00,
      0x00,
      0x00,
      0x01,
      0x65,
      0x11,
      0x22,
      0x33, // IDR (len 4)
    ]);

    const avcc = H264Parser.annexBToAvcc(idrAu);
    expect(Array.from(avcc)).toEqual([
      0x00,
      0x00,
      0x00,
      0x02,
      0x06,
      0xaa, // 4B BE len=2 + SEI
      0x00,
      0x00,
      0x00,
      0x04,
      0x65,
      0x11,
      0x22,
      0x33, // 4B BE len=4 + IDR
    ]);
  });

  it('builds ISO/IEC 14496-15 AVCDecoderConfigurationRecord and codec strings, rejecting truncated SPS', () => {
    const sps = new Uint8Array([0x67, 0x64, 0x00, 0x28, 0xac]); // High Profile Level 4.0 -> avc1.640028
    const pps = new Uint8Array([0x68, 0xee, 0x3c, 0x80]);

    expect(H264Parser.getCodecString(sps)).toBe('avc1.640028');
    expect(H264Parser.getCodecString(new Uint8Array([0x67, 0x42, 0x00, 0x0a]))).toBe('avc1.42000a');

    const record = H264Parser.buildAVCDecoderConfigurationRecord(sps, pps);
    expect(record.length).toBe(11 + sps.length + pps.length);
    expect(record[0]).toBe(0x01); // configurationVersion
    expect(record[1]).toBe(0x64); // AVCProfileIndication
    expect(record[2]).toBe(0x00); // profile_compatibility
    expect(record[3]).toBe(0x28); // AVCLevelIndication
    expect(record[4]).toBe(0xff); // 4-byte NALU length size
    expect(record[5]).toBe(0xe1); // 1 SPS
    expect((record[6] << 8) | record[7]).toBe(sps.length);

    // Truncated SPS (< 4 bytes) must throw descriptive error instead of TypeError
    const truncated = new Uint8Array([0x67, 0x42]);
    expect(() => H264Parser.getCodecString(truncated)).toThrow(/Invalid SPS/);
    expect(() => H264Parser.buildAVCDecoderConfigurationRecord(truncated, pps)).toThrow(
      /Invalid SPS/,
    );
  });
});
