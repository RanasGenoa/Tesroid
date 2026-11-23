import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebSocket from '@fastify/websocket';
import Fastify from 'fastify';
import { AuthService } from './auth.js';
import { BrowserManager } from './browser/manager.js';
import { ConfigStore, resolveHomeUrl } from './config.js';
import { VaapiEncoder } from './encoder/ffmpeg.js';
import { X11InputManager } from './input/xdotool.js';
import { LockoutManager } from './lockout.js';
import { registerBrowserRoutes } from './routes/browser.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerSoundRoutes } from './routes/sound.js';
import { registerTelemetryRoutes } from './routes/telemetry.js';
import { detectVaapiConfig, type EncoderBackend, resolveEncoderMode } from './utils/vaapi.js';
import { WebSocketHandler } from './ws/handler.js';

async function bootstrap() {
  const app = Fastify({
    logger: true,
    disableRequestLogging: process.env.NODE_ENV === 'production',
  });

  // 1. Initialize core managers
  const configStore = new ConfigStore();
  const lockoutManager = new LockoutManager(configStore.getDataDir());
  const authService = new AuthService(configStore, lockoutManager);

  const displayWidth = Number(process.env.DISPLAY_WIDTH) || 1280;
  const displayHeight = Number(process.env.DISPLAY_HEIGHT) || 720;
  const displayNum = process.env.DISPLAY_NUM || ':99';

  const vaapiInfo = detectVaapiConfig();
  const encoderMode = resolveEncoderMode();
  const initialBackend: EncoderBackend =
    encoderMode === 'software' || (encoderMode === 'auto' && !vaapiInfo.vaapiEncodeSupported)
      ? 'software'
      : 'vaapi';

  console.log(
    `[Bootstrap] Video config: device=${vaapiInfo.vaapiDevice || '<none>'}, ` +
      `driver=${vaapiInfo.libvaDriverName}, hasDri=${vaapiInfo.hasDri}, hasDxg=${vaapiInfo.hasDxg}, ` +
      `vaapiEncodeSupported=${vaapiInfo.vaapiEncodeSupported}, encoderMode=${encoderMode}, ` +
      `initialBackend=${initialBackend} (${vaapiInfo.reason})`,
  );

  const initialConfig = configStore.getConfig();
  const browserManager = new BrowserManager({
    displayNum,
    width: displayWidth,
    height: displayHeight,
    defaultUrl: process.env.BROWSER_URL || resolveHomeUrl(initialConfig),
    vaapiDevice: vaapiInfo.vaapiDevice,
    libvaDriverName: vaapiInfo.libvaDriverName,
    displayScale: initialConfig.displayScale || 120,
    locale: initialConfig.locale || 'ja-JP',
    timezone: initialConfig.timezone || 'Asia/Tokyo',
  });

  const initialStreamConfig = initialConfig.stream;
  const initialFps = initialStreamConfig?.maxFps || Number(process.env.FPS) || 30;
  const initialBitrate = initialStreamConfig?.bitrate
    ? `${Math.round(initialStreamConfig.bitrate / 1000)}k`
    : process.env.VIDEO_BITRATE || '1000k';
  const initialAudioBitrate = initialStreamConfig?.audioBitrate
    ? `${Math.round(initialStreamConfig.audioBitrate / 1000)}k`
    : process.env.AUDIO_BITRATE || '128k';

  const encoder = new VaapiEncoder({
    displayNum,
    width: displayWidth,
    height: displayHeight,
    fps: initialFps,
    bitrate: initialBitrate,
    audioBitrate: initialAudioBitrate,
    vaapiDevice: vaapiInfo.vaapiDevice,
    libvaDriverName: vaapiInfo.libvaDriverName,
    encoderMode,
    initialBackend,
    compressionLevel: initialStreamConfig?.vaapiCompressionLevel,
    lowPower: initialStreamConfig?.vaapiLowPower,
    gpuColorConversion: initialStreamConfig?.vaapiGpuColorConversion,
  });

  const inputManager = new X11InputManager(displayNum, displayWidth, displayHeight);

  // Start Browser stack & Encoder in background
  try {
    console.log('[Bootstrap] Initializing Browser Stack (Xvfb + Openbox + Chrome)...');
    await browserManager.start();
    console.log(`[Bootstrap] Initializing FFmpeg Encoder (backend=${initialBackend})...`);
    encoder.start();
  } catch (err) {
    console.warn(
      '[Bootstrap] Browser stack startup deferred or failed (will retry on connect):',
      err,
    );
  }

  // 2. Register Fastify Plugins
  await app.register(fastifyWebSocket, {
    options: {
      maxPayload: 10 * 1024 * 1024, // 10MB
    },
  });

  // Serve frontend static assets (SPA)
  const publicDir =
    process.env.PUBLIC_DIR ||
    (fs.existsSync(path.join(process.cwd(), 'public'))
      ? path.join(process.cwd(), 'public')
      : path.join(process.cwd(), '..', 'client', 'dist'));

  if (fs.existsSync(publicDir)) {
    await app.register(fastifyStatic, {
      root: publicDir,
      prefix: '/',
      wildcard: false,
    });

    // SPA fallback: any non-API route serves index.html
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html', publicDir);
    });
  } else {
    console.warn(`[Bootstrap] Static public dir not found at ${publicDir}. Serving API only.`);
  }

  // 3. Register WebSocket Handler
  const wsHandler = new WebSocketHandler(
    authService,
    browserManager,
    encoder,
    inputManager,
    configStore,
  );

  app.get('/ws', { websocket: true }, (connection, req) => {
    wsHandler.handleConnection(connection, req);
  });

  // 4. Register REST API Routes
  registerSetupRoutes(app, configStore, authService, lockoutManager, browserManager, wsHandler);
  registerSettingsRoutes(app, configStore, authService, browserManager, encoder, wsHandler);
  registerBrowserRoutes(app, browserManager, authService, encoder, wsHandler);
  registerSoundRoutes(app, authService);
  registerHealthRoutes(app, encoder);
  registerMetricsRoutes(app, authService);
  registerTelemetryRoutes(app, authService);

  // 5. Start HTTP server
  const port = parseInt(process.env.PORT || '8080', 10);
  const host = '0.0.0.0';

  try {
    await app.listen({ port, host });
    console.log(`\n========================================================`);
    console.log(`🚀 Tesroid v2 Browser Server running at http://${host}:${port}`);
    console.log(`📡 WebSocket endpoint ready at ws://${host}:${port}/ws`);
    console.log(`========================================================\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[Bootstrap] Received ${signal}. Shutting down gracefully...`);
    encoder.stop();
    browserManager.stop();
    inputManager.close();
    wsHandler.close();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[Bootstrap] Fatal startup error:', err);
  process.exit(1);
});
