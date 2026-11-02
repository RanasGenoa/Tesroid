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
    const startCodes: { start: number; headerLen: number }[] = [];

    // Find 3-byte or 4-byte start codes (0x000001 or 0x00000001)
    for (let i = 0; i < len - 2; i++) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        const is4 = i > 0 && data[i - 1] === 0;
        startCodes.push({
          start: is4 ? i - 1 : i,
          headerLen: is4 ? 4 : 3,
        });
      }
    }

    const nalUnits: NalUnit[] = [];
    for (let i = 0; i < startCodes.length; i++) {
      const start = startCodes[i].start + startCodes[i].headerLen;
      const end = i + 1 < startCodes.length ? startCodes[i + 1].start : len;

      if (start < end) {
        const nalData = data.subarray(start, end);
        const type = nalData[0] & 0x1F;
        nalUnits.push({ type, data: nalData });
      }
    }

    return nalUnits;
  }

  /**
   * Convert Annex-B NAL units to AVCC format (4-byte length prefix)
   * Parameter sets (SPS/PPS) are filtered out since they are passed via AVCDecoderConfigurationRecord.
   */
  public static annexBToAvcc(data: Uint8Array): Uint8Array {
    const nalUnits = H264Parser.extractNalUnits(data);
    if (nalUnits.length === 0) return data;

    // In AVCC elementary stream, only slice/SEI NAL units are included in sample chunks.
    // SPS (7) and PPS (8) are in AVCDecoderConfigurationRecord, AUD (9) is Annex-B only.
    const slices = nalUnits.filter((n) => n.type !== 7 && n.type !== 8 && n.type !== 9);
    if (slices.length === 0) return new Uint8Array(0);

    let totalLength = 0;
    for (const s of slices) {
      totalLength += 4 + s.data.length;
    }

    const avcc = new Uint8Array(totalLength);
    let offset = 0;
    for (const s of slices) {
      const len = s.data.length;
      avcc[offset++] = (len >> 24) & 0xFF;
      avcc[offset++] = (len >> 16) & 0xFF;
      avcc[offset++] = (len >> 8) & 0xFF;
      avcc[offset++] = len & 0xFF;
      avcc.set(s.data, offset);
      offset += len;
    }

    return avcc;
  }

  /**
   * Build AVCDecoderConfigurationRecord for VideoDecoder.configure()
   * Input sps and pps MUST NOT contain start codes.
   */
  public static buildAVCDecoderConfigurationRecord(sps: Uint8Array, pps: Uint8Array): Uint8Array {
    const record = new Uint8Array(11 + sps.length + pps.length);
    let offset = 0;

    record[offset++] = 0x01; // configurationVersion
    record[offset++] = sps[1]; // AVCProfileIndication
    record[offset++] = sps[2]; // profile_compatibility
    record[offset++] = sps[3]; // AVCLevelIndication
    record[offset++] = 0xFF; // lengthSizeMinusOne = 3 (4 bytes)
    record[offset++] = 0xE1; // numOfSequenceParameterSets = 1
    record[offset++] = (sps.length >> 8) & 0xFF;
    record[offset++] = sps.length & 0xFF;
    record.set(sps, offset);
    offset += sps.length;

    record[offset++] = 0x01; // numOfPictureParameterSets = 1
    record[offset++] = (pps.length >> 8) & 0xFF;
    record[offset++] = pps.length & 0xFF;
    record.set(pps, offset);

    return record;
  }

  /**
   * Generate codec string (e.g. 'avc1.640028') from SPS bytes
   */
  public static getCodecString(sps: Uint8Array): string {
    const hexProfile = sps[1].toString(16).padStart(2, '0');
    const hexCompat = sps[2].toString(16).padStart(2, '0');
    const hexLevel = sps[3].toString(16).padStart(2, '0');
    return `avc1.${hexProfile}${hexCompat}${hexLevel}`;
  }
}
