import type { FastifyInstance } from 'fastify';
import type { VaapiEncoder } from '../encoder/ffmpeg.js';

export function registerHealthRoutes(app: FastifyInstance, encoder?: VaapiEncoder) {
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: Date.now(),
      ...(encoder ? { encoder: encoder.getEncoderStatus() } : {}),
    };
  });
}
