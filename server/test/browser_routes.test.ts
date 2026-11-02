import { describe, it, expect, vi } from 'vitest';
import fastify from 'fastify';
import { registerBrowserRoutes } from '../src/routes/browser.js';
import type { BrowserManager } from '../src/browser/manager.js';
import type { AuthService } from '../src/auth.js';
import type { VaapiEncoder } from '../src/encoder/ffmpeg.js';

describe('Browser Routes - Encoder Synchronization', () => {
  const setupTestEnv = () => {
    const authService = {
      validateSession: vi.fn().mockImplementation((token: string) => token === 'valid-token'),
    } as unknown as AuthService;

    const browserManager = {
      getState: vi.fn().mockReturnValue('running'),
      getCurrentUrl: vi.fn().mockReturnValue('https://www.youtube.com'),
      getDisplay: vi.fn().mockReturnValue(':99'),
      getDimensions: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
      pause: vi.fn(),
      resume: vi.fn(),
    } as unknown as BrowserManager;

    let running = true;
    const encoder = {
      stop: vi.fn().mockImplementation(() => { running = false; }),
      start: vi.fn().mockImplementation(() => { running = true; }),
      restart: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn().mockImplementation(() => running),
    } as unknown as VaapiEncoder;

    const app = fastify();
    registerBrowserRoutes(app, browserManager, authService, encoder);

    return { app, browserManager, authService, encoder };
  };

  it('should call encoder.stop() and browserManager.pause() on /api/browser/pause', async () => {
    const { app, browserManager, encoder } = setupTestEnv();

    const res = await app.inject({
      method: 'POST',
      url: '/api/browser/pause',
      headers: {
        authorization: 'Bearer valid-token',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(encoder.stop).toHaveBeenCalledTimes(1);
    expect(browserManager.pause).toHaveBeenCalledTimes(1);
  });

  it('should call browserManager.resume() and start encoder if not running on /api/browser/resume', async () => {
    const { app, browserManager, encoder } = setupTestEnv();

    // Pause first so encoder is stopped
    await app.inject({
      method: 'POST',
      url: '/api/browser/pause',
      headers: {
        authorization: 'Bearer valid-token',
      },
    });

    expect(encoder.isRunning()).toBe(false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/browser/resume',
      headers: {
        authorization: 'Bearer valid-token',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(browserManager.resume).toHaveBeenCalledTimes(1);
    expect(encoder.start).toHaveBeenCalledTimes(1);
    expect(encoder.isRunning()).toBe(true);
  });

  it('should reject unauthorized calls to pause or resume', async () => {
    const { app, encoder, browserManager } = setupTestEnv();

    const resPause = await app.inject({
      method: 'POST',
      url: '/api/browser/pause',
      headers: {
        authorization: 'Bearer invalid-token',
      },
    });
    expect(resPause.statusCode).toBe(401);
    expect(encoder.stop).not.toHaveBeenCalled();
    expect(browserManager.pause).not.toHaveBeenCalled();

    const resResume = await app.inject({
      method: 'POST',
      url: '/api/browser/resume',
      headers: {
        authorization: 'Bearer invalid-token',
      },
    });
    expect(resResume.statusCode).toBe(401);
    expect(browserManager.resume).not.toHaveBeenCalled();
  });

  it('should call encoder.restart() on /api/encoder/restart with valid auth', async () => {
    const { app, encoder } = setupTestEnv();

    const res = await app.inject({
      method: 'POST',
      url: '/api/encoder/restart',
      headers: {
        authorization: 'Bearer valid-token',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(encoder.restart).toHaveBeenCalledTimes(1);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.restarted).toBe(true);
  });

  it('should reject unauthorized calls to /api/encoder/restart', async () => {
    const { app, encoder } = setupTestEnv();

    const res = await app.inject({
      method: 'POST',
      url: '/api/encoder/restart',
      headers: {
        authorization: 'Bearer invalid-token',
      },
    });

    expect(res.statusCode).toBe(401);
    expect(encoder.restart).not.toHaveBeenCalled();
  });
});
