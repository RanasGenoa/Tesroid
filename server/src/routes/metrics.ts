import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { MetricsManager, ClientQualityMetrics } from '../metrics/manager.js';
import { AuthService } from '../auth.js';

export function registerMetricsRoutes(app: FastifyInstance, authService?: AuthService) {
  const metricsManager = MetricsManager.getInstance();

  const checkAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authService) return;
    // Allow localhost/loopback requests without authentication for health & diagnostics
    const isLocal = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
    if (isLocal) return;

    const authHeader = req.headers.authorization;
    const token = authHeader?.replace(/^Bearer\s+/i, '');
    if (!token || !authService.validateSession(token)) {
      reply.status(401).send({ error: 'Unauthorized: Valid PIN session required.' });
      return;
    }
  };

  // GET /api/metrics/summary - High-level aggregated statistics
  app.get('/api/metrics/summary', { preHandler: checkAuth }, async () => {
    return metricsManager.getSummary();
  });

  // GET /api/metrics/history - Time-series metrics (up to 60 entries by default)
  app.get<{ Querystring: { limit?: string } }>(
    '/api/metrics/history',
    { preHandler: checkAuth },
    async (req) => {
      const parsed = req.query.limit ? parseInt(req.query.limit, 10) : 60;
      const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
      const history = metricsManager.getHistory(limit);
      return {
        count: history.length,
        history,
      };
    }
  );

  // POST /api/metrics/report - Client report submission via HTTP
  app.post<{ Body: Partial<ClientQualityMetrics> }>(
    '/api/metrics/report',
    { preHandler: checkAuth },
    async (req, reply) => {
      if (!req.body) {
        return reply.status(400).send({ error: 'Body required' });
      }
      metricsManager.addMetrics(req.body);
      return { success: true };
    }
  );
}
