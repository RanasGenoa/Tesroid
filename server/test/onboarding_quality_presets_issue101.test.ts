import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth.js';
import { ConfigStore } from '../src/config.js';
import { LockoutManager } from '../src/lockout.js';
import { registerSetupRoutes } from '../src/routes/setup.js';

// Issue #101: オンボーディング 3 択（最高品質 / 標準 / 軽量）は新しいプリセット概念を永続化せず、
// POST /api/setup が既存の displayScale / stream.* フィールドへ初期値を一括反映する。
describe('Onboarding quality presets via POST /api/setup (Issue #101)', () => {
  let tmpDir: string;
  let app: FastifyInstance;
  let configStore: ConfigStore;
  let lockoutManager: LockoutManager;
  let authService: AuthService;
  let mockBrowser: any;
  let mockEncoder: any;
  let mockWsHandler: any;

  const setupAppWithBackend = async (backend: 'vaapi' | 'software') => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-setup-preset-'));
    configStore = new ConfigStore(tmpDir);
    lockoutManager = new LockoutManager(tmpDir);
    authService = new AuthService(configStore, lockoutManager);

    mockBrowser = {
      getState: vi.fn(() => 'running'),
      getCurrentUrl: vi.fn(() => 'https://www.youtube.com'),
      setLocale: vi.fn(),
      setTimezone: vi.fn(),
      setDisplayScale: vi.fn(async () => {}),
    };

    mockEncoder = {
      isRunning: vi.fn(() => true),
      start: vi.fn(),
      stop: vi.fn(),
      getActiveBackend: vi.fn(() => backend),
      updateConfig: vi.fn(async () => {}),
    };

    mockWsHandler = {
      hasActiveClients: vi.fn(() => false),
      syncEncodeDimensionsFromConfig: vi.fn(async () => {}),
    };

    app = Fastify();
    registerSetupRoutes(
      app,
      configStore,
      authService,
      lockoutManager,
      mockBrowser,
      mockWsHandler,
      mockEncoder,
    );
    await app.ready();
  };

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('lightweight maps to existing settings fields (MCU2): low_power + lightweight profile + 70% scale', async () => {
    await setupAppWithBackend('vaapi');
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { pin: '1234', qualityPreset: 'lightweight' },
    });
    expect(res.statusCode).toBe(200);

    const config = configStore.getConfig();
    expect(config.displayScale).toBe(70);
    expect(config.stream.clientProfile).toEqual({ profile: 'lightweight' });
    expect(config.stream.performancePreset).toBe('low_power');
    expect(config.stream.maxSize).toBe(960);
    expect(config.stream.maxFps).toBe(24);
    expect(config.stream.bitrate).toBe(500_000);

    // 稼働中のズーム / エンコーダ / 寸法へ即時反映される
    expect(mockBrowser.setDisplayScale).toHaveBeenCalledWith(70);
    const encoderCall = mockEncoder.updateConfig.mock.calls[0]?.[0];
    expect(encoderCall).toMatchObject({ fps: 24, bitrate: 500_000, compressionLevel: 7 });
    expect(encoderCall.x264Preset).toBeUndefined();
    expect(mockWsHandler.syncEncodeDimensionsFromConfig).toHaveBeenCalledTimes(1);
  });

  it('high maps to high quality fields and snaps to CPU presets on software backend (Issue #90 policy)', async () => {
    await setupAppWithBackend('software');
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { pin: '1234', qualityPreset: 'high' },
    });
    expect(res.statusCode).toBe(200);

    const config = configStore.getConfig();
    expect(config.displayScale).toBe(120);
    expect(config.stream.clientProfile).toEqual({ profile: 'standard' });
    // CPU (libx264) 環境では cpu_balanced へ安全マップ（maxSize 1280 / veryfast）
    expect(config.stream.performancePreset).toBe('cpu_balanced');
    expect(config.stream.x264Preset).toBe('veryfast');
    expect(config.stream.maxSize).toBe(1280);
    expect(config.stream.maxFps).toBe(60);
    expect(config.stream.bitrate).toBe(2_000_000);

    const encoderCall = mockEncoder.updateConfig.mock.calls[0]?.[0];
    expect(encoderCall).toMatchObject({ fps: 60, bitrate: 2_000_000, x264Preset: 'veryfast' });
    // CPU プリセットでは保存済みの VAAPI 調整値を config 上で変更しない (settings PUT と同一意味論)
    expect(config.stream.vaapiCompressionLevel).toBe(7);
    expect(config.stream.vaapiLowPower).toBe(false);
    expect(config.stream.vaapiGpuColorConversion).toBe(true);
  });

  it('high on VAAPI backend maps to GPU high preset (1920px / compression 4)', async () => {
    await setupAppWithBackend('vaapi');
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { pin: '1234', qualityPreset: 'HIGH' }, // 大文字混在も正規化して受け付ける
    });
    expect(res.statusCode).toBe(200);

    const config = configStore.getConfig();
    expect(config.stream.performancePreset).toBe('high');
    expect(config.stream.maxSize).toBe(1920);
    expect(config.stream.vaapiCompressionLevel).toBe(4);
    expect(config.stream.maxFps).toBe(60);
    expect(config.stream.bitrate).toBe(2_000_000);
  });

  it('standard matches the existing defaults and is the fallback for unknown values', async () => {
    await setupAppWithBackend('vaapi');
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { pin: '1234', qualityPreset: 'ultra-max' }, // 未知の値
    });
    expect(res.statusCode).toBe(200);

    const config = configStore.getConfig();
    // 未知値は従来デフォルトを維持（standard と同一値: balanced / 30fps / 1M / displayScale 120）
    expect(config.stream.performancePreset).toBe('balanced');
    expect(config.stream.maxFps).toBe(30);
    expect(config.stream.bitrate).toBe(1_000_000);
    expect(config.displayScale).toBe(120);
    // 未指定・未知値では既存の stream / ズームへ一切触れない
    expect(mockEncoder.updateConfig).not.toHaveBeenCalled();
    expect(mockBrowser.setDisplayScale).not.toHaveBeenCalled();
    expect(mockWsHandler.syncEncodeDimensionsFromConfig).not.toHaveBeenCalled();
  });

  it('omitting qualityPreset keeps the previous behavior untouched (no stream / zoom writes)', async () => {
    await setupAppWithBackend('vaapi');
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { pin: '1234', allowedDomains: ['tesroid.example.com'] },
    });
    expect(res.statusCode).toBe(200);

    const config = configStore.getConfig();
    expect(config.stream.performancePreset).toBe('balanced');
    expect(config.stream.maxFps).toBe(30);
    expect(config.stream.bitrate).toBe(1_000_000);
    expect(config.stream.clientProfile).toEqual({ profile: 'standard' });
    expect(mockEncoder.updateConfig).not.toHaveBeenCalled();
    expect(mockBrowser.setDisplayScale).not.toHaveBeenCalled();

    // 既存のセキュリティ境界（2回目のセットアップは 403）は不変
    const second = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { pin: '5678' },
    });
    expect(second.statusCode).toBe(403);
  });

  it('setup still succeeds even when live re-apply fails, and one failing system does not skip the others (PR #102 2nd レビュー M)', async () => {
    await setupAppWithBackend('vaapi');
    mockBrowser.setDisplayScale = vi.fn(async () => {
      throw new Error('CDP zoom error right after boot');
    });
    mockEncoder.updateConfig = vi.fn(async () => {
      throw new Error('encoder restart failed');
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { pin: '1234', qualityPreset: 'lightweight' },
    });
    expect(res.statusCode).toBe(200);
    expect(configStore.getConfig().stream.performancePreset).toBe('low_power');
    // ズーム失敗でもエンコーダ反映・寸法同期までスキップされない
    expect(mockEncoder.updateConfig).toHaveBeenCalledTimes(1);
    expect(mockWsHandler.syncEncodeDimensionsFromConfig).toHaveBeenCalledTimes(1);
  });
});
