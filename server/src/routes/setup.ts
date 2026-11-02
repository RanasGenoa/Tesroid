import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ConfigStore } from '../config.js';
import { AuthService } from '../auth.js';
import { LockoutManager } from '../lockout.js';
import { BrowserManager } from '../browser/manager.js';

interface SetupBody {
  pin: string;
  allowedDomains?: string[];
}

export function registerSetupRoutes(
  app: FastifyInstance,
  configStore: ConfigStore,
  authService: AuthService,
  lockoutManager: LockoutManager,
  browserManager: BrowserManager
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
    };
  });

  // Initial setup endpoint (only permitted when not yet completed)
  app.post('/api/setup', async (req: FastifyRequest<{ Body: SetupBody }>, reply: FastifyReply) => {
    if (configStore.isSetupCompleted()) {
      return reply.status(403).send({ error: 'Setup has already been completed.' });
    }

    const { pin, allowedDomains } = req.body || ({} as Partial<SetupBody>);
    if (typeof pin !== 'string' || pin.length < 4 || pin.length > 8) {
      return reply.status(400).send({ error: 'PIN must be between 4 and 8 characters long.' });
    }

    // Save PIN
    await authService.setPin(pin);

    // Save configuration
    configStore.updateConfig({
      allowedDomains: allowedDomains || [],
    });

    return { success: true, message: 'Setup completed successfully.' };
  });
}
