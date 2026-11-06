import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from '../auth.js';
import { type BrowserManager, isSafeHttpUrl } from '../browser/manager.js';
import type { AppConfig, ConfigStore } from '../config.js';
import type { VaapiEncoder } from '../encoder/ffmpeg.js';

interface VerifyPinBody {
  pin: string;
}

interface UpdateSettingsBody {
  pin?: string;
  allowedDomains?: string[];
  autoSleepMinutes?: number;
  browserUrl?: string;
  displayScale?: number;
  locale?: string;
  timezone?: string;
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
  encoder?: VaapiEncoder,
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
      locale: config.locale || 'ja-JP',
      timezone: config.timezone || 'Asia/Tokyo',
      stream: config.stream,
      browserState: browserManager.getState(),
      browserUrl: browserManager.getCurrentUrl(),
    };
  });

  // Update settings
  app.put<{ Body: UpdateSettingsBody }>(
    '/api/settings',
    { preHandler: requireAuth },
    async (req, reply) => {
      const {
        pin,
        allowedDomains,
        autoSleepMinutes,
        stream,
        browserUrl,
        displayScale,
        locale,
        timezone,
      } = req.body || {};

      if (browserUrl !== undefined && browserUrl !== '' && !isSafeHttpUrl(browserUrl)) {
        return reply
          .status(400)
          .send({ error: 'Invalid browserUrl: Only http:// and https:// URLs are permitted.' });
      }

      if (pin) {
        if (typeof pin !== 'string' || pin.length < 4 || pin.length > 8) {
          return reply.status(400).send({ error: 'PIN must be between 4 and 8 characters long.' });
        }
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
      if (locale !== undefined && typeof locale === 'string') {
        updates.locale = locale.trim() || 'ja-JP';
      }
      if (timezone !== undefined && typeof timezone === 'string') {
        updates.timezone = timezone.trim() || 'Asia/Tokyo';
      }
      if (stream) updates.stream = { ...configStore.getConfig().stream, ...stream };

      configStore.updateConfig(updates);

      if (updates.locale !== undefined && typeof browserManager.setLocale === 'function') {
        browserManager.setLocale(updates.locale);
      }

      if (updates.displayScale !== undefined) {
        await browserManager.setDisplayScale(updates.displayScale);
      }

      if (stream && encoder) {
        const { maxFps, bitrate } = stream;
        if (maxFps !== undefined || bitrate !== undefined) {
          console.log(
            `[SettingsRoute] Applying updated stream config to encoder: maxFps=${maxFps}, bitrate=${bitrate}`,
          );
          await encoder.updateConfig({ fps: maxFps, bitrate });
        }
      }

      if (browserUrl) {
        await browserManager.navigate(browserUrl);
      }

      return { success: true, settings: configStore.getConfig() };
    },
  );

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
