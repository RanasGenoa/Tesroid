import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type AuthService, isValidPin } from '../auth.js';
import type { BrowserManager } from '../browser/manager.js';
import { ALLOWED_LOCALES, type ConfigStore } from '../config.js';
import type { LockoutManager } from '../lockout.js';
import type { WebSocketHandler } from '../ws/handler.js';

interface SetupBody {
  pin: string;
  allowedDomains?: string[];
  locale?: string;
  timezone?: string;
}

export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function registerSetupRoutes(
  app: FastifyInstance,
  configStore: ConfigStore,
  authService: AuthService,
  lockoutManager: LockoutManager,
  browserManager: BrowserManager,
  wsHandler?: WebSocketHandler,
) {
  // Public status check
  app.get('/api/status', async (_req: FastifyRequest, _reply: FastifyReply) => {
    const hasDri = fs.existsSync('/dev/dri/renderD128') || fs.existsSync('/dev/dri/card0');

    return {
      isSetupCompleted: configStore.isSetupCompleted(),
      browserState: browserManager.getState(),
      browserUrl: browserManager.getCurrentUrl(),
      hasDri,
      consecutiveFailures: lockoutManager.getConsecutiveFailures(),
      remainingAttempts: lockoutManager.getRemainingAttempts(),
      hasActiveSession: wsHandler
        ? typeof wsHandler.hasPrimaryClients === 'function'
          ? wsHandler.hasPrimaryClients()
          : wsHandler.hasActiveClients()
        : false,
    };
  });

  // Initial setup endpoint (only permitted when not yet completed)
  app.post('/api/setup', async (req: FastifyRequest<{ Body: SetupBody }>, reply: FastifyReply) => {
    if (configStore.isSetupCompleted()) {
      return reply.status(403).send({ error: 'Setup has already been completed.' });
    }

    const { pin, allowedDomains, locale, timezone } = req.body || ({} as Partial<SetupBody>);
    if (!isValidPin(pin)) {
      return reply.status(400).send({ error: 'PIN must be 4 to 8 numeric digits (0-9).' });
    }

    // Save PIN
    await authService.setPin(pin);

    const safeLocale =
      typeof locale === 'string' && ALLOWED_LOCALES.includes(locale.trim())
        ? locale.trim()
        : 'ja-JP';
    const safeTimezone =
      typeof timezone === 'string' && isValidTimezone(timezone.trim())
        ? timezone.trim()
        : 'Asia/Tokyo';

    // Save configuration
    configStore.updateConfig({
      allowedDomains: allowedDomains || [],
      locale: safeLocale,
      timezone: safeTimezone,
    });

    if (typeof browserManager.setLocale === 'function') {
      browserManager.setLocale(safeLocale);
    }
    if (typeof browserManager.setTimezone === 'function') {
      browserManager.setTimezone(safeTimezone);
    }

    return { success: true, message: 'Setup completed successfully.' };
  });
}
