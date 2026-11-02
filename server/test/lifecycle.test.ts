import { describe, it, expect, vi } from 'vitest';
import { VaapiEncoder } from '../src/encoder/ffmpeg.js';

describe('VaapiEncoder Lifecycle & Idle Shutdown', () => {
  it('should reflect running state and provide clean stop/start interfaces', () => {
    const encoder = new VaapiEncoder({
      displayNum: ':99',
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: '1000k',
    });

    // Initially not running
    expect(encoder.isRunning()).toBe(false);

    // Calling stop when already stopped should be safe and idempotent
    encoder.stop();
    expect(encoder.isRunning()).toBe(false);
  });

  it('should correctly evaluate keyframe staleness', () => {
    const encoder = new VaapiEncoder();

    // No keyframe cached -> considered stale
    expect(encoder.isKeyframeStale()).toBe(true);

    const nowPts = encoder.getCurrentPts();

    // Keyframe generated just now (pts = nowPts)
    (encoder as any).cachedKeyframe = { data: Buffer.alloc(10), pts: nowPts };
    expect(encoder.isKeyframeStale(2000000n)).toBe(false);

    // Keyframe generated 3 seconds ago
    (encoder as any).cachedKeyframe = {
      data: Buffer.alloc(10),
      pts: nowPts >= 3000000n ? nowPts - 3000000n : 0n,
    };
    if (nowPts >= 3000000n) {
      expect(encoder.isKeyframeStale(2000000n)).toBe(true);
    }
  });

  it('should trigger watchdog restart when video frames are stalled for >= 3s', () => {
    const encoder = new VaapiEncoder();
    const restartSpy = vi.spyOn(encoder, 'restart').mockResolvedValue(undefined);

    (encoder as any).isVideoRunning = true;
    (encoder as any).isIntentionalVideoStop = false;
    (encoder as any).lastVideoEmitTime = performance.now() - 3500;

    encoder.checkVideoWatchdog();

    expect(restartSpy).toHaveBeenCalledTimes(1);
    encoder.stop();
  });

  it('should NOT trigger watchdog when video is intentionally stopped or not running', () => {
    const encoder = new VaapiEncoder();
    const restartSpy = vi.spyOn(encoder, 'restart').mockResolvedValue(undefined);

    // 1. Not running
    (encoder as any).isVideoRunning = false;
    (encoder as any).isIntentionalVideoStop = false;
    (encoder as any).lastVideoEmitTime = performance.now() - 5000;
    encoder.checkVideoWatchdog();
    expect(restartSpy).not.toHaveBeenCalled();

    // 2. Intentional stop
    (encoder as any).isVideoRunning = true;
    (encoder as any).isIntentionalVideoStop = true;
    encoder.checkVideoWatchdog();
    expect(restartSpy).not.toHaveBeenCalled();

    encoder.stop();
  });
});
