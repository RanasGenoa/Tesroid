import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: Date.now(),
    };
  });
}
