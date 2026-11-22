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

import { BrowserManager } from '../src/browser/manager.js';
import { VaapiEncoder } from '../src/encoder/ffmpeg.js';
import { DEFAULT_LIBVA_DRIVER_NAME, resolveLibvaDriverName } from '../src/utils/vaapi.js';

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
  proc.pid = 12345;
  return proc;
}

describe('LIBVA_DRIVER_NAME inheritance & fallback (Issue #81)', () => {
  let prevLibvaDriverName: string | undefined;
  let tmpDir: string;
  let encoder: VaapiEncoder | null = null;

  beforeEach(() => {
    prevLibvaDriverName = process.env.LIBVA_DRIVER_NAME;
    delete process.env.LIBVA_DRIVER_NAME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-libva-test-'));
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => createFakeChildProcess());
  });

  afterEach(() => {
    if (encoder) {
      encoder.stopVideo();
      encoder = null;
    }
    if (prevLibvaDriverName === undefined) {
      delete process.env.LIBVA_DRIVER_NAME;
    } else {
      process.env.LIBVA_DRIVER_NAME = prevLibvaDriverName;
    }
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('resolveLibvaDriverName falls back to iHD when unset or blank and trims valid values', () => {
    expect(resolveLibvaDriverName()).toBe(DEFAULT_LIBVA_DRIVER_NAME);

    process.env.LIBVA_DRIVER_NAME = '';
    expect(resolveLibvaDriverName()).toBe('iHD');

    process.env.LIBVA_DRIVER_NAME = '   ';
    expect(resolveLibvaDriverName()).toBe('iHD');

    process.env.LIBVA_DRIVER_NAME = 'radeonsi';
    expect(resolveLibvaDriverName()).toBe('radeonsi');

    process.env.LIBVA_DRIVER_NAME = ' i965 ';
    expect(resolveLibvaDriverName()).toBe('i965');

    expect(resolveLibvaDriverName('d3d12')).toBe('d3d12');
    expect(resolveLibvaDriverName('  ')).toBe('i965');

    process.env.LIBVA_DRIVER_NAME = 'auto';
    expect(resolveLibvaDriverName()).toBe('iHD');
    process.env.LIBVA_DRIVER_NAME = 'AUTO';
    expect(resolveLibvaDriverName()).toBe('iHD');
    expect(resolveLibvaDriverName('Auto')).toBe('iHD');
  });

  it('BrowserManager.buildChromeEnv() defaults LIBVA_DRIVER_NAME to iHD when unset or empty', () => {
    const bm = new BrowserManager({ profileDir: tmpDir, displayNum: ':98' });

    expect(bm.buildChromeEnv().LIBVA_DRIVER_NAME).toBe('iHD');
    expect(bm.buildChromeEnv().DISPLAY).toBe(':98');

    process.env.LIBVA_DRIVER_NAME = '';
    expect(bm.buildChromeEnv().LIBVA_DRIVER_NAME).toBe('iHD');

    process.env.LIBVA_DRIVER_NAME = '   ';
    expect(bm.buildChromeEnv().LIBVA_DRIVER_NAME).toBe('iHD');
  });

  it('BrowserManager.buildChromeEnv() inherits LIBVA_DRIVER_NAME from process.env and honors explicit option', () => {
    const bm = new BrowserManager({ profileDir: tmpDir });

    for (const driver of ['radeonsi', 'i965', 'd3d12']) {
      process.env.LIBVA_DRIVER_NAME = driver;
      expect(bm.buildChromeEnv().LIBVA_DRIVER_NAME).toBe(driver);
    }

    process.env.LIBVA_DRIVER_NAME = ' radeonsi ';
    expect(bm.buildChromeEnv().LIBVA_DRIVER_NAME).toBe('radeonsi');

    const overriddenBm = new BrowserManager({
      profileDir: tmpDir,
      libvaDriverName: 'i965',
    });
    expect(overriddenBm.buildChromeEnv().LIBVA_DRIVER_NAME).toBe('i965');
  });

  it('VaapiEncoder.buildVideoEnv() defaults to iHD and inherits process.env.LIBVA_DRIVER_NAME', () => {
    encoder = new VaapiEncoder({ displayNum: ':97' });

    expect(encoder.buildVideoEnv().LIBVA_DRIVER_NAME).toBe('iHD');
    expect(encoder.buildVideoEnv().DISPLAY).toBe(':97');

    process.env.LIBVA_DRIVER_NAME = '';
    expect(encoder.buildVideoEnv().LIBVA_DRIVER_NAME).toBe('iHD');

    process.env.LIBVA_DRIVER_NAME = 'radeonsi';
    expect(encoder.buildVideoEnv().LIBVA_DRIVER_NAME).toBe('radeonsi');

    const overriddenEncoder = new VaapiEncoder({
      displayNum: ':97',
      libvaDriverName: 'd3d12',
    });
    expect(overriddenEncoder.buildVideoEnv().LIBVA_DRIVER_NAME).toBe('d3d12');
  });

  it('VaapiEncoder.startVideo() passes inherited LIBVA_DRIVER_NAME to spawned ffmpeg process', () => {
    process.env.LIBVA_DRIVER_NAME = 'radeonsi';
    encoder = new VaapiEncoder({ displayNum: ':96' });

    encoder.startVideo();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('ffmpeg');
    expect(Array.isArray(args)).toBe(true);
    expect(opts.env.DISPLAY).toBe(':96');
    expect(opts.env.LIBVA_DRIVER_NAME).toBe('radeonsi');

    encoder.stopVideo();
    spawnMock.mockClear();
    delete process.env.LIBVA_DRIVER_NAME;

    encoder.startVideo();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][2].env.LIBVA_DRIVER_NAME).toBe('iHD');
  });
});
