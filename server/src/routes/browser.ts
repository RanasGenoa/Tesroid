import type { FastifyInstance } from 'fastify';
import { isSafeHttpUrl, type BrowserManager } from '../browser/manager.js';
import type { AuthService } from '../auth.js';
import type { VaapiEncoder } from '../encoder/ffmpeg.js';
import type { WebSocketHandler } from '../ws/handler.js';

export function registerBrowserRoutes(
  app: FastifyInstance,
  browserManager: BrowserManager,
  authService: AuthService,
  encoder?: VaapiEncoder,
  wsHandler?: WebSocketHandler
) {
  // Check auth session helper
  const isAuthorized = (req: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return false;
    const token = authHeader.replace(/^Bearer\s+/i, '');
    return authService.validateSession(token);
  };

  const requireAuth = async (req: any, reply: any) => {
    if (!isAuthorized(req)) {
      reply.status(401).send({ error: 'Unauthorized: Valid PIN session required.' });
      return;
    }
  };

  // Get browser status (Public read-only)
  app.get('/api/browser/status', async (req, reply) => {
    return {
      state: browserManager.getState(),
      url: browserManager.getCurrentUrl(),
      display: browserManager.getDisplay(),
      dimensions: browserManager.getDimensions(),
    };
  });

  // Pause browser (conserve resources)
  app.post('/api/browser/pause', { preHandler: requireAuth }, async (req, reply) => {
    encoder?.stop();
    browserManager.pause();
    return { success: true, state: browserManager.getState() };
  });

  // Resume browser
  app.post('/api/browser/resume', { preHandler: requireAuth }, async (req, reply) => {
    browserManager.resume();
    if (encoder && !encoder.isRunning()) {
      encoder.start();
    }
    return { success: true, state: browserManager.getState() };
  });

  // Restart browser (optionally with new URL)
  app.post('/api/browser/restart', { preHandler: requireAuth }, async (req: any, reply) => {
    const { url } = req.body || {};
    if (url !== undefined && !isSafeHttpUrl(url)) {
      return reply.code(400).send({ error: 'Invalid URL: Only http:// and https:// URLs are permitted' });
    }
    await browserManager.restartChrome(url);
    return { success: true, state: browserManager.getState(), url: browserManager.getCurrentUrl() };
  });

  // Navigate to new URL
  app.post('/api/browser/navigate', { preHandler: requireAuth }, async (req: any, reply) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      return reply.code(400).send({ error: 'URL is required' });
    }
    if (!isSafeHttpUrl(url)) {
      return reply.code(400).send({ error: 'Invalid URL: Only http:// and https:// URLs are permitted' });
    }
    await browserManager.navigate(url);
    return { success: true, url: browserManager.getCurrentUrl() };
  });

  // Clean restart of streaming process (Video + Audio FFmpeg + PlaybackBuffer + Client Reset)
  app.post('/api/encoder/restart', { preHandler: requireAuth }, async (req, reply) => {
    if (!encoder && !wsHandler) {
      return reply.code(500).send({ error: 'Encoder not available' });
    }
    if (wsHandler) {
      await wsHandler.restartStream();
    } else if (encoder) {
      if (typeof encoder.restartAll === 'function') {
        await encoder.restartAll();
      } else {
        await encoder.restart();
      }
    }
    return { success: true, restarted: true, message: 'Streaming pipeline cleanly restarted' };
  });
}
