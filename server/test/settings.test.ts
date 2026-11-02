import { describe, it, expect, vi, afterAll } from 'vitest';
import fastify from 'fastify';
import { registerSettingsRoutes } from '../src/routes/settings.js';
import { ConfigStore } from '../src/config.js';
import { AuthService } from '../src/auth.js';
import { LockoutManager } from '../src/lockout.js';
import { BrowserManager } from '../src/browser/manager.js';
import { VaapiEncoder } from '../src/encoder/ffmpeg.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Settings Routes & Dynamic Stream Config', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-settings-'));

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('should update config and call encoder.updateConfig when stream settings change', async () => {
    const configStore = new ConfigStore(tmpDir);
    const lockoutManager = new LockoutManager(tmpDir);
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
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        stream: {
          maxFps: 30,
          bitrate: 3000000,
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const updated = configStore.getConfig();
    expect(updated.stream.maxFps).toBe(30);
    expect(updated.stream.bitrate).toBe(3000000);

    expect(mockEncoder.updateConfig).toHaveBeenCalledWith({
      fps: 30,
      bitrate: 3000000,
    });
  });

  it('should support low bitrate settings (500000 bps for 0.5Mbps)', async () => {
    const configStore = new ConfigStore(tmpDir);
    const lockoutManager = new LockoutManager(tmpDir);
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
      payload: {
        stream: {
          maxFps: 30,
          bitrate: 500000, // 0.5 Mbps
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(configStore.getConfig().stream.bitrate).toBe(500000);
    expect(mockEncoder.updateConfig).toHaveBeenCalledWith({
      fps: 30,
      bitrate: 500000,
    });
  });

  it('should default displayScale to 120% and persist displayScale updates via BrowserManager', async () => {
    const configStore = new ConfigStore(tmpDir + '-scale');
    expect(configStore.getConfig().displayScale).toBe(120);

    const lockoutManager = new LockoutManager(tmpDir + '-scale');
    const authService = new AuthService(configStore, lockoutManager);
    await authService.setPin('1234');
    const tokenResult = await authService.verifyPin('1234');
    const token = tokenResult.token;

    const browserManager = {
      getState: vi.fn().mockReturnValue('active'),
      getCurrentUrl: vi.fn().mockReturnValue('https://www.youtube.com'),
      navigate: vi.fn().mockResolvedValue(undefined),
      setDisplayScale: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserManager;

    const app = fastify();
    registerSettingsRoutes(app, configStore, authService, browserManager);

    const getRes = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().displayScale).toBe(120);

    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        displayScale: 130,
      },
    });
    expect(putRes.statusCode).toBe(200);
    expect(configStore.getConfig().displayScale).toBe(130);
    expect(browserManager.setDisplayScale).toHaveBeenCalledWith(130);

    try {
      fs.rmSync(tmpDir + '-scale', { recursive: true, force: true });
    } catch {}
  });
});
