import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth.js';
import type { BrowserManager } from '../src/browser/manager.js';
import { ConfigStore, PERFORMANCE_PRESET_DEFAULTS } from '../src/config.js';
import { VaapiEncoder } from '../src/encoder/ffmpeg.js';
import { LockoutManager } from '../src/lockout.js';
import { registerSettingsRoutes } from '../src/routes/settings.js';

describe('CPU encoder presets & backend-aware options (Issue #90)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-issue90-'));

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('CPU presets define only maxSize + x264Preset and never carry VAAPI tuning', () => {
    expect(PERFORMANCE_PRESET_DEFAULTS.cpu_balanced).toEqual({
      maxSize: 1280,
      x264Preset: 'veryfast',
    });
    expect(PERFORMANCE_PRESET_DEFAULTS.cpu_low_power).toEqual({
      maxSize: 960,
      x264Preset: 'ultrafast',
    });
    // GPUプリセットはx264Presetを含まない（相互非混入の担保）
    for (const name of ['high', 'balanced', 'low_power'] as const) {
      expect(PERFORMANCE_PRESET_DEFAULTS[name].x264Preset).toBeUndefined();
    }
  });

  it('software backend keeps -preset ultrafast by default and accepts whitelisted x264 presets', () => {
    const def = new VaapiEncoder({ encoderMode: 'software' });
    expect(def.getX264Preset()).toBe('ultrafast');
    const args = def.buildVideoArgs();
    const idx = args.indexOf('-preset');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('ultrafast');

    const tuned = new VaapiEncoder({ encoderMode: 'software', x264Preset: 'veryfast' });
    expect(tuned.getX264Preset()).toBe('veryfast');
    const tunedArgs = tuned.buildVideoArgs();
    const tunedIdx = tunedArgs.indexOf('-preset');
    expect(tunedArgs[tunedIdx + 1]).toBe('veryfast');

    // ホワイトリスト外の値は安全側（既定 ultrafast）へフォールバック
    const invalid = new VaapiEncoder({ encoderMode: 'software', x264Preset: 'veryslow' });
    expect(invalid.getX264Preset()).toBe('ultrafast');
  });

  it('PUT /api/settings applies cpu_low_power preset (maxSize/x264Preset) and forwards it to the encoder', async () => {
    const configStore = new ConfigStore(`${tmpDir}-cpu`);
    const lockoutManager = new LockoutManager(`${tmpDir}-cpu`);
    const authService = new AuthService(configStore, lockoutManager);
    await authService.setPin('1234');
    const tokenResult = await authService.verifyPin('1234');
    const token = tokenResult.token;

    const browserManager = {
      getState: vi.fn().mockReturnValue('active'),
      getCurrentUrl: vi.fn().mockReturnValue('https://www.youtube.com'),
      navigate: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserManager;

    const mockEncoder = {
      updateConfig: vi.fn().mockResolvedValue(undefined),
    } as unknown as VaapiEncoder;

    const app = fastify();
    registerSettingsRoutes(app, configStore, authService, browserManager, mockEncoder);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { stream: { performancePreset: 'cpu_low_power' } },
    });
    expect(res.statusCode).toBe(200);

    const updated = configStore.getConfig().stream;
    expect(updated.performancePreset).toBe('cpu_low_power');
    expect(updated.maxSize).toBe(960);
    expect(updated.x264Preset).toBe('ultrafast');
    // CPUプリセットはVAAPI調整値を変更しない（既存の安全側既定値を維持）
    expect(updated.vaapiGpuColorConversion).toBe(true);

    expect(mockEncoder.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ x264Preset: 'ultrafast' }),
    );
  });

  it('PUT /api/settings rejects unknown presets and keeps the current preset unchanged', async () => {
    const configStore = new ConfigStore(`${tmpDir}-reject`);
    const lockoutManager = new LockoutManager(`${tmpDir}-reject`);
    const authService = new AuthService(configStore, lockoutManager);
    await authService.setPin('1234');
    const tokenResult = await authService.verifyPin('1234');
    const token = tokenResult.token;

    const browserManager = {
      getState: vi.fn().mockReturnValue('active'),
      getCurrentUrl: vi.fn().mockReturnValue('https://www.youtube.com'),
      navigate: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserManager;

    const app = fastify();
    registerSettingsRoutes(app, configStore, authService, browserManager);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { stream: { performancePreset: 'nvidia_nvenc' } },
    });
    expect(res.statusCode).toBe(200);
    expect(configStore.getConfig().stream.performancePreset).toBe('balanced');

    // 未知のx264 preset文字列も保持側（current）に落ちる
    const res2 = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { stream: { x264Preset: 'placebo' } },
    });
    expect(res2.statusCode).toBe(200);
    expect(configStore.getConfig().stream.x264Preset).toBeUndefined();
  });
});
