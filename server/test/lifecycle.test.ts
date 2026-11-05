import { describe, expect, it, vi } from 'vitest';
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

  it('should deterministically evaluate keyframe staleness regardless of process uptime', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000); // 10.0s wall clock
    const encoder = new VaapiEncoder();

    // Anchor stream start at 5.0s -> getCurrentPts() is deterministically 5_000_000n
    (encoder as any).streamStartTimeUs = 5_000_000n;

    // 1. No keyframe cached -> considered stale
    expect(encoder.isKeyframeStale()).toBe(true);

    const nowPts = encoder.getCurrentPts();
    expect(nowPts).toBe(5_000_000n);

    // 2. Keyframe generated just now -> fresh (not stale within 2s threshold)
    (encoder as any).cachedKeyframe = { data: Buffer.alloc(10), pts: nowPts };
    expect(encoder.isKeyframeStale(2_000_000n)).toBe(false);

    // 3. Keyframe generated 3 seconds ago -> deterministically stale (> 2s threshold)
    (encoder as any).cachedKeyframe = {
      data: Buffer.alloc(10),
      pts: nowPts - 3_000_000n,
    };
    expect(encoder.isKeyframeStale(2_000_000n)).toBe(true);
    vi.restoreAllMocks();
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

  it('should NOT trigger watchdog when video is intentionally stopped, not running, or recently active', () => {
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

    // 3. Running and recently emitted frame (< 3s)
    (encoder as any).isIntentionalVideoStop = false;
    (encoder as any).lastVideoEmitTime = performance.now() - 500;
    encoder.checkVideoWatchdog();
    expect(restartSpy).not.toHaveBeenCalled();

    encoder.stop();
  });
});
