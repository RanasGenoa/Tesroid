import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConfigStore } from '../src/config.js';
import { LockoutManager } from '../src/lockout.js';
import { AuthService } from '../src/auth.js';
import { registerHealthRoutes } from '../src/routes/health.js';
import { registerSetupRoutes } from '../src/routes/setup.js';
import { registerSettingsRoutes } from '../src/routes/settings.js';
import { registerBrowserRoutes } from '../src/routes/browser.js';
import { registerMetricsRoutes } from '../src/routes/metrics.js';
import { registerSoundRoutes } from '../src/routes/sound.js';

describe('REST API Routes & Security Boundaries (setup, health, metrics, browser, settings, sound)', () => {
  let tmpDir: string;
  let app: FastifyInstance;
  let configStore: ConfigStore;
  let lockoutManager: LockoutManager;
  let authService: AuthService;
  let mockBrowser: any;
  let mockEncoder: any;
  let mockWsHandler: any;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-api-test-'));
    configStore = new ConfigStore(tmpDir);
    lockoutManager = new LockoutManager(tmpDir);
    authService = new AuthService(configStore, lockoutManager);

    mockBrowser = {
      getState: vi.fn(() => 'running'),
      getCurrentUrl: vi.fn(() => 'https://www.youtube.com'),
      getDisplay: vi.fn(() => ':99'),
      getDimensions: vi.fn(() => ({ width: 1280, height: 720 })),
      pause: vi.fn(),
      resume: vi.fn(),
      restartChrome: vi.fn(async () => {}),
      navigate: vi.fn(async () => {}),
      setDisplayScale: vi.fn(async () => {}),
    };

    mockEncoder = {
      isRunning: vi.fn(() => true),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(async () => {}),
      restartAll: vi.fn(async () => {}),
      updateConfig: vi.fn(async () => {}),
    };

    mockWsHandler = {
      restartStream: vi.fn(async () => {}),
    };

    app = Fastify();
    registerHealthRoutes(app);
    registerSetupRoutes(app, configStore, authService, lockoutManager, mockBrowser);
    registerSettingsRoutes(app, configStore, authService, mockBrowser, mockEncoder);
    registerBrowserRoutes(app, mockBrowser, authService, mockEncoder, mockWsHandler);
    registerMetricsRoutes(app, authService);
    registerSoundRoutes(app, authService);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('GET /api/health returns 200 OK with uptime and timestamp', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.timestamp).toBe('number');
  });

  it('POST /api/setup validates PIN bounds, handles missing body safely, and locks with 403 once completed', async () => {
    // 0. Public status before setup
    const statusBefore = await app.inject({ method: 'GET', url: '/api/status' });
    expect(statusBefore.statusCode).toBe(200);
    expect(statusBefore.json().isSetupCompleted).toBe(false);

    // 1. Missing/empty body must return 400 (not 500 TypeError)
    const emptyRes = await app.inject({ method: 'POST', url: '/api/setup' });
    expect(emptyRes.statusCode).toBe(400);

    // 2. Short PIN (<4) and long PIN (>8) rejected with 400
    const shortRes = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { pin: '123' },
    });
    expect(shortRes.statusCode).toBe(400);

    const longRes = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { pin: '123456789' },
    });
    expect(longRes.statusCode).toBe(400);

    // 3. Valid initial setup succeeds
    const okRes = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { pin: '2580', allowedDomains: ['tesroid.example.com'] },
    });
    expect(okRes.statusCode).toBe(200);
    expect(configStore.isSetupCompleted()).toBe(true);

    // 4. CRITICAL SECURITY BOUNDARY: Second POST /api/setup attempt must be blocked with 403 Forbidden!
    const takeoverAttempt = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { pin: '0000' },
    });
    expect(takeoverAttempt.statusCode).toBe(403);
  });

  it('Metrics routes allow loopback diagnostics, block remote IPs even with spoofed Host: localhost, and sanitize limit', async () => {
    await authService.setPin('1234');
    const authRes = await authService.verifyPin('1234');
    const token = authRes.token!;

    // 1. Loopback IP (127.0.0.1) allowed without token for container health scripts
    const localSummary = await app.inject({
      method: 'GET',
      url: '/api/metrics/summary',
      remoteAddress: '127.0.0.1',
    });
    expect(localSummary.statusCode).toBe(200);

    // 2. Remote IP with spoofed "Host: localhost" header MUST be rejected with 401!
    const spoofedRemote = await app.inject({
      method: 'GET',
      url: '/api/metrics/summary',
      remoteAddress: '203.0.113.42',
      headers: { host: 'localhost' },
    });
    expect(spoofedRemote.statusCode).toBe(401);

    // 3. Remote IP with valid Bearer token succeeds, and invalid limit query falls back safely
    const reportRes = await app.inject({
      method: 'POST',
      url: '/api/metrics/report',
      remoteAddress: '203.0.113.42',
      headers: { authorization: `Bearer ${token}` },
      payload: { renderFps: 60, rttMs: 18, avDriftMs: -12 },
    });
    expect(reportRes.statusCode).toBe(200);

    const historyRes = await app.inject({
      method: 'GET',
      url: '/api/metrics/history?limit=not-a-number',
      remoteAddress: '203.0.113.42',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(historyRes.statusCode).toBe(200);
    expect(Array.isArray(historyRes.json().history)).toBe(true);
  });

  it('Browser & Sound routes enforce Bearer auth, validate navigation URL schemes, and route encoder/restart via wsHandler', async () => {
    await authService.setPin('1234');
    const { token } = await authService.verifyPin('1234');
    const authHeaders = { authorization: `Bearer ${token}` };

    // Public status
    const statusRes = await app.inject({ method: 'GET', url: '/api/browser/status' });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().dimensions).toEqual({ width: 1280, height: 720 });

    // Unauthenticated POST /api/audio/test & /api/browser/navigate -> 401
    expect((await app.inject({ method: 'POST', url: '/api/audio/test' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/browser/navigate', payload: { url: 'https://example.com' } })).statusCode).toBe(401);

    // Missing URL & dangerous URL schemes (file://, javascript:, chrome://) -> 400
    expect(
      (await app.inject({ method: 'POST', url: '/api/browser/navigate', headers: authHeaders, payload: {} })).statusCode
    ).toBe(400);

    for (const unsafeUrl of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings']) {
      const badNav = await app.inject({
        method: 'POST',
        url: '/api/browser/navigate',
        headers: authHeaders,
        payload: { url: unsafeUrl },
      });
      expect(badNav.statusCode).toBe(400);

      const badRestart = await app.inject({
        method: 'POST',
        url: '/api/browser/restart',
        headers: authHeaders,
        payload: { url: unsafeUrl },
      });
      expect(badRestart.statusCode).toBe(400);
    }
    expect(mockBrowser.navigate).not.toHaveBeenCalled();

    // Valid https:// navigate succeeds
    const okNav = await app.inject({
      method: 'POST',
      url: '/api/browser/navigate',
      headers: authHeaders,
      payload: { url: 'https://www.youtube.com/tv' },
    });
    expect(okNav.statusCode).toBe(200);
    expect(mockBrowser.navigate).toHaveBeenCalledWith('https://www.youtube.com/tv');

    // POST /api/encoder/restart calls wsHandler.restartStream() when wired
    const restartRes = await app.inject({
      method: 'POST',
      url: '/api/encoder/restart',
      headers: authHeaders,
    });
    expect(restartRes.statusCode).toBe(200);
    expect(mockWsHandler.restartStream).toHaveBeenCalledTimes(1);
  });

  it('Settings & System Power routes verify PIN, clamp displayScale [50..250], reject unsafe browserUrl, and control power', async () => {
    await authService.setPin('1234');

    // POST /api/auth/verify error & success
    expect((await app.inject({ method: 'POST', url: '/api/auth/verify', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { pin: '9999' } })).statusCode).toBe(401);

    const verifyOk = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { pin: '1234' } });
    expect(verifyOk.statusCode).toBe(200);
    const token = verifyOk.json().token as string;
    const authHeaders = { authorization: `Bearer ${token}` };

    // PUT /api/settings clamps displayScale (e.g. 999 -> 250) and rejects unsafe browserUrl
    const badSettingsUrl = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: authHeaders,
      payload: { browserUrl: 'file:///root/.ssh/id_rsa' },
    });
    expect(badSettingsUrl.statusCode).toBe(400);

    const clampRes = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: authHeaders,
      payload: { displayScale: 999 },
    });
    expect(clampRes.statusCode).toBe(200);
    expect(clampRes.json().settings.displayScale).toBe(250);
    expect(mockBrowser.setDisplayScale).toHaveBeenCalledWith(250);

    // System sleep / resume / restart-browser
    mockEncoder.isRunning.mockReturnValue(false);
    expect((await app.inject({ method: 'POST', url: '/api/system/sleep', headers: authHeaders })).statusCode).toBe(200);
    expect(mockEncoder.stop).toHaveBeenCalled();
    expect(mockBrowser.pause).toHaveBeenCalled();

    expect((await app.inject({ method: 'POST', url: '/api/system/resume', headers: authHeaders })).statusCode).toBe(200);
    expect(mockBrowser.resume).toHaveBeenCalled();
    expect(mockEncoder.start).toHaveBeenCalled();

    expect((await app.inject({ method: 'POST', url: '/api/system/restart-browser', headers: authHeaders })).statusCode).toBe(200);
    expect(mockBrowser.restartChrome).toHaveBeenCalled();
  });
});
