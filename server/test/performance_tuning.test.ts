import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore, PERFORMANCE_PRESET_DEFAULTS } from '../src/config.js';
import { VaapiEncoder } from '../src/encoder/ffmpeg.js';

describe('Server Performance Tuning (Issue #46)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should default VaapiEncoder to balanced settings (compressionLevel=7, lowPower=false, gpuColorConversion=true)', () => {
    const encoder = new VaapiEncoder();
    expect(encoder.getCompressionLevel()).toBe(7);
    expect(encoder.isLowPower()).toBe(false);
    expect(encoder.isGpuColorConversion()).toBe(true);

    const args = encoder.buildVideoArgs();
    const compIdx = args.indexOf('-compression_level');
    expect(compIdx).toBeGreaterThan(-1);
    expect(args[compIdx + 1]).toBe('7');
    expect(args).not.toContain('-low_power');
    expect(args).toContain('hwupload,scale_vaapi=format=nv12');
  });

  it('should clamp compressionLevel between 1 and 7 and toggle -low_power / CPU CSC', () => {
    const encoderHigh = new VaapiEncoder({ compressionLevel: 99, lowPower: true });
    expect(encoderHigh.getCompressionLevel()).toBe(7);
    expect(encoderHigh.isLowPower()).toBe(true);

    const args = encoderHigh.buildVideoArgs();
    const compIdx = args.indexOf('-compression_level');
    expect(args[compIdx + 1]).toBe('7');
    const lpIdx = args.indexOf('-low_power');
    expect(lpIdx).toBeGreaterThan(-1);
    expect(args[lpIdx + 1]).toBe('1');

    const encoderLow = new VaapiEncoder({
      compressionLevel: -5,
      lowPower: false,
      gpuColorConversion: false,
    });
    expect(encoderLow.getCompressionLevel()).toBe(1);
    expect(encoderLow.isLowPower()).toBe(false);
    expect(encoderLow.isGpuColorConversion()).toBe(false);
    expect(encoderLow.buildVideoArgs()).toContain('format=nv12,hwupload');
  });

  it('should keep ConfigStore balanced defaults aligned with PERFORMANCE_PRESET_DEFAULTS', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-perf-test-'));
    tempDirs.push(tmpDir);

    const store = new ConfigStore(tmpDir);
    const stream = store.getConfig().stream;
    expect(stream.performancePreset).toBe('balanced');
    expect(stream.maxSize).toBe(PERFORMANCE_PRESET_DEFAULTS.balanced.maxSize);
    expect(stream.vaapiCompressionLevel).toBe(
      PERFORMANCE_PRESET_DEFAULTS.balanced.vaapiCompressionLevel,
    );
    expect(stream.vaapiLowPower).toBe(PERFORMANCE_PRESET_DEFAULTS.balanced.vaapiLowPower);
    expect(stream.vaapiGpuColorConversion).toBe(
      PERFORMANCE_PRESET_DEFAULTS.balanced.vaapiGpuColorConversion,
    );

    store.updateConfig({
      stream: {
        ...stream,
        performancePreset: 'low_power',
        maxSize: 960,
        maxFps: 24,
        bitrate: 800000,
        vaapiCompressionLevel: 7,
        vaapiLowPower: false,
      },
    });

    const reloaded = new ConfigStore(tmpDir);
    expect(reloaded.getConfig().stream.performancePreset).toBe('low_power');
    expect(reloaded.getConfig().stream.maxSize).toBe(960);
    expect(reloaded.getConfig().stream.vaapiCompressionLevel).toBe(7);
  });

  it('should expose getEncoderStatus() and forward tuning options through restart() via updateConfig()', async () => {
    const encoder = new VaapiEncoder();
    expect(encoder.getEncoderStatus()).toEqual({
      running: false,
      compressionLevel: 7,
      lowPower: false,
      gpuColorConversion: true,
      lastFallback: null,
    });

    const restartSpy = vi
      .spyOn(encoder, 'restart')
      .mockImplementation(
        async (_w, _h, _fps, _br, _ab, compressionLevel, lowPower, gpuColorConversion) => {
          // Verify restart() applies tuning fields directly without double-assignment in updateConfig()
          if (compressionLevel !== undefined) {
            expect(encoder.getCompressionLevel()).toBe(7);
          }
          expect(lowPower).toBe(true);
          expect(gpuColorConversion).toBe(false);
        },
      );

    await encoder.updateConfig({
      compressionLevel: 4,
      lowPower: true,
      gpuColorConversion: false,
    });

    expect(restartSpy).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      4,
      true,
      false,
    );
  });
});
