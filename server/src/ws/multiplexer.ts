import { WSS_CHANNEL } from './protocol.js';

export class MessageMultiplexer {
  /**
   * Pack Video frame into binary payload:
   * [Channel: 1B] [Flags: 1B] [PTS: 8B BigInt64BE] [H.264 Data: NB]
   * Zero-intermediate allocation via allocUnsafe + direct copy.
   */
  public static packVideo(flags: number, pts: bigint, data: Buffer): Buffer {
    const buf = Buffer.allocUnsafe(10 + data.length);
    buf[0] = WSS_CHANNEL.VIDEO;
    buf[1] = flags;
    buf.writeBigInt64BE(pts, 2);
    data.copy(buf, 10);
    return buf;
  }

  /**
   * Pack Audio packet into binary payload:
   * [Channel: 1B] [Flags: 1B] [PTS: 8B BigInt64BE] [Opus Data: NB]
   * Zero-intermediate allocation via allocUnsafe + direct copy.
   */
  public static packAudio(flags: number, pts: bigint, data: Buffer): Buffer {
    const buf = Buffer.allocUnsafe(10 + data.length);
    buf[0] = WSS_CHANNEL.AUDIO;
    buf[1] = flags;
    buf.writeBigInt64BE(pts, 2);
    data.copy(buf, 10);
    return buf;
  }

  /**
   * Pack JSON Control message:
   * [Channel: 1B] [JSON String UTF-8]
   * Direct UTF-8 write without intermediate buffer concatenation.
   */
  public static packControl(obj: unknown): Buffer {
    const jsonStr = JSON.stringify(obj);
    const byteLength = Buffer.byteLength(jsonStr, 'utf-8');
    const buf = Buffer.allocUnsafe(1 + byteLength);
    buf[0] = WSS_CHANNEL.CONTROL_RESPONSE;
    buf.write(jsonStr, 1, byteLength, 'utf-8');
    return buf;
  }
}
