export interface NalUnit {
  type: number;
  data: Uint8Array;
}

export class H264Parser {
  /**
   * Extract NAL units from Annex-B bitstream
   */
  public static extractNalUnits(data: Uint8Array): NalUnit[] {
    const len = data.length;
    if (len < 3) return [];

    const nalUnits: NalUnit[] = [];
    let prevNalStart = -1;
    let prevNalHeaderLen = 0;

    // Single-pass scan for 3-byte or 4-byte start codes (0x000001 or 0x00000001)
    for (let i = 0; i < len - 2; i++) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        const is4 = i > 0 && data[i - 1] === 0;
        const curStart = is4 ? i - 1 : i;
        const curHeaderLen = is4 ? 4 : 3;

        if (prevNalStart !== -1) {
          const start = prevNalStart + prevNalHeaderLen;
          const end = curStart;
          if (start < end) {
            const nalData = data.subarray(start, end);
            nalUnits.push({ type: nalData[0] & 0x1f, data: nalData });
          }
        }

        prevNalStart = curStart;
        prevNalHeaderLen = curHeaderLen;
      }
    }

    if (prevNalStart !== -1) {
      const start = prevNalStart + prevNalHeaderLen;
      const end = len;
      if (start < end) {
        const nalData = data.subarray(start, end);
        nalUnits.push({ type: nalData[0] & 0x1f, data: nalData });
      }
    }

    return nalUnits;
  }

  /**
   * Convert Annex-B NAL units to AVCC format (4-byte length prefix)
   * Parameter sets (SPS/PPS) are filtered out since they are passed via AVCDecoderConfigurationRecord.
   * Optimized single-pass parser with zero intermediate object allocations.
   */
  public static annexBToAvcc(data: Uint8Array): Uint8Array {
    const len = data.length;
    if (len < 4) return data;

    // Flat array to store slice boundary pairs [nalStart, nalEnd] without object wrappers
    const sliceOffsets: number[] = [];
    let totalLength = 0;
    let prevNalStart = -1;
    let prevNalHeaderLen = 0;

    for (let i = 0; i < len - 2; i++) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        const is4 = i > 0 && data[i - 1] === 0;
        const curStart = is4 ? i - 1 : i;
        const curHeaderLen = is4 ? 4 : 3;

        if (prevNalStart !== -1) {
          const nalStart = prevNalStart + prevNalHeaderLen;
          const nalEnd = curStart;
          if (nalStart < nalEnd) {
            const type = data[nalStart] & 0x1f;
            // Filter out SPS (7), PPS (8), AUD (9)
            if (type !== 7 && type !== 8 && type !== 9) {
              sliceOffsets.push(nalStart, nalEnd);
              totalLength += 4 + (nalEnd - nalStart);
            }
          }
        }

        prevNalStart = curStart;
        prevNalHeaderLen = curHeaderLen;
      }
    }

    if (prevNalStart !== -1) {
      const nalStart = prevNalStart + prevNalHeaderLen;
      const nalEnd = len;
      if (nalStart < nalEnd) {
        const type = data[nalStart] & 0x1f;
        if (type !== 7 && type !== 8 && type !== 9) {
          sliceOffsets.push(nalStart, nalEnd);
          totalLength += 4 + (nalEnd - nalStart);
        }
      }
    } else {
      // No start code found in buffer
      return data;
    }

    if (sliceOffsets.length === 0) {
      return new Uint8Array(0);
    }

    const avcc = new Uint8Array(totalLength);
    let offset = 0;
    for (let i = 0; i < sliceOffsets.length; i += 2) {
      const nalStart = sliceOffsets[i];
      const nalEnd = sliceOffsets[i + 1];
      const nalLen = nalEnd - nalStart;

      avcc[offset++] = (nalLen >>> 24) & 0xff;
      avcc[offset++] = (nalLen >>> 16) & 0xff;
      avcc[offset++] = (nalLen >>> 8) & 0xff;
      avcc[offset++] = nalLen & 0xff;
      avcc.set(data.subarray(nalStart, nalEnd), offset);
      offset += nalLen;
    }

    return avcc;
  }

  /**
   * Build AVCDecoderConfigurationRecord for VideoDecoder.configure()
   * Input sps and pps MUST NOT contain start codes.
   */
  public static buildAVCDecoderConfigurationRecord(sps: Uint8Array, pps: Uint8Array): Uint8Array {
    if (sps.length < 4) {
      throw new Error('Invalid SPS: length must be at least 4 bytes');
    }
    const record = new Uint8Array(11 + sps.length + pps.length);
    let offset = 0;

    record[offset++] = 0x01; // configurationVersion
    record[offset++] = sps[1]; // AVCProfileIndication
    record[offset++] = sps[2]; // profile_compatibility
    record[offset++] = sps[3]; // AVCLevelIndication
    record[offset++] = 0xff; // lengthSizeMinusOne = 3 (4 bytes)
    record[offset++] = 0xe1; // numOfSequenceParameterSets = 1
    record[offset++] = (sps.length >> 8) & 0xff;
    record[offset++] = sps.length & 0xff;
    record.set(sps, offset);
    offset += sps.length;

    record[offset++] = 0x01; // numOfPictureParameterSets = 1
    record[offset++] = (pps.length >> 8) & 0xff;
    record[offset++] = pps.length & 0xff;
    record.set(pps, offset);

    return record;
  }

  /**
   * Generate codec string (e.g. 'avc1.640028') from SPS bytes
   */
  public static getCodecString(sps: Uint8Array): string {
    if (sps.length < 4) {
      throw new Error('Invalid SPS: length must be at least 4 bytes');
    }
    const hexProfile = sps[1].toString(16).padStart(2, '0');
    const hexCompat = sps[2].toString(16).padStart(2, '0');
    const hexLevel = sps[3].toString(16).padStart(2, '0');
    return `avc1.${hexProfile}${hexCompat}${hexLevel}`;
  }
}
