import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth.js';
import type { BrowserManager } from '../src/browser/manager.js';
import { ConfigStore } from '../src/config.js';
import { VaapiEncoder } from '../src/encoder/ffmpeg.js';
import { LockoutManager } from '../src/lockout.js';
import { registerSettingsRoutes } from '../src/routes/settings.js';

describe('Audio Bitrate Setting (Issue 10) - Backend Tests', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-audio-bitrate-'));

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('ConfigStore & Audio Bitrate Defaults/Persistence', () => {
    it('defaults audioBitrate to 128000 bps (128kbps) and persists updates', () => {
      const configStore = new ConfigStore(path.join(tmpDir, 'default-test'));
      const config = configStore.getConfig();

      expect(config.stream.audioBitrate).toBe(128000);

      configStore.updateConfig({
        stream: {
          ...config.stream,
          audioBitrate: 256000,
        },
      });

      const updated = configStore.getConfig();
      expect(updated.stream.audioBitrate).toBe(256000);

      // Verify persistence from disk
      const reloadedStore = new ConfigStore(path.join(tmpDir, 'default-test'));
      expect(reloadedStore.getConfig().stream.audioBitrate).toBe(256000);
    });

    it('migrates legacy config files missing audioBitrate to 128000 bps', () => {
      const legacyDir = path.join(tmpDir, 'legacy-test');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(
        path.join(legacyDir, 'config.json'),
        JSON.stringify({
          isSetupCompleted: true,
          stream: {
            bitrate: 2000000,
            maxFps: 30,
            maxSize: 1280,
          },
        }),
      );

      const store = new ConfigStore(legacyDir);
      expect(store.getConfig().stream.audioBitrate).toBe(128000);
    });
  });

  describe('VaapiEncoder Audio Bitrate Parsing, Formatting & Independent Audio Restart', () => {
    it('accurately parses and clamps audio bitrate between 128k and 320k', () => {
      const encoder = new VaapiEncoder({ audioBitrate: '192k' });

      expect(encoder.getAudioBitrate()).toBe('192k');
      expect(encoder.getAudioBitrateBps()).toBe(192000);

      // Numeric inputs
      expect(encoder.parseAudioBitrateBps(128000)).toBe(128000);
      expect(encoder.parseAudioBitrateBps(128)).toBe(128000); // kbps shorthand
      expect(encoder.parseAudioBitrateBps(192000)).toBe(192000);
      expect(encoder.parseAudioBitrateBps(256000)).toBe(256000);
      expect(encoder.parseAudioBitrateBps(320000)).toBe(320000);
      expect(encoder.parseAudioBitrateBps(320)).toBe(320000);

      // String inputs
      expect(encoder.parseAudioBitrateBps('128k')).toBe(128000);
      expect(encoder.parseAudioBitrateBps('192k')).toBe(192000);
      expect(encoder.parseAudioBitrateBps('256k')).toBe(256000);
      expect(encoder.parseAudioBitrateBps('320k')).toBe(320000);

      // Clamping limits
      expect(encoder.parseAudioBitrateBps(64000)).toBe(128000); // clamped to min
      expect(encoder.parseAudioBitrateBps('64k')).toBe(128000);
      expect(encoder.parseAudioBitrateBps(500000)).toBe(320000); // clamped to max
      expect(encoder.parseAudioBitrateBps('500k')).toBe(320000);

      // Formatting
      expect(encoder.formatAudioBitrate(128000)).toBe('128k');
      expect(encoder.formatAudioBitrate('192k')).toBe('192k');
      expect(encoder.formatAudioBitrate(256000)).toBe('256k');
      expect(encoder.formatAudioBitrate(320000)).toBe('320k');
    });

    it('restartAudio() restarts ONLY audio process without disturbing video encoder or PTS baseline', async () => {
      const encoder = new VaapiEncoder({ audioBitrate: '128k' });

      const startVideoSpy = vi.spyOn(encoder as any, 'startVideo').mockImplementation(() => {});
      const stopVideoSpy = vi.spyOn(encoder as any, 'stopVideo').mockImplementation(() => {});
      const startAudioSpy = vi.spyOn(encoder as any, 'startAudio').mockImplementation(() => {});
      const stopAudioSpy = vi.spyOn(encoder as any, 'stopAudio').mockImplementation(() => {});

      // Seed mock state
      const initialBaseline = (encoder as any).streamStartTimeUs;
      (encoder as any).cachedOpusHead = Buffer.from('OpusHead-Old');
      (encoder as any).cachedSpsPps = Buffer.from('SPS-PPS-Video');

      await encoder.restartAudio('256k');

      // Video must NOT have been touched
      expect(stopVideoSpy).not.toHaveBeenCalled();
      expect(startVideoSpy).not.toHaveBeenCalled();
      expect((encoder as any).cachedSpsPps).toEqual(Buffer.from('SPS-PPS-Video'));

      // Audio must have been stopped and restarted with new bitrate
      expect(stopAudioSpy).toHaveBeenCalledTimes(1);
      expect(startAudioSpy).toHaveBeenCalledTimes(1);
      expect(encoder.getAudioBitrate()).toBe('256k');
      expect(encoder.getCachedOpusHead()).toBeNull();

      // Stream timing baseline must be preserved to prevent A/V drift
      expect((encoder as any).streamStartTimeUs).toBe(initialBaseline);
    });

    it('updateConfig() routes audioBitrate-only updates exclusively to restartAudio', async () => {
      const encoder = new VaapiEncoder();

      const restartSpy = vi.spyOn(encoder, 'restart').mockResolvedValue(undefined);
      const restartAudioSpy = vi.spyOn(encoder, 'restartAudio').mockResolvedValue(undefined);

      // Only audioBitrate changed
      await encoder.updateConfig({ audioBitrate: 320000 });
      expect(restartAudioSpy).toHaveBeenCalledWith(320000);
      expect(restartSpy).not.toHaveBeenCalled();

      // Only video changed
      restartAudioSpy.mockClear();
      restartSpy.mockClear();
      await encoder.updateConfig({ bitrate: 2000000, fps: 30 });
      expect(restartSpy).toHaveBeenCalled();
      expect(restartAudioSpy).not.toHaveBeenCalled();

      // Both changed: videoNeedsRestart triggers coordinated restart with audioBitrate as 5th argument
      restartAudioSpy.mockClear();
      restartSpy.mockClear();
      await encoder.updateConfig({ bitrate: 2000000, audioBitrate: 192000 });
      expect(restartSpy).toHaveBeenCalledWith(undefined, undefined, undefined, 2000000, 192000);
      expect(restartAudioSpy).not.toHaveBeenCalled();
    });
  });

  describe('Settings Routes (Fastify) Integration', () => {
    it('GET /api/settings includes stream.audioBitrate', async () => {
      const configStore = new ConfigStore(path.join(tmpDir, 'routes-test'));
      const lockoutManager = new LockoutManager(path.join(tmpDir, 'routes-test'));
      const authService = new AuthService(configStore, lockoutManager);
      await authService.setPin('1234');
      const { token } = await authService.verifyPin('1234');

      const browserManager = {
        getState: vi.fn().mockReturnValue('active'),
        getCurrentUrl: vi.fn().mockReturnValue('https://www.youtube.com'),
      } as unknown as BrowserManager;

      const app = fastify();
      registerSettingsRoutes(app, configStore, authService, browserManager);

      const res = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.stream).toBeDefined();
      expect(data.stream.audioBitrate).toBe(128000);
    });

    it('PUT /api/settings updates audioBitrate and notifies encoder', async () => {
      const configStore = new ConfigStore(path.join(tmpDir, 'routes-test-2'));
      const lockoutManager = new LockoutManager(path.join(tmpDir, 'routes-test-2'));
      const authService = new AuthService(configStore, lockoutManager);
      await authService.setPin('1234');
      const { token } = await authService.verifyPin('1234');

      const browserManager = {
        getState: vi.fn().mockReturnValue('active'),
        getCurrentUrl: vi.fn().mockReturnValue('https://www.youtube.com'),
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
            audioBitrate: 256000,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(configStore.getConfig().stream.audioBitrate).toBe(256000);
      expect(mockEncoder.updateConfig).toHaveBeenCalledWith({
        fps: undefined,
        bitrate: undefined,
        audioBitrate: 256000,
      });
    });

    it('PUT /api/settings accepts shorthand kbps value (e.g. 192 -> 192000)', async () => {
      const configStore = new ConfigStore(path.join(tmpDir, 'routes-test-3'));
      const lockoutManager = new LockoutManager(path.join(tmpDir, 'routes-test-3'));
      const authService = new AuthService(configStore, lockoutManager);
      await authService.setPin('1234');
      const { token } = await authService.verifyPin('1234');

      const browserManager = {
        getState: vi.fn().mockReturnValue('active'),
        getCurrentUrl: vi.fn().mockReturnValue('https://www.youtube.com'),
      } as unknown as BrowserManager;

      const app = fastify();
      registerSettingsRoutes(app, configStore, authService, browserManager);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          stream: {
            audioBitrate: 192,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(configStore.getConfig().stream.audioBitrate).toBe(192000);
    });

    it('PUT /api/settings accepts string format with units (e.g. "256k" -> 256000)', async () => {
      const configStore = new ConfigStore(path.join(tmpDir, 'routes-test-string'));
      const lockoutManager = new LockoutManager(path.join(tmpDir, 'routes-test-string'));
      const authService = new AuthService(configStore, lockoutManager);
      await authService.setPin('1234');
      const { token } = await authService.verifyPin('1234');

      const browserManager = {
        getState: vi.fn().mockReturnValue('active'),
        getCurrentUrl: vi.fn().mockReturnValue('https://www.youtube.com'),
      } as unknown as BrowserManager;

      const app = fastify();
      registerSettingsRoutes(app, configStore, authService, browserManager);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          stream: {
            audioBitrate: '256k',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(configStore.getConfig().stream.audioBitrate).toBe(256000);
    });

    it('PUT /api/settings rejects audioBitrate outside 128k - 320k range with 400 Bad Request', async () => {
      const configStore = new ConfigStore(path.join(tmpDir, 'routes-test-4'));
      const lockoutManager = new LockoutManager(path.join(tmpDir, 'routes-test-4'));
      const authService = new AuthService(configStore, lockoutManager);
      await authService.setPin('1234');
      const { token } = await authService.verifyPin('1234');

      const browserManager = {
        getState: vi.fn().mockReturnValue('active'),
        getCurrentUrl: vi.fn().mockReturnValue('https://www.youtube.com'),
      } as unknown as BrowserManager;

      const app = fastify();
      registerSettingsRoutes(app, configStore, authService, browserManager);

      // Too low (< 128k)
      const resLow = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          stream: {
            audioBitrate: 64000,
          },
        },
      });
      expect(resLow.statusCode).toBe(400);
      expect(resLow.json().error).toMatch(/between 128000 and 320000 bps/);

      // Too high (> 320k)
      const resHigh = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          stream: {
            audioBitrate: 500000,
          },
        },
      });
      expect(resHigh.statusCode).toBe(400);
      expect(resHigh.json().error).toMatch(/between 128000 and 320000 bps/);
    });
  });
});
