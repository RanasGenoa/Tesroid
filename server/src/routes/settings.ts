import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ConfigStore, AppConfig } from '../config.js';
import { AuthService } from '../auth.js';
import { BrowserManager } from '../browser/manager.js';
import { VaapiEncoder } from '../encoder/ffmpeg.js';

interface VerifyPinBody {
  pin: string;
}

interface UpdateSettingsBody {
  pin?: string;
  allowedDomains?: string[];
  autoSleepMinutes?: number;
  browserUrl?: string;
  displayScale?: number;
  stream?: {
    bitrate?: number;
    maxFps?: number;
    maxSize?: number;
  };
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  configStore: ConfigStore,
  authService: AuthService,
  browserManager: BrowserManager,
  encoder?: VaapiEncoder
) {
  // Helper middleware for session check
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace(/^Bearer\s+/i, '');

    if (!token || !authService.validateSession(token)) {
      reply.status(401).send({ error: 'Unauthorized: Valid PIN session required.' });
      return;
    }
  };

  // PIN verification for settings access or session establishment
  app.post<{ Body: VerifyPinBody }>('/api/auth/verify', async (req, reply) => {
    const { pin } = req.body || {};
    if (!pin) {
      return reply.status(400).send({ error: 'PIN is required.' });
    }

    const result = await authService.verifyPin(pin);
    if (!result.success) {
      return reply.status(401).send({
        error: 'Invalid PIN.',
        remainingAttempts: result.remainingAttempts,
      });
    }

    return {
      success: true,
      token: result.token,
    };
  });

  // Get current settings
  app.get('/api/settings', { preHandler: requireAuth }, async (_req, _reply) => {
    const config = configStore.getConfig();
    return {
      isSetupCompleted: config.isSetupCompleted,
      allowedDomains: config.allowedDomains,
      autoSleepMinutes: config.autoSleepMinutes,
      displayScale: config.displayScale,
      stream: config.stream,
      browserState: browserManager.getState(),
      browserUrl: browserManager.getCurrentUrl(),
    };
  });

  // Update settings
  app.put<{ Body: UpdateSettingsBody }>('/api/settings', { preHandler: requireAuth }, async (req, _reply) => {
    const { pin, allowedDomains, autoSleepMinutes, stream, browserUrl, displayScale } = req.body;

    if (pin) {
      await authService.setPin(pin);
    }

    const updates: Partial<AppConfig> = {};
    if (allowedDomains !== undefined) updates.allowedDomains = allowedDomains;
    if (autoSleepMinutes !== undefined) updates.autoSleepMinutes = autoSleepMinutes;
    if (displayScale !== undefined && Number.isFinite(Number(displayScale))) {
      const clampedScale = Math.max(50, Math.min(250, Math.round(Number(displayScale))));
      updates.displayScale = clampedScale;
      updates.displayScaleUserSet = true;
    }
    if (stream) updates.stream = { ...configStore.getConfig().stream, ...stream };

    configStore.updateConfig(updates);

    if (updates.displayScale !== undefined) {
      await browserManager.setDisplayScale(updates.displayScale);
    }

    if (stream && encoder) {
      const { maxFps, bitrate } = stream;
      if (maxFps !== undefined || bitrate !== undefined) {
        console.log(`[SettingsRoute] Applying updated stream config to encoder: maxFps=${maxFps}, bitrate=${bitrate}`);
        await encoder.updateConfig({ fps: maxFps, bitrate });
      }
    }

    if (browserUrl) {
      await browserManager.navigate(browserUrl);
    }

    return { success: true, settings: configStore.getConfig() };
  });

  // Browser power management: Pause
  app.post('/api/system/sleep', { preHandler: requireAuth }, async (_req, _reply) => {
    console.log('[SettingsRoute] Sleep requested');
    encoder?.stop();
    browserManager.pause();
    return { success: true, message: 'Browser paused and encoder stopped (CPU/GPU 0%)' };
  });

  // Browser power management: Resume
  app.post('/api/system/resume', { preHandler: requireAuth }, async (_req, _reply) => {
    console.log('[SettingsRoute] Resume requested');
    browserManager.resume();
    if (encoder && !encoder.isRunning()) {
      encoder.start();
    }
    return { success: true, message: 'Browser resumed' };
  });

  // Browser restart
  app.post('/api/system/restart-browser', { preHandler: requireAuth }, async (_req, _reply) => {
    console.log('[SettingsRoute] Restart browser requested');
    await browserManager.restartChrome();
    if (encoder && !encoder.isRunning()) {
      encoder.start();
    }
    return { success: true, message: 'Browser restarted' };
  });
}
