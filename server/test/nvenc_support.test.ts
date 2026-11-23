import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

import { type EncoderFallbackEvent, VaapiEncoder } from '../src/encoder/ffmpeg.js';
import { detectNvencConfig, hasNvidiaDevice } from '../src/utils/nvenc.js';
import { resolveEncoderMode, selectInitialEncoderBackend } from '../src/utils/vaapi.js';

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
  proc.pid = 43211;
  return proc;
}

describe('NVIDIA NVENC detection, backend selection chain and encoder pipeline (Issue #36 Phase 3)', () => {
  let prevEncoderMode: string | undefined;
  let prevLibvaDriverName: string | undefined;
  let prevNvidiaVisibleDevices: string | undefined;
  let tmpDir: string;
  let encoder: VaapiEncoder | null = null;

  beforeEach(() => {
    prevEncoderMode = process.env.ENCODER_MODE;
    prevLibvaDriverName = process.env.LIBVA_DRIVER_NAME;
    prevNvidiaVisibleDevices = process.env.NVIDIA_VISIBLE_DEVICES;
    delete process.env.ENCODER_MODE;
    delete process.env.LIBVA_DRIVER_NAME;
    delete process.env.NVIDIA_VISIBLE_DEVICES;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-nvenc-'));
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

    if (prevLibvaDriverName === undefined) delete process.env.LIBVA_DRIVER_NAME;
    else process.env.LIBVA_DRIVER_NAME = prevLibvaDriverName;

    if (prevNvidiaVisibleDevices === undefined) delete process.env.NVIDIA_VISIBLE_DEVICES;
    else process.env.NVIDIA_VISIBLE_DEVICES = prevNvidiaVisibleDevices;

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('resolveEncoderMode accepts nvenc from override and env', () => {
    expect(resolveEncoderMode('NVENC')).toBe('nvenc');
    expect(resolveEncoderMode(' nvenc ')).toBe('nvenc');
    process.env.ENCODER_MODE = 'nvenc';
    expect(resolveEncoderMode()).toBe('nvenc');
    process.env.ENCODER_MODE = 'nvenc-x';
    expect(resolveEncoderMode()).toBe('auto');
  });

  it('selectInitialEncoderBackend prefers VAAPI, then NVENC, then software in auto mode and honors fixed modes', () => {
    // auto: capability chain vaapi -> nvenc -> software
    expect(
      selectInitialEncoderBackend('auto', {
        vaapiEncodeSupported: true,
        nvencEncodeSupported: true,
      }),
    ).toBe('vaapi');
    expect(
      selectInitialEncoderBackend('auto', {
        vaapiEncodeSupported: false,
        nvencEncodeSupported: true,
      }),
    ).toBe('nvenc');
    expect(
      selectInitialEncoderBackend('auto', {
        vaapiEncodeSupported: false,
        nvencEncodeSupported: false,
      }),
    ).toBe('software');

    // fixed modes ignore capability results
    expect(
      selectInitialEncoderBackend('nvenc', {
        vaapiEncodeSupported: true,
        nvencEncodeSupported: false,
      }),
    ).toBe('nvenc');
    expect(
      selectInitialEncoderBackend('vaapi', {
        vaapiEncodeSupported: false,
        nvencEncodeSupported: true,
      }),
    ).toBe('vaapi');
    expect(
      selectInitialEncoderBackend('software', {
        vaapiEncodeSupported: true,
        nvencEncodeSupported: true,
      }),
    ).toBe('software');
  });

  it('hasNvidiaDevice detects NVIDIA_VISIBLE_DEVICES exposure and /dev/nvidia* nodes, treating none/void as absent', () => {
    expect(hasNvidiaDevice({ env: {}, existsSync: () => false })).toBe(false);
    expect(
      hasNvidiaDevice({ env: { NVIDIA_VISIBLE_DEVICES: 'all' }, existsSync: () => false }),
    ).toBe(true);
    expect(
      hasNvidiaDevice({ env: { NVIDIA_VISIBLE_DEVICES: 'GPU-1uuid' }, existsSync: () => false }),
    ).toBe(true);
    expect(
      hasNvidiaDevice({ env: { NVIDIA_VISIBLE_DEVICES: 'none' }, existsSync: () => false }),
    ).toBe(false);
    expect(
      hasNvidiaDevice({ env: { NVIDIA_VISIBLE_DEVICES: 'void' }, existsSync: () => false }),
    ).toBe(false);
    expect(
      hasNvidiaDevice({
        env: {},
        existsSync: (p) => p === '/dev/nvidiactl',
      }),
    ).toBe(true);
  });

  it('detectNvencConfig gates the h264_nvenc probe on device exposure and reports failure reasons', () => {
    // No NVIDIA device exposed -> probe must not run
    const runProbeSpy = vi.fn();
    const absent = detectNvencConfig({
      env: {},
      existsSync: () => false,
      runNvencProbe: runProbeSpy,
    });
    expect(absent).toEqual({
      hasNvidiaDevice: false,
      nvencEncodeSupported: false,
      reason: expect.stringContaining('Container Toolkit'),
    });
    expect(runProbeSpy).not.toHaveBeenCalled();

    // Device exposed via toolkit fragment env + probe success
    const ok = detectNvencConfig({
      env: { NVIDIA_VISIBLE_DEVICES: 'all' },
      existsSync: () => false,
      runNvencProbe: (env) => {
        expect(env.NVIDIA_VISIBLE_DEVICES).toBe('all');
        return { status: 0, stdout: '' };
      },
    });
    expect(ok.hasNvidiaDevice).toBe(true);
    expect(ok.nvencEncodeSupported).toBe(true);

    // Device exposed but driver not mounted into the container -> probe failure with stderr reason
    const failed = detectNvencConfig({
      env: { NVIDIA_VISIBLE_DEVICES: 'all' },
      existsSync: () => false,
      runNvencProbe: () => ({
        status: 1,
        stdout: '',
        stderr: "Unknown encoder 'h264_nvenc'",
      }),
    });
    expect(failed.nvencEncodeSupported).toBe(false);
    expect(failed.reason).toContain('h264_nvenc 1-frame encode probe failed');
    expect(failed.reason).toContain("Unknown encoder 'h264_nvenc'");

    // spawn itself fails (ffmpeg missing) -> error path must not throw
    const errored = detectNvencConfig({
      env: { NVIDIA_VISIBLE_DEVICES: 'all' },
      existsSync: () => false,
      runNvencProbe: () => ({ status: null, stdout: '', error: new Error('ENOENT') }),
    });
    expect(errored.nvencEncodeSupported).toBe(false);
  });

  it('VaapiEncoder builds zero-latency h264_nvenc args for the nvenc backend and omits libva env scoping', () => {
    encoder = new VaapiEncoder({
      displayNum: ':95',
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: '1500k',
      encoderMode: 'auto',
      initialBackend: 'nvenc',
    });

    expect(encoder.getActiveBackend()).toBe('nvenc');
    expect(encoder.getEncoderStatus()).toMatchObject({
      backend: 'nvenc',
      encoderMode: 'auto',
      libvaDriverName: null,
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
      'h264_nvenc',
      '-preset',
      'p1',
      '-tune',
      'll',
      '-zerolatency',
      '1',
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
    expect(args.join(' ')).not.toContain('scale_vaapi');

    // NVENC must not force LIBVA_DRIVER_NAME / GALLIUM_DRIVER on the FFmpeg child
    const videoEnv = encoder.buildVideoEnv();
    expect(videoEnv.DISPLAY).toBe(':95');
    expect(videoEnv.LIBVA_DRIVER_NAME).toBeUndefined();
    expect(videoEnv.GALLIUM_DRIVER).toBeUndefined();
  });

  it('ENCODER_MODE=nvenc fixes the nvenc backend regardless of initialBackend', () => {
    encoder = new VaapiEncoder({ encoderMode: 'nvenc', initialBackend: 'vaapi' });
    expect(encoder.getEncoderMode()).toBe('nvenc');
    expect(encoder.getActiveBackend()).toBe('nvenc');
  });

  it('auto mode falls back nvenc -> software (libx264) on immediate NVENC exit; fixed nvenc mode keeps retrying NVENC', () => {
    vi.useFakeTimers();

    const spawnedProcs: ReturnType<typeof createFakeChildProcess>[] = [];
    spawnMock.mockImplementation(() => {
      const p = createFakeChildProcess();
      spawnedProcs.push(p);
      return p;
    });

    // auto: NVENC exits immediately -> softwareEncoder fallback, retry with libx264
    const fallbacks: EncoderFallbackEvent['option'][] = [];
    encoder = new VaapiEncoder({ encoderMode: 'auto', initialBackend: 'nvenc' });
    encoder.on('fallback', (ev: EncoderFallbackEvent) => fallbacks.push(ev.option));

    encoder.startVideo();
    expect(spawnMock.mock.calls[0][1]).toContain('h264_nvenc');

    spawnedProcs[0].emit('exit', 1, null);
    expect(fallbacks).toEqual(['softwareEncoder']);
    expect(encoder.getActiveBackend()).toBe('software');
    expect(encoder.getEncoderStatus().lastFallback?.option).toBe('softwareEncoder');

    vi.advanceTimersByTime(1000);
    expect(spawnedProcs).toHaveLength(2);
    expect(spawnMock.mock.calls[1][1]).toContain('libx264');
    encoder.stopVideo();

    // fixed nvenc mode: no silent downgrade, retries NVENC with backoff
    spawnMock.mockClear();
    spawnedProcs.length = 0;
    const fixedFallbacks: EncoderFallbackEvent['option'][] = [];
    const fixedEncoder = new VaapiEncoder({ encoderMode: 'nvenc' });
    encoder = fixedEncoder;
    fixedEncoder.on('fallback', (ev: EncoderFallbackEvent) => fixedFallbacks.push(ev.option));

    fixedEncoder.startVideo();
    expect(spawnMock.mock.calls[0][1]).toContain('h264_nvenc');
    spawnedProcs[0].emit('exit', 1, null);
    expect(fixedFallbacks).toEqual([]);
    expect(fixedEncoder.getActiveBackend()).toBe('nvenc');

    vi.advanceTimersByTime(1000);
    expect(spawnMock.mock.calls[1][1]).toContain('h264_nvenc');
  });
});
