import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { TelemetryManager } from '../telemetry/manager.js';
import { AuthService } from '../auth.js';

export function registerTelemetryRoutes(
  app: FastifyInstance,
  authService?: AuthService,
  customManager?: TelemetryManager
) {
  const telemetryManager = customManager || TelemetryManager.getInstance();

  const checkAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authService) return;
    const isLocal = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
    if (isLocal) return;

    const authHeader = req.headers.authorization;
    const token = authHeader?.replace(/^Bearer\s+/i, '');
    if (!token || !authService.validateSession(token)) {
      reply.status(401).send({ error: 'Unauthorized: Valid PIN session required.' });
      return;
    }
  };

  // GET /api/telemetry/sessions - List recorded telemetry sessions
  app.get('/api/telemetry/sessions', { preHandler: checkAuth }, async () => {
    const sessions = await telemetryManager.listSessions();
    return {
      count: sessions.length,
      sessions,
    };
  });

  // GET /api/telemetry/sessions/latest/download - Download latest session jsonl
  app.get('/api/telemetry/sessions/latest/download', { preHandler: checkAuth }, async (_req, reply) => {
    const latestFilePath = await telemetryManager.getLatestSessionFile();
    if (!latestFilePath || !fs.existsSync(latestFilePath)) {
      return reply.status(404).send({ error: 'No telemetry session logs found.' });
    }

    const filename = path.basename(latestFilePath);
    reply.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(fs.createReadStream(latestFilePath));
  });

  // GET /api/telemetry/sessions/:sessionId/download - Download specific session jsonl
  app.get<{ Params: { sessionId: string } }>(
    '/api/telemetry/sessions/:sessionId/download',
    { preHandler: checkAuth },
    async (req, reply) => {
      const { sessionId } = req.params;
      const filePath = await telemetryManager.getSessionFile(sessionId);
      if (!filePath || !fs.existsSync(filePath)) {
        return reply.status(404).send({ error: `Session log '${sessionId}' not found.` });
      }

      const filename = path.basename(filePath);
      reply.header('Content-Type', 'application/x-ndjson; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(fs.createReadStream(filePath));
    }
  );

  // DELETE /api/telemetry/sessions - Clear all stored telemetry logs
  app.delete('/api/telemetry/sessions', { preHandler: checkAuth }, async () => {
    await telemetryManager.clearAllSessions();
    return { success: true };
  });
}
