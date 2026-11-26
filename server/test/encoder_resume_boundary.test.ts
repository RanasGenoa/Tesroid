/**
 * Issue #111 F-4 回帰ガード: 復帰後 A/V 境界は PTS 基準。
 * 実機 f1check (2026-11-26) で時間ゲート (1500ms) 先行開放による ±1s の音声先行が
 * A/V オフセット残留として観測されたため、(1) IDR 到達までの音声破棄、(2) 最初の IDR PTS
 * 未満の straggler 音声破棄、(3) JUMP 権威 PTS 境界、(4) 新 PTS エポックでの境界消去を固定する。
 */
import { describe, expect, it } from 'vitest';
import { VaapiEncoder } from '../src/encoder/ffmpeg.js';
import { AUDIO_FLAGS, VIDEO_FLAGS } from '../src/ws/protocol.js';

function buildOggPage(segments: Buffer[]): Buffer {
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
  }
  const header = Buffer.alloc(27 + segmentTable.length);
  header.write('OggS', 0, 'ascii');
  header[4] = 0;
  header[26] = segmentTable.length;
  for (let i = 0; i < segmentTable.length; i++) {
    header[27 + i] = segmentTable[i];
  }
  return Buffer.concat([header, ...payloadParts]);
}

// 末尾の追加 AU 境界で IDR AU がフラッシュされる（単体テストの既存ストリームと同形）
const IDR_AU = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0x10]), // AUD
  Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xc0, 0x1f, 0xda]), // SPS
  Buffer.from([0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80]), // PPS
  Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x21, 0xa0]), // IDR slice
  Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0x30]), // AUD -> flushes IDR AU
  Buffer.from([0x00, 0x00, 0x01, 0x41, 0x9a, 0x22, 0x11, 0x05]), // P-slice
  Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0x30, 0x00, 0x00, 0x00, 0x01, 0x06]), // AUD + SEI で P をフラッシュ
]);

function opusPage(): Buffer {
  return buildOggPage([Buffer.from([0x01, 0xfe, 0xfc, 0xfb, 0x01])]);
}

function setWallBaseline(encoder: VaapiEncoder, ptsUs: bigint): void {
  (encoder as any).streamStartTimeUs = BigInt(Math.round(performance.now() * 1000)) - ptsUs;
}

describe('VaapiEncoder resume A/V boundary (Issue #111 F-4)', () => {
  it('discards audio until the first video IDR after armResumeGate, then lets post-IDR audio through', () => {
    const encoder = new VaapiEncoder();
    setWallBaseline(encoder, 20_000_000n);

    const audio: Array<{ flags: number; pts: bigint }> = [];
    const video: Array<{ flags: number; pts: bigint }> = [];
    encoder.on('audio', (pkt) => audio.push(pkt));
    encoder.on('video', (pkt) => video.push(pkt));

    encoder.armResumeGate(60000);
    (encoder as any).handleAudioChunk(opusPage());
    expect(audio).toHaveLength(0); // IDR 前の先行音声は破棄

    (encoder as any).handleVideoChunk(IDR_AU);
    const idr = video.find((v) => (v.flags & VIDEO_FLAGS.KEYFRAME) !== 0);
    expect(idr).toBeDefined();

    (encoder as any).handleAudioChunk(opusPage());
    expect(audio).toHaveLength(1); // IDR 以降の音声は通過
    expect(audio[0].pts >= idr!.pts).toBe(true);
    expect(audio[0].flags).toBe(AUDIO_FLAGS.KEYFRAME);
  });

  it('setResumeBoundary drops straggler audio below the authoritative PTS and clears once passed', () => {
    const encoder = new VaapiEncoder();
    setWallBaseline(encoder, 4_000_000n); // 現在 wall pts ≈ 4.0s

    const audio: Array<{ pts: bigint }> = [];
    encoder.on('audio', (pkt) => audio.push(pkt));

    encoder.setResumeBoundary(5_000_000n);
    (encoder as any).handleAudioChunk(opusPage());
    expect(audio).toHaveLength(0); // 4.0s < 境界 5.0s → 破棄

    setWallBaseline(encoder, 6_000_000n); // wall pts ≈ 6.0s
    (encoder as any).handleAudioChunk(opusPage());
    expect(audio).toHaveLength(1); // 境界超過で通過し、境界は解除される

    (encoder as any).handleAudioChunk(opusPage());
    expect(audio).toHaveLength(2); // 以降の音声は境界の影響を受けない
  });

  it('OpusHead CONFIG packets are never dropped by the resume boundary', () => {
    const encoder = new VaapiEncoder();
    setWallBaseline(encoder, 4_000_000n);

    const audio: Array<{ flags: number }> = [];
    encoder.on('audio', (pkt) => audio.push(pkt));

    encoder.setResumeBoundary(9_000_000n);
    (encoder as any).handleAudioChunk(buildOggPage([Buffer.from('OpusHead' + '\0'.repeat(11))]));
    expect(audio).toHaveLength(1);
    expect(audio[0].flags).toBe(AUDIO_FLAGS.CONFIG);
  });

  it('armResumeGate resets a previous boundary so a new hold-resume cycle cannot inherit a stale epoch', () => {
    const encoder = new VaapiEncoder();
    setWallBaseline(encoder, 4_000_000n);
    encoder.setResumeBoundary(9_000_000n);
    encoder.armResumeGate(60000); // 次回復帰で境界は再定義 (古い権威 PTS は引き継がない)

    const audio: Array<{ pts: bigint }> = [];
    encoder.on('audio', (pkt) => audio.push(pkt));
    setWallBaseline(encoder, 1_000_000n);
    (encoder as any).handleAudioChunk(opusPage());
    expect(audio).toHaveLength(0); // 時間ゲートが優先 (IDR 待ち)

    (encoder as any).handleVideoChunk(IDR_AU);
    (encoder as any).handleAudioChunk(opusPage());
    expect(audio).toHaveLength(1); // 新 IDR PTS で再設定された境界を通過
  });

  it('steady-state keyframes without armResumeGate do not overwrite resumeBoundaryPtsUs or drop audio', () => {
    const encoder = new VaapiEncoder();
    setWallBaseline(encoder, 10_000_000n);

    const audio: Array<{ pts: bigint }> = [];
    encoder.on('audio', (pkt) => audio.push(pkt));

    // 通常 LIVE 配信中の定常キーフレーム受信 (armResumeGate 未呼出)
    (encoder as any).handleVideoChunk(IDR_AU);
    expect((encoder as any).resumeBoundaryPtsUs).toBeNull();

    // videoPts が単調増加補正等で僅かに先行していても、定常音声は一切破棄されない
    setWallBaseline(encoder, 9_999_000n);
    (encoder as any).handleAudioChunk(opusPage());
    expect(audio).toHaveLength(1);
  });

  it('resetHoldCompensation clears holdPausedSinceUs so sleep transition does not rewind PTS on later resume', () => {
    const encoder = new VaapiEncoder();
    setWallBaseline(encoder, 5_000_000n);
    encoder.noteHoldPause();
    expect(encoder.isHoldPaused()).toBe(true);

    encoder.resetHoldCompensation();
    expect(encoder.isHoldPaused()).toBe(false);
    expect((encoder as any).totalHoldPausedUs).toBe(0n);
    expect((encoder as any).resumeBoundaryPtsUs).toBeNull();
  });
});
