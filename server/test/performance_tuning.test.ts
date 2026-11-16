import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config.js';
import { VaapiEncoder } from '../src/encoder/ffmpeg.js';

describe('Server Performance Tuning (Issue #46)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should default VaapiEncoder to compressionLevel=4, lowPower=false, and gpuColorConversion=true', () => {
    const encoder = new VaapiEncoder();
    expect(encoder.getCompressionLevel()).toBe(4);
    expect(encoder.isLowPower()).toBe(false);
    expect(encoder.isGpuColorConversion()).toBe(true);

    const args = encoder.buildVideoArgs();
    const compIdx = args.indexOf('-compression_level');
    expect(compIdx).toBeGreaterThan(-1);
    expect(args[compIdx + 1]).toBe('4');
    expect(args).not.toContain('-low_power');
    expect(args).toContain('hwupload,scale_vaapi=format=nv12');
  });

  it('should clamp compressionLevel between 1 and 7 and include -low_power 1 when enabled', () => {
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

  it('should persist performancePreset, vaapiCompressionLevel, and vaapiLowPower in ConfigStore', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-perf-test-'));
    tempDirs.push(tmpDir);

    const store = new ConfigStore(tmpDir);
    expect(store.getConfig().stream.performancePreset).toBe('balanced');
    expect(store.getConfig().stream.vaapiCompressionLevel).toBe(4);
    expect(store.getConfig().stream.vaapiLowPower).toBe(false);

    store.updateConfig({
      stream: {
        ...store.getConfig().stream,
        performancePreset: 'low_power',
        maxSize: 960,
        maxFps: 24,
        bitrate: 800000,
        vaapiCompressionLevel: 7,
        vaapiLowPower: true,
      },
    });

    const reloaded = new ConfigStore(tmpDir);
    expect(reloaded.getConfig().stream.performancePreset).toBe('low_power');
    expect(reloaded.getConfig().stream.maxSize).toBe(960);
    expect(reloaded.getConfig().stream.maxFps).toBe(24);
    expect(reloaded.getConfig().stream.bitrate).toBe(800000);
    expect(reloaded.getConfig().stream.vaapiCompressionLevel).toBe(7);
    expect(reloaded.getConfig().stream.vaapiLowPower).toBe(true);
  });
});
