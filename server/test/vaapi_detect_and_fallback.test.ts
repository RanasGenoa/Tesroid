import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { AuthService } from '../src/auth.js';
import { BrowserManager } from '../src/browser/manager.js';
import { ConfigStore } from '../src/config.js';
import { type EncoderFallbackEvent, VaapiEncoder } from '../src/encoder/ffmpeg.js';
import { LockoutManager } from '../src/lockout.js';
import { registerSetupRoutes } from '../src/routes/setup.js';
import {
  detectVaapiConfig,
  hasHardwareVideoDevice,
  resolveEncoderMode,
  type VaapiProbeResult,
} from '../src/utils/vaapi.js';

function createFakeChildProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    pid: number;
  };
  proc.stdout = new EventEmitter();
  proc.kill = vi.fn(() => true);
  proc.exitCode = null;
  proc.pid = 43210;
  return proc;
}

const VALID_VAINFO_H264_OUT = [
  'libva info: VA-API version 1.20.0',
  'vainfo: Driver version: test',
  '      VAProfileH264Main               :\tVAEntrypointVLD',
  '      VAProfileH264Main               :\tVAEntrypointEncSlice',
  '      VAProfileH264High               :\tVAEntrypointEncSlice',
].join('\n');

describe('Multi-GPU VAAPI Detection, D3D12 Scoping & libx264 Fallback', () => {
  let prevEncoderMode: string | undefined;
  let prevVaapiDevice: string | undefined;
  let prevLibvaDriverName: string | undefined;
  let prevGalliumDriver: string | undefined;
  let tmpDir: string;
  let encoder: VaapiEncoder | null = null;

  beforeEach(() => {
    prevEncoderMode = process.env.ENCODER_MODE;
    prevVaapiDevice = process.env.VAAPI_DEVICE;
    prevLibvaDriverName = process.env.LIBVA_DRIVER_NAME;
    prevGalliumDriver = process.env.GALLIUM_DRIVER;
    delete process.env.ENCODER_MODE;
    delete process.env.VAAPI_DEVICE;
    delete process.env.LIBVA_DRIVER_NAME;
    delete process.env.GALLIUM_DRIVER;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-vaapi-detect-'));
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => createFakeChildProcess());
  });

  afterEach(() => {
    if (encoder) {
      encoder.stopVideo();
      encoder = null;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();

    if (prevEncoderMode === undefined) delete process.env.ENCODER_MODE;
    else process.env.ENCODER_MODE = prevEncoderMode;

    if (prevVaapiDevice === undefined) delete process.env.VAAPI_DEVICE;
    else process.env.VAAPI_DEVICE = prevVaapiDevice;

    if (prevLibvaDriverName === undefined) delete process.env.LIBVA_DRIVER_NAME;
    else process.env.LIBVA_DRIVER_NAME = prevLibvaDriverName;

    if (prevGalliumDriver === undefined) delete process.env.GALLIUM_DRIVER;
    else process.env.GALLIUM_DRIVER = prevGalliumDriver;

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('resolveEncoderMode reads override -> process.env.ENCODER_MODE -> auto', () => {
    expect(resolveEncoderMode()).toBe('auto');

    process.env.ENCODER_MODE = 'software';
    expect(resolveEncoderMode()).toBe('software');

    process.env.ENCODER_MODE = ' VAAPI ';
    expect(resolveEncoderMode()).toBe('vaapi');

    process.env.ENCODER_MODE = 'invalid-mode';
    expect(resolveEncoderMode()).toBe('auto');

    expect(resolveEncoderMode('SOFTWARE')).toBe('software');
    expect(resolveEncoderMode('vaapi')).toBe('vaapi');
    expect(resolveEncoderMode('  ')).toBe('auto');
  });

  it('detectVaapiConfig handles Intel iHD, Intel legacy i965 fallback, and AMD radeonsi', () => {
    // 1. Intel iHD
    const intelIhd = detectVaapiConfig({
      env: {},
      existsSync: (p) => p === '/dev/dri' || p === '/dev/dri/renderD128',
      readdirSync: () => ['renderD128'],
      readFileSync: () => '0x8086\n',
      runVainfo: (_dev, driver, env) => {
        expect(driver).toBe('iHD');
        expect(env.LIBVA_DRIVER_NAME).toBe('iHD');
        expect(env.GALLIUM_DRIVER).toBeUndefined();
        return { status: 0, stdout: VALID_VAINFO_H264_OUT };
      },
    });
    expect(intelIhd).toMatchObject({
      vaapiDevice: '/dev/dri/renderD128',
      libvaDriverName: 'iHD',
      hasDri: true,
      hasDxg: false,
      vaapiEncodeSupported: true,
    });

    // 2. Legacy Intel: iHD fails -> probes i965 and succeeds
    const probedDrivers: string[] = [];
    const intelI965 = detectVaapiConfig({
      env: {},
      existsSync: (p) => p === '/dev/dri' || p === '/dev/dri/renderD128',
      readdirSync: () => ['renderD128'],
      readFileSync: () => '0x8086\n',
      runVainfo: (_dev, driver) => {
        probedDrivers.push(driver);
        if (driver === 'iHD') {
          return { status: 1, stdout: '', stderr: 'vaInitialize failed' };
        }
        return { status: 0, stdout: VALID_VAINFO_H264_OUT };
      },
    });
    expect(probedDrivers).toEqual(['iHD', 'i965']);
    expect(intelI965).toMatchObject({
      vaapiDevice: '/dev/dri/renderD128',
      libvaDriverName: 'i965',
      hasDri: true,
      hasDxg: false,
      vaapiEncodeSupported: true,
    });

    // 3. AMD Radeon Linux (radeonsi)
    const amdRadeonsi = detectVaapiConfig({
      env: {},
      existsSync: (p) => p === '/dev/dri' || p === '/dev/dri/renderD128',
      readdirSync: () => ['renderD128'],
      readFileSync: () => '0x1002\n',
      runVainfo: (_dev, driver, env) => {
        expect(driver).toBe('radeonsi');
        expect(env.LIBVA_DRIVER_NAME).toBe('radeonsi');
        expect(env.GALLIUM_DRIVER).toBeUndefined();
        return { status: 0, stdout: VALID_VAINFO_H264_OUT };
      },
    });
    expect(amdRadeonsi).toMatchObject({
      vaapiDevice: '/dev/dri/renderD128',
      libvaDriverName: 'radeonsi',
      hasDri: true,
      hasDxg: false,
      vaapiEncodeSupported: true,
    });
  });

  it('detectVaapiConfig skips NVIDIA renderD128 (0x10de) in favor of renderD129 (0x1002 / 0x8086)', () => {
    const probedDevices: string[] = [];
    const dualGpuAmd = detectVaapiConfig({
      env: {},
      existsSync: (p) =>
        p === '/dev/dri' || p === '/dev/dri/renderD128' || p === '/dev/dri/renderD129',
      readdirSync: () => ['renderD128', 'renderD129'],
      readFileSync: (p) => {
        if (p === '/sys/class/drm/renderD128/device/vendor') return '0x10de\n';
        if (p === '/sys/class/drm/renderD129/device/vendor') return '0x1002\n';
        throw new Error('ENOENT');
      },
      runVainfo: (dev, driver) => {
        probedDevices.push(`${dev}:${driver}`);
        return { status: 0, stdout: VALID_VAINFO_H264_OUT };
      },
    });
    expect(dualGpuAmd.vaapiDevice).toBe('/dev/dri/renderD129');
    expect(dualGpuAmd.libvaDriverName).toBe('radeonsi');
    expect(dualGpuAmd.vaapiEncodeSupported).toBe(true);
    expect(probedDevices).toEqual(['/dev/dri/renderD129:radeonsi']);

    // NVIDIA-only falls back to renderD128 and reports vaapiEncodeSupported: false if vainfo fails
    const nvidiaOnly = detectVaapiConfig({
      env: {},
      existsSync: (p) => p === '/dev/dri' || p === '/dev/dri/renderD128',
      readdirSync: () => ['renderD128'],
      readFileSync: () => '0x10de\n',
      runVainfo: () => ({ status: 1, stdout: '' }),
    });
    expect(nvidiaOnly.vaapiDevice).toBe('/dev/dri/renderD128');
    expect(nvidiaOnly.libvaDriverName).toBe('iHD');
    expect(nvidiaOnly.vaapiEncodeSupported).toBe(false);
  });

  it('detectVaapiConfig detects /dev/dxg and marks VideoProc-only D3D12 (RX 9070 XT) as vaapiEncodeSupported: false', () => {
    // 1. /dev/dxg without /dev/dri/renderD* (default Docker Desktop)
    const runVainfoSpy = vi.fn<() => VaapiProbeResult>();
    const dxgOnly = detectVaapiConfig({
      env: {},
      existsSync: (p) => p === '/dev/dxg',
      runVainfo: runVainfoSpy,
    });
    expect(dxgOnly).toMatchObject({
      vaapiDevice: '',
      libvaDriverName: 'd3d12',
      hasDri: false,
      hasDxg: true,
      vaapiEncodeSupported: false,
    });
    expect(runVainfoSpy).not.toHaveBeenCalled();

    // 2. /dev/dxg + vgem /dev/dri/renderD128 where vainfo only exposes VideoProc (no H264 EncSlice)
    const d3d12VideoProcOnly = detectVaapiConfig({
      env: {},
      existsSync: (p) => p === '/dev/dxg' || p === '/dev/dri' || p === '/dev/dri/renderD128',
      readdirSync: () => ['renderD128'],
      readFileSync: () => {
        throw new Error('no sysfs vendor on vgem');
      },
      runVainfo: (dev, driver, env) => {
        expect(dev).toBe('/dev/dri/renderD128');
        expect(driver).toBe('d3d12');
        expect(env.LIBVA_DRIVER_NAME).toBe('d3d12');
        expect(env.GALLIUM_DRIVER).toBe('d3d12');
        return {
          status: 0,
          stdout: 'VAProfileNone : VAEntrypointVideoProc\n',
        };
      },
    });
    expect(d3d12VideoProcOnly).toMatchObject({
      vaapiDevice: '/dev/dri/renderD128',
      libvaDriverName: 'd3d12',
      hasDri: true,
      hasDxg: true,
      vaapiEncodeSupported: false,
    });

    // 3. /dev/dxg + vgem where vainfo segfaults (exit 139)
    const d3d12Crash = detectVaapiConfig({
      env: {},
      existsSync: (p) => p === '/dev/dxg' || p === '/dev/dri' || p === '/dev/dri/renderD128',
      readdirSync: () => ['renderD128'],
      runVainfo: () => ({ status: 139, stdout: '' }),
    });
    expect(d3d12Crash.vaapiEncodeSupported).toBe(false);

    // 4. /dev/dxg + vgem where vainfo reports H.264 EncSlice -> supported
    const d3d12Supported = detectVaapiConfig({
      env: {},
      existsSync: (p) => p === '/dev/dxg' || p === '/dev/dri' || p === '/dev/dri/renderD128',
      readdirSync: () => ['renderD128'],
      runVainfo: () => ({ status: 0, stdout: VALID_VAINFO_H264_OUT }),
    });
    expect(d3d12Supported).toMatchObject({
      vaapiDevice: '/dev/dri/renderD128',
      libvaDriverName: 'd3d12',
      hasDri: true,
      hasDxg: true,
      vaapiEncodeSupported: true,
    });
  });

  it('detectVaapiConfig honors explicit VAAPI_DEVICE/LIBVA_DRIVER_NAME and treats auto as unset', () => {
    const explicit = detectVaapiConfig({
      env: {
        VAAPI_DEVICE: '/dev/dri/renderD129',
        LIBVA_DRIVER_NAME: 'i965',
      },
      existsSync: (p) => p === '/dev/dri/renderD129',
      runVainfo: (dev, driver) => {
        expect(dev).toBe('/dev/dri/renderD129');
        expect(driver).toBe('i965');
        return { status: 0, stdout: VALID_VAINFO_H264_OUT };
      },
    });
    expect(explicit.vaapiDevice).toBe('/dev/dri/renderD129');
    expect(explicit.libvaDriverName).toBe('i965');
    expect(explicit.vaapiEncodeSupported).toBe(true);

    // 'auto' should behave like unset and auto-detect radeonsi on AMD renderD129
    const autoEnv = detectVaapiConfig({
      env: {
        VAAPI_DEVICE: 'auto',
        LIBVA_DRIVER_NAME: 'AUTO',
      },
      existsSync: (p) => p === '/dev/dri' || p === '/dev/dri/renderD129',
      readdirSync: () => ['renderD129'],
      readFileSync: () => '0x1002\n',
      runVainfo: () => ({ status: 0, stdout: VALID_VAINFO_H264_OUT }),
    });
    expect(autoEnv.vaapiDevice).toBe('/dev/dri/renderD129');
    expect(autoEnv.libvaDriverName).toBe('radeonsi');
    expect(autoEnv.vaapiEncodeSupported).toBe(true);

    // Decode-only (VLD without EncSlice) must NOT report vaapiEncodeSupported
    const decodeOnly = detectVaapiConfig({
      env: {},
      existsSync: (p) => p === '/dev/dri' || p === '/dev/dri/renderD128',
      readdirSync: () => ['renderD128'],
      readFileSync: () => '0x8086\n',
      runVainfo: () => ({
        status: 0,
        stdout: '      VAProfileH264Main               :\tVAEntrypointVLD\n',
      }),
    });
    expect(decodeOnly.vaapiEncodeSupported).toBe(false);
  });

  it('hasHardwareVideoDevice detects renderD129, card1, /dev/dxg, configured device, and updates /api/status hasDri', async () => {
    expect(
      hasHardwareVideoDevice(undefined, {
        env: {},
        existsSync: () => false,
      }),
    ).toBe(false);

    expect(
      hasHardwareVideoDevice(undefined, {
        env: {},
        existsSync: (p) => p === '/dev/dxg',
      }),
    ).toBe(true);

    expect(
      hasHardwareVideoDevice(undefined, {
        env: {},
        existsSync: (p) => p === '/dev/dri' || p === '/dev/dri/renderD129',
        readdirSync: () => ['renderD129'],
      }),
    ).toBe(true);

    expect(
      hasHardwareVideoDevice('/custom/dri/node', {
        env: {},
        existsSync: (p) => p === '/custom/dri/node',
      }),
    ).toBe(true);

    // Verify GET /api/status uses hasHardwareVideoDevice() for hasDri
    const configStore = new ConfigStore(tmpDir);
    const lockoutManager = new LockoutManager(tmpDir);
    const authService = new AuthService(configStore, lockoutManager);
    const mockBrowser = {
      getState: vi.fn(() => 'running'),
      getCurrentUrl: vi.fn(() => 'https://www.youtube.com'),
    } as unknown as BrowserManager;

    const app = Fastify();
    registerSetupRoutes(app, configStore, authService, lockoutManager, mockBrowser);
    await app.ready();

    try {
      const existsSpy = vi
        .spyOn(fs, 'existsSync')
        .mockImplementation((target) => String(target) === '/dev/dxg');
      const statusWithDxg = await app.inject({ method: 'GET', url: '/api/status' });
      expect(statusWithDxg.statusCode).toBe(200);
      expect(statusWithDxg.json().hasDri).toBe(true);

      existsSpy.mockReturnValue(false);
      const statusWithoutHw = await app.inject({ method: 'GET', url: '/api/status' });
      expect(statusWithoutHw.statusCode).toBe(200);
      expect(statusWithoutHw.json().hasDri).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('VaapiEncoder emits zero-latency libx264 args in software mode and scopes GALLIUM_DRIVER=d3d12 only to FFmpeg', () => {
    encoder = new VaapiEncoder({
      displayNum: ':95',
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: '1500k',
      encoderMode: 'software',
      libvaDriverName: 'd3d12',
    });

    expect(encoder.getEncoderMode()).toBe('software');
    expect(encoder.getActiveBackend()).toBe('software');
    expect(encoder.getEncoderStatus()).toMatchObject({
      backend: 'software',
      encoderMode: 'software',
    });

    const args = encoder.buildVideoArgs();
    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-thread_queue_size',
      '64',
      '-f',
      'x11grab',
      '-draw_mouse',
      '0',
      '-framerate',
      '30',
      '-video_size',
      '1280x720',
      '-i',
      ':95.0',
      '-vf',
      'format=yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-b:v',
      '1500k',
      '-maxrate',
      '1950k',
      '-bufsize',
      '900k',
      '-g',
      '60',
      '-bf',
      '0',
      '-bsf:v',
      'h264_metadata=aud=insert',
      '-flush_packets',
      '1',
      '-f',
      'h264',
      'pipe:1',
    ]);
    expect(args).not.toContain('-vaapi_device');

    const videoEnv = encoder.buildVideoEnv();
    expect(videoEnv.LIBVA_DRIVER_NAME).toBe('d3d12');
    expect(videoEnv.GALLIUM_DRIVER).toBe('d3d12');

    // BrowserManager must NOT inherit GALLIUM_DRIVER=d3d12 from Tesroid code
    const bm = new BrowserManager({
      profileDir: tmpDir,
      libvaDriverName: 'd3d12',
      vaapiDevice: '',
    });
    const chromeEnv = bm.buildChromeEnv();
    expect(chromeEnv.LIBVA_DRIVER_NAME).toBe('d3d12');
    expect(chromeEnv.GALLIUM_DRIVER).toBeUndefined();
    expect(bm.buildChromeArgs().some((a) => a.startsWith('--render-node-override='))).toBe(false);

    const bmNone = new BrowserManager({ profileDir: tmpDir, vaapiDevice: 'none' });
    expect(bmNone.buildChromeArgs().some((a) => a.startsWith('--render-node-override='))).toBe(
      false,
    );
  });

  it('VaapiEncoder immediately switches to software (libx264) in auto mode when vaapiDevice is missing', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const fallbacks: EncoderFallbackEvent[] = [];

    encoder = new VaapiEncoder({
      vaapiDevice: '/dev/dri/renderD128',
      encoderMode: 'auto',
      initialBackend: 'vaapi',
    });
    encoder.on('fallback', (ev: EncoderFallbackEvent) => fallbacks.push(ev));

    encoder.startVideo();

    expect(encoder.getActiveBackend()).toBe('software');
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].option).toBe('softwareEncoder');
    expect(encoder.getEncoderStatus().lastFallback?.option).toBe('softwareEncoder');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][1]).toContain('libx264');
  });

  it('VaapiEncoder steps through lowPower -> gpuColorConversion -> softwareEncoder fallback ladder with capped exponential backoff and resets on frame output', () => {
    vi.useFakeTimers();
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const spawnedProcs: ReturnType<typeof createFakeChildProcess>[] = [];
    spawnMock.mockImplementation(() => {
      const p = createFakeChildProcess();
      spawnedProcs.push(p);
      return p;
    });

    const fallbacks: EncoderFallbackEvent['option'][] = [];
    encoder = new VaapiEncoder({
      vaapiDevice: '/dev/dri/renderD128',
      encoderMode: 'auto',
      initialBackend: 'vaapi',
      lowPower: true,
      gpuColorConversion: true,
    });
    encoder.on('fallback', (ev: EncoderFallbackEvent) => fallbacks.push(ev.option));

    // 1. Initial VAAPI spawn with -low_power 1 and scale_vaapi
    encoder.startVideo();
    expect(spawnedProcs).toHaveLength(1);
    expect(spawnMock.mock.calls[0][1]).toContain('-low_power');
    expect(spawnMock.mock.calls[0][1]).toContain('hwupload,scale_vaapi=format=nv12');

    // Crash #1 -> fallback to lowPower=false, retry in 1000ms
    spawnedProcs[0].emit('exit', 1, null);
    expect(fallbacks).toEqual(['lowPower']);
    vi.advanceTimersByTime(999);
    expect(spawnedProcs).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(spawnedProcs).toHaveLength(2);
    expect(spawnMock.mock.calls[1][1]).not.toContain('-low_power');
    expect(spawnMock.mock.calls[1][1]).toContain('hwupload,scale_vaapi=format=nv12');

    // Crash #2 -> fallback to gpuColorConversion=false, retry in 2000ms
    spawnedProcs[1].emit('exit', 1, null);
    expect(fallbacks).toEqual(['lowPower', 'gpuColorConversion']);
    vi.advanceTimersByTime(1999);
    expect(spawnedProcs).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(spawnedProcs).toHaveLength(3);
    expect(spawnMock.mock.calls[2][1]).toContain('format=nv12,hwupload');
    expect(spawnMock.mock.calls[2][1]).toContain('h264_vaapi');

    // Crash #3 (signal SIGSEGV!) -> fallback to softwareEncoder (libx264), retry in 4000ms
    spawnedProcs[2].emit('exit', null, 'SIGSEGV');
    expect(fallbacks).toEqual(['lowPower', 'gpuColorConversion', 'softwareEncoder']);
    expect(encoder.getActiveBackend()).toBe('software');
    vi.advanceTimersByTime(3999);
    expect(spawnedProcs).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(spawnedProcs).toHaveLength(4);
    expect(spawnMock.mock.calls[3][1]).toContain('libx264');

    // Crash #4 & #5 while on software -> backoff reaches 8000ms, then capped at 10000ms
    spawnedProcs[3].emit('exit', 1, null);
    vi.advanceTimersByTime(7999);
    expect(spawnedProcs).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(spawnedProcs).toHaveLength(5);

    spawnedProcs[4].emit('exit', 1, null);
    vi.advanceTimersByTime(9999);
    expect(spawnedProcs).toHaveLength(5);
    vi.advanceTimersByTime(1);
    expect(spawnedProcs).toHaveLength(6);

    // Emit a valid H.264 frame (IDR + AUD) to verify backoff resets to 1000ms
    const sampleH264Stream = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0xf0]), // AUD
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e]), // SPS
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x21]), // IDR
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0xf0, 0x00, 0x00, 0x00, 0x01, 0x06]), // Next AUD + trailing start code triggers flush
    ]);
    spawnedProcs[5].stdout.emit('data', sampleH264Stream);

    spawnedProcs[5].emit('exit', 1, null);
    vi.advanceTimersByTime(999);
    expect(spawnedProcs).toHaveLength(6);
    vi.advanceTimersByTime(1);
    expect(spawnedProcs).toHaveLength(7);
  });

  it('VaapiEncoder does NOT switch to software when ENCODER_MODE=vaapi even if vaapiDevice is missing or VAAPI crashes', () => {
    vi.useFakeTimers();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const spawnedProcs: ReturnType<typeof createFakeChildProcess>[] = [];
    spawnMock.mockImplementation(() => {
      const p = createFakeChildProcess();
      spawnedProcs.push(p);
      return p;
    });

    encoder = new VaapiEncoder({
      vaapiDevice: '/dev/dri/renderD128',
      encoderMode: 'vaapi',
      lowPower: false,
      gpuColorConversion: false,
    });
    const fallbacks: EncoderFallbackEvent[] = [];
    encoder.on('fallback', (ev: EncoderFallbackEvent) => fallbacks.push(ev));

    encoder.startVideo();
    expect(encoder.getActiveBackend()).toBe('vaapi');
    expect(spawnMock.mock.calls[0][1]).toContain('h264_vaapi');

    spawnedProcs[0].emit('exit', 1, null);
    expect(fallbacks).toHaveLength(0);
    expect(encoder.getActiveBackend()).toBe('vaapi');

    vi.advanceTimersByTime(1000);
    expect(spawnedProcs).toHaveLength(2);
    expect(spawnMock.mock.calls[1][1]).toContain('h264_vaapi');
  });
});
