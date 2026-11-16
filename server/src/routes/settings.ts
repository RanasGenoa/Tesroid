import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from '../auth.js';
import { type BrowserManager, isSafeHttpUrl } from '../browser/manager.js';
import {
  type AppConfig,
  type ConfigStore,
  PERFORMANCE_PRESET_DEFAULTS,
  type PerformancePreset,
} from '../config.js';
import type { VaapiEncoder } from '../encoder/ffmpeg.js';
import { isValidTimezone } from './setup.js';

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
    audioBitrate?: number | string;
    performancePreset?: PerformancePreset;
    vaapiCompressionLevel?: number;
    vaapiLowPower?: boolean;
    vaapiGpuColorConversion?: boolean;
  };
}

const ALLOWED_LOCALES = ['ja-JP', 'en-US'];

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
      if (locale !== undefined) {
        if (typeof locale !== 'string' || !ALLOWED_LOCALES.includes(locale.trim())) {
          return reply.status(400).send({
            error: `Invalid locale: "${locale}". Allowed locales are: ${ALLOWED_LOCALES.join(', ')}`,
          });
        }
        updates.locale = locale.trim();
      }
      if (timezone !== undefined) {
        if (typeof timezone !== 'string' || !isValidTimezone(timezone.trim())) {
          return reply.status(400).send({
            error: `Invalid timezone: "${timezone}". Must be a valid IANA timezone string (e.g. Asia/Tokyo).`,
          });
        }
        updates.timezone = timezone.trim();
      }
      if (stream) {
        if (stream.audioBitrate !== undefined) {
          let ab: number;
          if (typeof stream.audioBitrate === 'string') {
            const str = stream.audioBitrate.toLowerCase().trim();
            if (str.endsWith('k')) {
              ab = parseFloat(str) * 1000;
            } else if (str.endsWith('m')) {
              ab = parseFloat(str) * 1000 * 1000;
            } else {
              ab = Number(str);
            }
          } else {
            ab = Number(stream.audioBitrate);
          }
          if (ab >= 128 && ab <= 320) {
            ab = ab * 1000;
          }
          if (!Number.isFinite(ab) || ab < 128000 || ab > 320000) {
            return reply.status(400).send({
              error:
                'Invalid audioBitrate: Must be between 128000 and 320000 bps (128kbps - 320kbps).',
            });
          }
          const normalizedBitrate = Math.round(ab);
          stream.audioBitrate = normalizedBitrate;
        }
        const currentStream = configStore.getConfig().stream;
        const allowedPresets: PerformancePreset[] = ['high', 'balanced', 'low_power', 'custom'];
        const nextPreset =
          stream.performancePreset && allowedPresets.includes(stream.performancePreset)
            ? stream.performancePreset
            : currentStream.performancePreset;
        const presetDefaults =
          nextPreset && nextPreset !== 'custom' && stream.performancePreset !== undefined
            ? PERFORMANCE_PRESET_DEFAULTS[nextPreset]
            : undefined;

        const nextBitrate =
          stream.bitrate !== undefined && Number.isFinite(Number(stream.bitrate))
            ? Math.max(300000, Math.min(10000000, Math.round(Number(stream.bitrate))))
            : currentStream.bitrate;
        const nextMaxFps =
          stream.maxFps !== undefined && Number.isFinite(Number(stream.maxFps))
            ? Math.max(15, Math.min(60, Math.round(Number(stream.maxFps))))
            : currentStream.maxFps;
        const nextMaxSize =
          stream.maxSize !== undefined && Number.isFinite(Number(stream.maxSize))
            ? Math.max(640, Math.min(1920, Math.round(Number(stream.maxSize))))
            : (presetDefaults?.maxSize ?? currentStream.maxSize);
        const nextCompressionLevel =
          stream.vaapiCompressionLevel !== undefined &&
          Number.isFinite(Number(stream.vaapiCompressionLevel))
            ? Math.max(1, Math.min(7, Math.round(Number(stream.vaapiCompressionLevel))))
            : (presetDefaults?.vaapiCompressionLevel ?? currentStream.vaapiCompressionLevel);
        const nextLowPower =
          stream.vaapiLowPower !== undefined
            ? Boolean(stream.vaapiLowPower)
            : (presetDefaults?.vaapiLowPower ?? currentStream.vaapiLowPower);
        const nextGpuCsc =
          stream.vaapiGpuColorConversion !== undefined
            ? Boolean(stream.vaapiGpuColorConversion)
            : (presetDefaults?.vaapiGpuColorConversion ?? currentStream.vaapiGpuColorConversion);

        updates.stream = {
          bitrate: nextBitrate,
          maxFps: nextMaxFps,
          maxSize: nextMaxSize,
          audioBitrate:
            typeof stream.audioBitrate === 'number'
              ? stream.audioBitrate
              : currentStream.audioBitrate,
          performancePreset: nextPreset,
          vaapiCompressionLevel: nextCompressionLevel,
          vaapiLowPower: nextLowPower,
          vaapiGpuColorConversion: nextGpuCsc,
        };
      }

      configStore.updateConfig(updates);

      if (updates.locale !== undefined && typeof browserManager.setLocale === 'function') {
        browserManager.setLocale(updates.locale);
      }
      if (updates.timezone !== undefined && typeof browserManager.setTimezone === 'function') {
        browserManager.setTimezone(updates.timezone);
      }

      if (updates.displayScale !== undefined) {
        await browserManager.setDisplayScale(updates.displayScale);
      }

      if (stream && encoder && updates.stream) {
        const {
          maxFps,
          bitrate,
          audioBitrate,
          vaapiCompressionLevel,
          vaapiLowPower,
          vaapiGpuColorConversion,
        } = stream;
        // Only forward VAAPI tuning options when explicitly changed or when a preset was applied,
        // avoiding unnecessary encoder restarts when only unrelated fields (e.g. bitrate/fps) change.
        const applyCompression =
          vaapiCompressionLevel !== undefined || stream.performancePreset !== undefined;
        const applyLowPower = vaapiLowPower !== undefined || stream.performancePreset !== undefined;
        const applyGpuCsc =
          vaapiGpuColorConversion !== undefined || stream.performancePreset !== undefined;
        if (
          maxFps !== undefined ||
          bitrate !== undefined ||
          audioBitrate !== undefined ||
          applyCompression ||
          applyLowPower ||
          applyGpuCsc
        ) {
          console.log(
            `[SettingsRoute] Applying updated stream config to encoder: maxFps=${maxFps}, bitrate=${bitrate}, audioBitrate=${audioBitrate}, compressionLevel=${updates.stream.vaapiCompressionLevel}, lowPower=${updates.stream.vaapiLowPower}, gpuCsc=${updates.stream.vaapiGpuColorConversion}`,
          );
          await encoder.updateConfig({
            fps: maxFps,
            bitrate,
            audioBitrate,
            compressionLevel: applyCompression ? updates.stream.vaapiCompressionLevel : undefined,
            lowPower: applyLowPower ? updates.stream.vaapiLowPower : undefined,
            gpuColorConversion: applyGpuCsc ? updates.stream.vaapiGpuColorConversion : undefined,
          });
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
