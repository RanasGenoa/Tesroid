import { WSS_CHANNEL } from './protocol.js';

export class MessageMultiplexer {
  /**
   * Pack Video frame into binary payload:
   * [Channel: 1B] [Flags: 1B] [PTS: 8B BigInt64BE] [H.264 Data: NB]
   */
  public static packVideo(flags: number, pts: bigint, data: Buffer): Buffer {
    const header = Buffer.alloc(10);
    header.writeUInt8(WSS_CHANNEL.VIDEO, 0);
    header.writeUInt8(flags, 1);
    header.writeBigInt64BE(pts, 2);
    return Buffer.concat([header, data]);
  }

  /**
   * Pack Audio packet into binary payload:
   * [Channel: 1B] [Flags: 1B] [PTS: 8B BigInt64BE] [Opus Data: NB]
   */
  public static packAudio(flags: number, pts: bigint, data: Buffer): Buffer {
    const header = Buffer.alloc(10);
    header.writeUInt8(WSS_CHANNEL.AUDIO, 0);
    header.writeUInt8(flags, 1);
    header.writeBigInt64BE(pts, 2);
    return Buffer.concat([header, data]);
  }

  /**
   * Pack JSON Control message:
   * [Channel: 1B] [JSON String UTF-8]
   */
  public static packControl(obj: unknown): Buffer {
    const jsonStr = JSON.stringify(obj);
    const jsonBuf = Buffer.from(jsonStr, 'utf-8');
    const header = Buffer.from([WSS_CHANNEL.CONTROL_RESPONSE]);
    return Buffer.concat([header, jsonBuf]);
  }
}
