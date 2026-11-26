import { describe, expect, it } from 'vitest';
import { ClientProtocol } from '../src/transport/protocol.js';

// Issue #106: BUFFER_FEEDBACK に音声キュー滞留を含め、サーバー側のスライディングウィンドウが
// 実滞留時間を過小評価しないためのフィールド追加（後方互換: 旧サーバーは未知フィールドを無視）。
describe('Issue #106: BUFFER_FEEDBACK audioBufferedMs field', () => {
  const unpack = (buf: Uint8Array): any =>
    JSON.parse(Buffer.from(buf.subarray(1)).toString('utf-8'));

  it('audioBufferedMs 指定時は非負整数としてペイロードに含める', () => {
    const payload = unpack(
      ClientProtocol.packBufferFeedback({
        bufferedMs: 100,
        audioBufferedMs: 250.7,
        targetBufferMs: 10000,
      }),
    );
    expect(payload.type).toBe('BUFFER_FEEDBACK');
    expect(payload.bufferedMs).toBe(100);
    expect(payload.audioBufferedMs).toBe(251);
  });

  it('未指定・非有限値のフィールドなしペイロードは従来形のまま（後方互換）', () => {
    const legacy = unpack(
      ClientProtocol.packBufferFeedback({ bufferedMs: 100, targetBufferMs: 10000 }),
    );
    expect('audioBufferedMs' in legacy).toBe(false);

    const nan = unpack(
      ClientProtocol.packBufferFeedback({
        bufferedMs: 100,
        audioBufferedMs: Number.NaN,
        targetBufferMs: 10000,
      }),
    );
    expect('audioBufferedMs' in nan).toBe(false);
  });

  it('負値は 0 にクランプする', () => {
    const payload = unpack(
      ClientProtocol.packBufferFeedback({
        bufferedMs: 100,
        audioBufferedMs: -42,
        targetBufferMs: 10000,
      }),
    );
    expect(payload.audioBufferedMs).toBe(0);
  });
});
