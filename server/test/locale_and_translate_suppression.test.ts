import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth.js';
import { BrowserManager } from '../src/browser/manager.js';
import { ConfigStore } from '../src/config.js';
import { LockoutManager } from '../src/lockout.js';
import { registerSettingsRoutes } from '../src/routes/settings.js';
import { registerSetupRoutes } from '../src/routes/setup.js';

describe('Locale Setting & Chrome Translation Modal Suppression', () => {
  let tmpDir: string;
  let profileDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-locale-test-'));
    profileDir = path.join(tmpDir, 'browser-profile');
    fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('initializes with default locale ja-JP and updates via setLocale', () => {
    const bm = new BrowserManager({ profileDir });
    expect(bm.getLocale()).toBe('ja-JP');

    bm.setLocale('en-US');
    expect(bm.getLocale()).toBe('en-US');
  });

  it('writes translate: { enabled: false } and Japanese accept_languages to Chrome Preferences', () => {
    const bm = new BrowserManager({ profileDir, locale: 'ja-JP' });
    const prefsPath = path.join(profileDir, 'Default', 'Preferences');

    // Pre-populate with existing arbitrary preferences
    fs.writeFileSync(
      prefsPath,
      JSON.stringify({
        browser: { check_default_browser: false },
        translate: { enabled: true },
      }),
      'utf-8',
    );

    bm.applyChromePreferences();

    const updated = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
    // Preserve existing keys
    expect(updated.browser.check_default_browser).toBe(false);
    // Disable translate popup
    expect(updated.translate.enabled).toBe(false);
    // Prefer Japanese languages
    expect(updated.intl.accept_languages).toBe('ja-JP,ja,en-US,en');
    expect(updated.intl.selected_languages).toBe('ja-JP,ja,en-US,en');
  });

  it('configures Chrome spawn arguments with Translate disabled and Japanese lang switches', () => {
    const bm = new BrowserManager({ profileDir, locale: 'ja-JP' });

    const args = bm.buildChromeArgs('https://www.youtube.com');
    const env = bm.buildChromeEnv();

    // Verify args:
    expect(args).toContain('--lang=ja-JP');
    expect(args).toContain('--accept-lang=ja-JP,ja,en-US,en');
    expect(args).toContain('--disable-translate');
    expect(args).toContain('--disable-features=Av1Decoder,AudioServiceSandbox,Translate');
    expect(args).toContain('--app=https://www.youtube.com');

    // Verify Linux system locale env:
    expect(env.LANG).toBe('ja_JP.UTF-8');
    expect(env.LANGUAGE).toBe('ja_JP:ja');
    expect(env.LC_ALL).toBe('ja_JP.UTF-8');
  });

  it('POST /api/setup persists custom locale and timezone into ConfigStore and updates BrowserManager', async () => {
    const configStore = new ConfigStore(tmpDir);
    const lockoutManager = new LockoutManager(tmpDir);
    const authService = new AuthService(configStore, lockoutManager);

    const mockBrowser = {
      getState: vi.fn(() => 'stopped'),
      getCurrentUrl: vi.fn(() => 'https://www.youtube.com'),
      setLocale: vi.fn(),
    } as unknown as BrowserManager;

    const app = fastify();
    registerSetupRoutes(app, configStore, authService, lockoutManager, mockBrowser);

    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: {
        pin: '1234',
        allowedDomains: ['example.com'],
        locale: 'ja-JP',
        timezone: 'Asia/Tokyo',
      },
    });

    expect(res.statusCode).toBe(200);
    const savedConfig = configStore.getConfig();
    expect(savedConfig.locale).toBe('ja-JP');
    expect(savedConfig.timezone).toBe('Asia/Tokyo');
    expect(mockBrowser.setLocale).toHaveBeenCalledWith('ja-JP');
  });

  it('GET and PUT /api/settings manage locale and timezone correctly', async () => {
    const configStore = new ConfigStore(tmpDir);
    const lockoutManager = new LockoutManager(tmpDir);
    const authService = new AuthService(configStore, lockoutManager);
    await authService.setPin('1234');
    const authRes = await authService.verifyPin('1234');
    const token = authRes.token!;

    const mockBrowser = {
      getState: vi.fn(() => 'running'),
      getCurrentUrl: vi.fn(() => 'https://www.youtube.com'),
      setDisplayScale: vi.fn(async () => true),
      setLocale: vi.fn(),
    } as unknown as BrowserManager;

    const app = fastify();
    registerSettingsRoutes(app, configStore, authService, mockBrowser);

    // 1. GET /api/settings returns default/saved locale & timezone
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.body);
    expect(getBody.locale).toBe('ja-JP');
    expect(getBody.timezone).toBe('Asia/Tokyo');

    // 2. PUT /api/settings updates locale & timezone
    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        locale: 'en-US',
        timezone: 'America/New_York',
      },
    });
    expect(putRes.statusCode).toBe(200);
    const saved = configStore.getConfig();
    expect(saved.locale).toBe('en-US');
    expect(saved.timezone).toBe('America/New_York');
    expect(mockBrowser.setLocale).toHaveBeenCalledWith('en-US');
  });
});
