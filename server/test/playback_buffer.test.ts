import { describe, it, expect } from 'vitest';
import { PlaybackBuffer } from '../src/encoder/playback-buffer.js';
import { VIDEO_FLAGS, AUDIO_FLAGS } from '../src/ws/protocol.js';

describe('PlaybackBuffer Ring Buffer Tests', () => {
  it('should store video and audio frames and record configs', () => {
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
    expect(buffer.getVideoCount()).toBe(2);
    expect(buffer.getAudioCount()).toBe(2);
    expect(buffer.getCurrentBytes()).toBe(spsPps.length + keyframe.length + opusHead.length + audioData.length);
  });

  it('should prune oldest GOP when duration limit is exceeded', () => {
    // 2 seconds buffer
    const buffer = new PlaybackBuffer({ bufferSeconds: 2, maxBytes: 10 * 1024 * 1024 });

    // GOP 1: 0ms (key), 33ms (delta), 66ms (delta)
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 0n, Buffer.alloc(100));
    buffer.addVideo(0, 33000n, Buffer.alloc(100));
    buffer.addVideo(0, 66000n, Buffer.alloc(100));
    buffer.addAudio(AUDIO_FLAGS.KEYFRAME, 0n, Buffer.alloc(50));
    buffer.addAudio(AUDIO_FLAGS.KEYFRAME, 20000n, Buffer.alloc(50));

    // GOP 2: 1000ms (key), 1033ms (delta)
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1000000n, Buffer.alloc(100));
    buffer.addVideo(0, 1033000n, Buffer.alloc(100));
    buffer.addAudio(AUDIO_FLAGS.KEYFRAME, 1000000n, Buffer.alloc(50));

    // GOP 3: 2500ms (key) -> now newest (2500ms) - oldest (0ms) = 2.5s > 2s limit!
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 2500000n, Buffer.alloc(100));

    // GOP 1 should have been pruned. GOP 2 (starting with keyframe at 1000ms) is now the oldest!
    expect(buffer.getVideoCount()).toBe(3); // GOP 2 key + GOP 2 delta + GOP 3 key
    const catchup = buffer.getFramesToCatchup(2000000n);
    expect(catchup).not.toBeNull();
    // The oldest video frame in buffer must be keyframe at 1000ms
    expect(catchup!.frames[0].pts).toBe(1000000n);
    expect((catchup!.frames[0].flags & VIDEO_FLAGS.KEYFRAME) !== 0).toBe(true);
  });

  it('should prune oldest GOP when maxBytes memory guard is exceeded', () => {
    // 500 bytes buffer
    const buffer = new PlaybackBuffer({ bufferSeconds: 60, maxBytes: 500 });

    // GOP 1: 300 bytes total
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 0n, Buffer.alloc(150));
    buffer.addVideo(0, 33000n, Buffer.alloc(150));

    // GOP 2: 300 bytes total -> Total 600 > 500 maxBytes!
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1000000n, Buffer.alloc(150));
    buffer.addVideo(0, 1033000n, Buffer.alloc(150));

    // GOP 1 should be pruned to keep under maxBytes
    expect(buffer.getCurrentBytes()).toBe(300);
    expect(buffer.getVideoCount()).toBe(2);
    // Oldest frame must be GOP 2 keyframe
    const catchup = buffer.getFramesToCatchup(1000000n);
    expect(catchup!.frames[0].pts).toBe(1000000n);
  });

  it('should select the closest preceding KEYFRAME for lastAckPts and merge audio/video in PTS order', () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 10, maxBytes: 1024 * 1024 });

    // GOP 1: 0ms keyframe, 33ms delta, 66ms delta
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 0n, Buffer.from('v0'));
    buffer.addAudio(AUDIO_FLAGS.KEYFRAME, 10000n, Buffer.from('a10'));
    buffer.addVideo(0, 33000n, Buffer.from('v33'));
    buffer.addAudio(AUDIO_FLAGS.KEYFRAME, 30000n, Buffer.from('a30'));
    buffer.addVideo(0, 66000n, Buffer.from('v66'));

    // GOP 2: 2000ms keyframe, 2033ms delta
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 2000000n, Buffer.from('v2000'));
    buffer.addAudio(AUDIO_FLAGS.KEYFRAME, 2010000n, Buffer.from('a2010'));
    buffer.addVideo(0, 2033000n, Buffer.from('v2033'));

    // Client ACK is at 2033ms (GOP 2 delta frame)
    // Catchup must start from GOP 2 KEYFRAME at 2000ms!
    const result = buffer.getFramesToCatchup(2033000n);
    expect(result).not.toBeNull();
    const frames = result!.frames;

    // First frame must be GOP 2 keyframe
    expect(frames[0].type).toBe('video');
    expect(frames[0].pts).toBe(2000000n);
    expect((frames[0].flags & VIDEO_FLAGS.KEYFRAME) !== 0).toBe(true);

    // Sequence must be sorted in ascending PTS order
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].pts >= frames[i - 1].pts).toBe(true);
    }
  });

  it('should clear buffer completely on navigation / restart', () => {
    const buffer = new PlaybackBuffer();
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 0n, Buffer.alloc(100));
    buffer.addAudio(AUDIO_FLAGS.KEYFRAME, 0n, Buffer.alloc(50));
    expect(buffer.getVideoCount()).toBe(1);
    expect(buffer.getAudioCount()).toBe(1);

    buffer.clear();
    expect(buffer.getVideoCount()).toBe(0);
    expect(buffer.getAudioCount()).toBe(0);
    expect(buffer.getCurrentBytes()).toBe(0);
    expect(buffer.getCachedSpsPps()).toBeNull();
    expect(buffer.getCachedOpusHead()).toBeNull();
    expect(buffer.getFramesToCatchup(0n)).toBeNull();
  });
});
