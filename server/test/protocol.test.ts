import { describe, expect, it } from 'vitest';
import { MessageMultiplexer } from '../src/ws/multiplexer.js';
import { AUDIO_FLAGS, VIDEO_FLAGS, WSS_CHANNEL } from '../src/ws/protocol.js';

describe('WebSocket Protocol & Multiplexer', () => {
  it('should pack video frame with channel, flags, pts and data', () => {
    const data = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]);
    const pts = 12345678n;
    const packet = MessageMultiplexer.packVideo(VIDEO_FLAGS.CONFIG, pts, data);

    expect(packet[0]).toBe(WSS_CHANNEL.VIDEO);
    expect(packet[1]).toBe(VIDEO_FLAGS.CONFIG);
    expect(packet.readBigInt64BE(2)).toBe(pts);
    expect(packet.subarray(10)).toEqual(data);
  });

  it('should pack audio packet with channel, flags, pts and data', () => {
    const data = Buffer.from([0x12, 0x34, 0x56]);
    const pts = 87654321n;
    const packet = MessageMultiplexer.packAudio(AUDIO_FLAGS.KEYFRAME, pts, data);

    expect(packet[0]).toBe(WSS_CHANNEL.AUDIO);
    expect(packet[1]).toBe(AUDIO_FLAGS.KEYFRAME);
    expect(packet.readBigInt64BE(2)).toBe(pts);
    expect(packet.subarray(10)).toEqual(data);
  });

  it('should pack control JSON message', () => {
    const obj = { type: 'BROWSER_STATUS', state: 'running' };
    const packet = MessageMultiplexer.packControl(obj);

    expect(packet[0]).toBe(WSS_CHANNEL.CONTROL_RESPONSE);
    const parsed = JSON.parse(packet.subarray(1).toString('utf-8'));
    expect(parsed).toEqual(obj);
  });
});
