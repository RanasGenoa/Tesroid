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

describe('Locale Setting & Chrome Translation / Password Bubble Suppression', () => {
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

  it('initializes with default locale ja-JP & Asia/Tokyo and updates via setLocale & setTimezone', () => {
    const bm = new BrowserManager({ profileDir });
    expect(bm.getLocale()).toBe('ja-JP');
    expect(bm.getTimezone()).toBe('Asia/Tokyo');

    bm.setLocale('en-US');
    bm.setTimezone('America/New_York');
    expect(bm.getLocale()).toBe('en-US');
    expect(bm.getTimezone()).toBe('America/New_York');
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

  it('suppresses Chrome password save and autofill Views Bubbles while preserving profile exit state', () => {
    const bm = new BrowserManager({ profileDir, locale: 'ja-JP' });
    const defaultPrefsPath = path.join(profileDir, 'Default', 'Preferences');
    const rootPrefsPath = path.join(profileDir, 'Preferences');

    // Pre-populate both Default/Preferences (already Normal) and root Preferences (Crashed -> cleaned)
    fs.writeFileSync(
      defaultPrefsPath,
      JSON.stringify({
        browser: { check_default_browser: false },
        credentials_enable_service: true,
        credentials_enable_autosignin: true,
        profile: {
          name: 'Person 1',
          exit_type: 'Normal',
          exited_cleanly: true,
          password_manager_enabled: true,
          password_manager_leak_detection: true,
        },
        autofill: {
          profile_enabled: true,
          credit_card_enabled: true,
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(
      rootPrefsPath,
      JSON.stringify({
        profile: {
          exit_type: 'Crashed',
          exited_cleanly: false,
        },
      }),
      'utf-8',
    );

    (bm as any).cleanProfileLocks();
    bm.applyChromePreferences();

    for (const prefPath of [defaultPrefsPath, rootPrefsPath]) {
      const updated = JSON.parse(fs.readFileSync(prefPath, 'utf-8'));
      expect(updated.credentials_enable_service).toBe(false);
      expect(updated.credentials_enable_autosignin).toBe(false);
      expect(updated.profile.password_manager_enabled).toBe(false);
      expect(updated.profile.password_manager_leak_detection).toBe(false);
      expect(updated.autofill.profile_enabled).toBe(false);
      expect(updated.autofill.credit_card_enabled).toBe(false);
      expect(updated.profile.exit_type).toBe('Normal');
      expect(updated.profile.exited_cleanly).toBe(true);
    }

    const updatedDefault = JSON.parse(fs.readFileSync(defaultPrefsPath, 'utf-8'));
    expect(updatedDefault.browser.check_default_browser).toBe(false);
    expect(updatedDefault.profile.name).toBe('Person 1');
  });

  it('creates Default/Preferences with password and autofill suppression on a fresh profile', () => {
    const freshProfileDir = path.join(tmpDir, 'fresh-profile');
    const bm = new BrowserManager({ profileDir: freshProfileDir, locale: 'ja-JP' });

    bm.applyChromePreferences();

    const defaultPrefsPath = path.join(freshProfileDir, 'Default', 'Preferences');
    const created = JSON.parse(fs.readFileSync(defaultPrefsPath, 'utf-8'));
    expect(created.credentials_enable_service).toBe(false);
    expect(created.credentials_enable_autosignin).toBe(false);
    expect(created.profile.password_manager_enabled).toBe(false);
    expect(created.profile.password_manager_leak_detection).toBe(false);
    expect(created.autofill.profile_enabled).toBe(false);
    expect(created.autofill.credit_card_enabled).toBe(false);
  });

  it('configures Chrome spawn arguments with Translate disabled, basic password store, Japanese lang switches, and TZ env', () => {
    const bm = new BrowserManager({ profileDir, locale: 'ja-JP', timezone: 'Asia/Tokyo' });

    const args = bm.buildChromeArgs('https://www.youtube.com');
    const env = bm.buildChromeEnv();

    // Verify args:
    expect(args).toContain('--lang=ja-JP');
    expect(args).toContain('--accept-lang=ja-JP,ja,en-US,en');
    expect(args).toContain('--disable-translate');
    expect(args).toContain('--disable-features=Av1Decoder,AudioServiceSandbox,Translate');
    expect(args).toContain('--password-store=basic');
    expect(args).toContain('--app=https://www.youtube.com');

    // Verify Linux system locale env & TZ:
    expect(env.TZ).toBe('Asia/Tokyo');
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
      setTimezone: vi.fn(),
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
    expect(mockBrowser.setTimezone).toHaveBeenCalledWith('Asia/Tokyo');
  });

  it('GET and PUT /api/settings manage locale and timezone correctly and reject invalid values', async () => {
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
      setTimezone: vi.fn(),
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
    expect(mockBrowser.setTimezone).toHaveBeenCalledWith('America/New_York');

    // 3. PUT /api/settings rejects invalid locale with 400 and preserves existing settings
    const badLocaleRes = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        locale: 'invalid-locale-hack',
      },
    });
    expect(badLocaleRes.statusCode).toBe(400);
    expect(configStore.getConfig().locale).toBe('en-US');

    // 4. PUT /api/settings rejects invalid timezone with 400 and preserves existing settings
    const badTzRes = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        timezone: 'Invalid/NonExistent_Zone',
      },
    });
    expect(badTzRes.statusCode).toBe(400);
    expect(configStore.getConfig().timezone).toBe('America/New_York');
  });
});
