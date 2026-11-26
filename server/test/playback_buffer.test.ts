import { describe, expect, it } from 'vitest';
import { PlaybackBuffer } from '../src/encoder/playback-buffer.js';
import { AUDIO_FLAGS, VIDEO_FLAGS } from '../src/ws/protocol.js';

describe('PlaybackBuffer Ring Buffer Tests', () => {
  it('should cache configs without buffering them as frames (Issue #111 F-1b)', () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 10, maxBytes: 1024 * 1024 });

    const spsPps = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0]);
    const keyframe = Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]);
    const opusHead = Buffer.from('OpusHead12345678');
    const audioData = Buffer.from([0xf8, 0xff, 0xfe]);

    buffer.addVideo(VIDEO_FLAGS.CONFIG, 0n, spsPps);
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 0n, keyframe);
    buffer.addAudio(AUDIO_FLAGS.CONFIG, 0n, opusHead);
    buffer.addAudio(AUDIO_FLAGS.KEYFRAME, 0n, audioData);

    expect(buffer.getCachedSpsPps()).toEqual(spsPps);
    expect(buffer.getCachedOpusHead()).toEqual(opusHead);
    // Issue #111 (F-1b 根因): CONFIG (pts: 0n) はフレーム配列へ混入させない。
    // 混入すると getBufferedDurationMs() と GOP prune の PTS エポックが汚染された。
    expect(buffer.getVideoCount()).toBe(1);
    expect(buffer.getAudioCount()).toBe(1);
    expect(buffer.getCurrentBytes()).toBe(keyframe.length + audioData.length);

    // 再接続時に config は frames ではなく configVideo/configAudio で再送される
    const catchup = buffer.getFramesToCatchup(0n);
    expect(catchup).not.toBeNull();
    expect(catchup!.configVideo).toEqual(spsPps);
    expect(catchup!.configAudio).toEqual(opusHead);
    expect(catchup!.frames.every((f) => (f.flags & VIDEO_FLAGS.CONFIG) === 0)).toBe(true);
    expect(catchup!.frames.every((f) => (f.flags & AUDIO_FLAGS.CONFIG) === 0)).toBe(true);
  });

  it('should expose latest video pts and keep duration immune to CONFIG packets (Issue #111)', () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 60, maxBytes: 1024 * 1024 });

    expect(buffer.getLatestVideoPts()).toBeNull();

    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1_000_000n, Buffer.alloc(50));
    buffer.addAudio(AUDIO_FLAGS.CONFIG, 0n, Buffer.from('OpusHead12345678'));
    buffer.addVideo(VIDEO_FLAGS.CONFIG, 0n, Buffer.alloc(10));
    buffer.addVideo(0, 2_000_000n, Buffer.alloc(50));
    buffer.addAudio(AUDIO_FLAGS.KEYFRAME, 1_500_000n, Buffer.alloc(20));

    expect(buffer.getLatestVideoPts()).toBe(2_000_000n);
    // F-1b 非回帰: backlog ms 表記がフレーム数と無関係な桁異常 (pts:0n 混入) を起こさない
    expect(buffer.getBufferedDurationMs()).toBe(1000);

    // clear() は latest もリセット
    buffer.clear();
    expect(buffer.getLatestVideoPts()).toBeNull();
  });

  it('should prune oldest GOP when duration limit is exceeded while never pruning the only active GOP', () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 2, maxBytes: 10 * 1024 * 1024 });

    // Single GOP exceeding 2s with no second keyframe -> must NOT prune its own keyframe
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 0n, Buffer.alloc(100));
    buffer.addVideo(0, 2_500_000n, Buffer.alloc(100));
    expect(buffer.getVideoCount()).toBe(2);

    // Arrival of GOP 2 keyframe at 3s allows GOP 1 to be cleanly pruned
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 3_000_000n, Buffer.alloc(100));
    expect(buffer.getVideoCount()).toBe(1);
    const catchup = buffer.getFramesToCatchup(3_000_000n);
    expect(catchup).not.toBeNull();
    expect(catchup!.frames[0].pts).toBe(3_000_000n);
  });

  it('should prune oldest GOP when maxBytes memory guard is exceeded', () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 60, maxBytes: 500 });

    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 0n, Buffer.alloc(150));
    buffer.addVideo(0, 33000n, Buffer.alloc(150));

    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1000000n, Buffer.alloc(150));
    buffer.addVideo(0, 1033000n, Buffer.alloc(150));

    expect(buffer.getCurrentBytes()).toBe(300);
    expect(buffer.getVideoCount()).toBe(2);
    const catchup = buffer.getFramesToCatchup(1000000n);
    expect(catchup!.frames[0].pts).toBe(1000000n);
  });

  it('should select the closest preceding KEYFRAME for lastAckPts and merge audio/video in PTS order', () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 10, maxBytes: 1024 * 1024 });

    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 0n, Buffer.from('v0'));
    buffer.addAudio(AUDIO_FLAGS.KEYFRAME, 10000n, Buffer.from('a10'));
    buffer.addVideo(0, 33000n, Buffer.from('v33'));
    buffer.addAudio(AUDIO_FLAGS.KEYFRAME, 30000n, Buffer.from('a30'));
    buffer.addVideo(0, 66000n, Buffer.from('v66'));

    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 2000000n, Buffer.from('v2000'));
    buffer.addAudio(AUDIO_FLAGS.KEYFRAME, 2010000n, Buffer.from('a2010'));
    buffer.addVideo(0, 2033000n, Buffer.from('v2033'));

    const result = buffer.getFramesToCatchup(2033000n);
    expect(result).not.toBeNull();
    const frames = result!.frames;

    expect(frames[0].type).toBe('video');
    expect(frames[0].pts).toBe(2000000n);
    expect((frames[0].flags & VIDEO_FLAGS.KEYFRAME) !== 0).toBe(true);

    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].pts >= frames[i - 1].pts).toBe(true);
    }
  });

  it('should replay from oldest keyframe when lastAckPts is <= 5s older than buffer start, and return null if > 5s stale', () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 10, maxBytes: 1024 * 1024 });
    // Oldest keyframe in buffer is at 10.0s
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 10_000_000n, Buffer.from('v10s'));
    buffer.addVideo(0, 10_033_000n, Buffer.from('v10.03s'));

    // 1. lastAckPts = 7.0s (3.0s gap <= 5.0s tolerance) -> replays from 10.0s keyframe
    const withinTolerance = buffer.getFramesToCatchup(7_000_000n);
    expect(withinTolerance).not.toBeNull();
    expect(withinTolerance!.frames[0].pts).toBe(10_000_000n);

    // 2. lastAckPts = 2.0s (8.0s gap > 5.0s tolerance) -> too stale for catchup, returns null (fallback to LIVE)
    const tooStale = buffer.getFramesToCatchup(2_000_000n);
    expect(tooStale).toBeNull();
  });

  it('should clear buffer completely on navigation / restart', () => {
    const buffer = new PlaybackBuffer();
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 0n, Buffer.alloc(100));
    buffer.addAudio(AUDIO_FLAGS.KEYFRAME, 0n, Buffer.alloc(50));

    buffer.clear();
    expect(buffer.getVideoCount()).toBe(0);
    expect(buffer.getAudioCount()).toBe(0);
    expect(buffer.getCurrentBytes()).toBe(0);
    expect(buffer.getCachedSpsPps()).toBeNull();
    expect(buffer.getCachedOpusHead()).toBeNull();
    expect(buffer.getFramesToCatchup(0n)).toBeNull();
  });

  it('should default maxBytes to 48MB and retain 30s of 60fps video + 50pps audio without premature pruning', () => {
    const buffer = new PlaybackBuffer();
    expect(buffer.getBufferSeconds()).toBe(60);
    expect(buffer.getMaxBytes()).toBe(48 * 1024 * 1024);

    // Simulate 30s at 60fps (1800 video frames, 2s GOP) + 50pps audio (1500 audio packets)
    // ~8KB/video frame (~3.8Mbps) + 320B/audio packet (~128kbps) -> ~14.88 MB total (< 48 MB)
    for (let i = 0; i < 1800; i++) {
      const pts = BigInt(i) * 16667n;
      const flags = i % 120 === 0 ? VIDEO_FLAGS.KEYFRAME | VIDEO_FLAGS.AVCC : VIDEO_FLAGS.AVCC;
      buffer.addVideo(flags, pts, Buffer.alloc(8192));
    }
    for (let i = 0; i < 1500; i++) {
      const pts = BigInt(i) * 20000n;
      buffer.addAudio(AUDIO_FLAGS.KEYFRAME, pts, Buffer.alloc(320));
    }

    expect(buffer.getVideoCount()).toBe(1800);
    expect(buffer.getAudioCount()).toBe(1500);
    expect(buffer.getBufferedDurationMs()).toBeGreaterThanOrEqual(29900);
  });
});
