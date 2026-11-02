import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { exec } from 'node:child_process';
import { AuthService } from '../auth.js';

export function registerSoundRoutes(
  app: FastifyInstance,
  authService: AuthService
) {
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace(/^Bearer\s+/i, '');

    if (!token || !authService.validateSession(token)) {
      reply.status(401).send({ error: 'Unauthorized: Valid PIN session required.' });
      return;
    }
  };

  // Trigger test sound through PulseAudio virtual sink
  app.post('/api/audio/test', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      console.log('[SoundRoute] Triggering test audio playback on PulseAudio...');
      // Generate a short 440Hz beep using paplay or sox/ffmpeg
      exec('ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -f pulse virtual_sink 2>/dev/null || true');
      return { success: true, message: 'Test sound triggered on PulseAudio virtual sink' };
    } catch (err: any) {
      console.error('[SoundRoute] Failed to trigger sound:', err);
      return reply.status(500).send({ error: err.message });
    }
  });
}
