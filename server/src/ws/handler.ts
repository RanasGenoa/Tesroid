import type { WebSocket } from 'ws';
import { WSS_CHANNEL, VIDEO_FLAGS, AUDIO_FLAGS } from './protocol.js';
import { MessageMultiplexer } from './multiplexer.js';
import { AuthService } from '../auth.js';
import { BrowserManager } from '../browser/manager.js';
import { VaapiEncoder } from '../encoder/ffmpeg.js';
import { X11InputManager } from '../input/xdotool.js';
import { ConfigStore } from '../config.js';
import { MetricsManager } from '../metrics/manager.js';
import { PlaybackBuffer, type BufferedFrame } from '../encoder/playback-buffer.js';

export interface ClientSession {
  socket: WebSocket;
  lastAckPts: bigint | null;
  mode: 'LIVE' | 'CATCHUP';
  pacingTimer: NodeJS.Timeout | null;
  playbackQueue: BufferedFrame[];
  isDroppingGop?: boolean;
}

export class WebSocketHandler {
  private authService: AuthService;
  private browserManager: BrowserManager;
  private encoder: VaapiEncoder;
  private inputManager: X11InputManager;
  private configStore: ConfigStore;

  private authenticatedClients: Set<WebSocket> = new Set();
  private allClients: Set<WebSocket> = new Set();

  // Playback ring buffer & CATCHUP state machine
  private playbackBuffer: PlaybackBuffer;
  private lastInputAt: number = Date.now();
  private lastKnownAckPts: bigint | null = null;
  private clientSessions: Map<WebSocket, ClientSession> = new Map();

  private autoSleepTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private resizeTimer: NodeJS.Timeout | null = null;
  private currentResWidth = 1280;
  private currentResHeight = 720;

  // Stats
  private videoFramesSent = 0;
  private videoBytesSent = 0;
  private audioPacketsSent = 0;
  private lastStatsTime = performance.now();

  constructor(
    authService: AuthService,
    browserManager: BrowserManager,
    encoder: VaapiEncoder,
    inputManager: X11InputManager,
    configStore: ConfigStore,
    playbackBuffer?: PlaybackBuffer
  ) {
    this.authService = authService;
    this.browserManager = browserManager;
    this.encoder = encoder;
    this.inputManager = inputManager;
    this.configStore = configStore;
    this.playbackBuffer = playbackBuffer || new PlaybackBuffer();

    const dims = this.browserManager.getDimensions();
    this.currentResWidth = dims.width;
    this.currentResHeight = dims.height;

    this.bindEncoderEvents();
    this.startStatsBroadcast();
    this.scheduleAutoSleep();
  }

  public getPlaybackBuffer(): PlaybackBuffer {
    return this.playbackBuffer;
  }

  public getClientSession(socket: WebSocket): ClientSession | undefined {
    return this.clientSessions.get(socket);
  }

  public setLastInputAt(timeMs: number): void {
    this.lastInputAt = timeMs;
  }

  public getLastInputAt(): number {
    return this.lastInputAt;
  }

  public handleConnection(socket: WebSocket, req?: any): void {
    try {
      (socket as any)._socket?.setNoDelay?.(true);
    } catch {}

    const ua = req?.headers?.['user-agent'] || 'unknown';
    this.allClients.add(socket);
    this.clientSessions.set(socket, {
      socket,
      lastAckPts: this.lastKnownAckPts,
      mode: 'LIVE',
      pacingTimer: null,
      playbackQueue: [],
    });
    console.log(`[WebSocketHandler] Client connected (UA: ${ua}). Total: ${this.allClients.size}`);

    // If auto sleep timer was running, cancel it
    if (this.autoSleepTimer) {
      clearTimeout(this.autoSleepTimer);
      this.autoSleepTimer = null;
    }

    // Check if initial PIN setup is required
    const config = this.configStore.getConfig();
    if (!config.isSetupCompleted) {
      this.sendControl(socket, { type: 'SETUP_REQUIRED' });
    }

    socket.on('message', async (data: Buffer | ArrayBuffer, _isBinary: boolean) => {
      try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length === 0) return;

        const channel = buf[0];

        // 1. Auth Channel (0x12)
        if (channel === WSS_CHANNEL.AUTH) {
          await this.handleAuthMessage(socket, buf);
          return;
        }

        // Must be authenticated for other channels
        if (!this.authenticatedClients.has(socket)) {
          this.sendControl(socket, { type: 'AUTH_REQUIRED', error: 'Authentication required' });
          return;
        }

        // 2. Touch Channel (0x10) - User Input
        if (channel === WSS_CHANNEL.TOUCH) {
          this.recordInputActivity(socket);
          this.handleTouchMessage(buf);
          return;
        }

        // 3. Resize Channel (0x11)
        if (channel === WSS_CHANNEL.RESIZE) {
          this.handleResizeMessage(buf);
          return;
        }

        // 4. Command Channel (0x13)
        if (channel === WSS_CHANNEL.COMMAND) {
          await this.handleCommandMessage(socket, buf);
          return;
        }

        // 5. Metrics Channel (0x14)
        if (channel === WSS_CHANNEL.METRICS) {
          this.handleMetricsMessage(buf);
          return;
        }
      } catch (err) {
        console.error('[WebSocketHandler] Error handling WS message:', err);
      }
    });

    socket.on('close', () => {
      this.allClients.delete(socket);
      this.authenticatedClients.delete(socket);

      const session = this.clientSessions.get(socket);
      if (session) {
        if (session.pacingTimer) {
          clearTimeout(session.pacingTimer);
          session.pacingTimer = null;
        }
        session.playbackQueue = [];
        if (session.lastAckPts !== null) {
          this.lastKnownAckPts = session.lastAckPts;
        }
        this.clientSessions.delete(socket);
      }

      console.log(`[WebSocketHandler] Client disconnected. Remaining auth: ${this.authenticatedClients.size}, total: ${this.allClients.size}`);

      // If no authenticated clients remain, schedule auto-sleep to save resources
      if (this.authenticatedClients.size === 0) {
        this.scheduleAutoSleep();
      }
    });

    socket.on('error', (err) => {
      console.warn('[WebSocketHandler] Socket error:', err.message);
    });
  }

  /**
   * ユーザー入力アクティビティ時刻を記録し、CATCHUP（追っかけ再生）中の場合は
   * 自動ハイブリッド制御として即座に未再生バッファを破棄してLIVE（操作優先・低遅延）へ復帰させる。
   */
  private recordInputActivity(socket?: WebSocket): void {
    this.lastInputAt = Date.now();
    if (socket) {
      const session = this.clientSessions.get(socket);
      if (session && session.mode === 'CATCHUP') {
        console.log('[WebSocketHandler] Auto-Hybrid: User input detected during CATCHUP. Switching immediately to LIVE mode.');
        this.abortCatchupAndSwitchToLive(session);
      }
    } else {
      for (const session of this.clientSessions.values()) {
        if (session.mode === 'CATCHUP') {
          this.abortCatchupAndSwitchToLive(session);
        }
      }
    }
  }

  /**
   * 配信プロセス（FFmpeg Video/Audio + サーバーリングバッファ + 全クライアントセッション）を完全にクリーン再起動する
   */
  public async restartStream(): Promise<void> {
    console.log('[WebSocketHandler] Clean restarting entire streaming pipeline (FFmpeg Video/Audio + Buffers + Client Sessions)...');
    this.playbackBuffer.clear();
    this.lastKnownAckPts = null;

    for (const session of this.clientSessions.values()) {
      if (session.pacingTimer) {
        clearTimeout(session.pacingTimer);
        session.pacingTimer = null;
      }
      session.playbackQueue = [];
      session.mode = 'LIVE';
      session.lastAckPts = null;
      (session.socket as any)._droppingGop = false;
    }

    this.broadcastControl({
      type: 'STREAM_RESET',
      timestamp: Date.now(),
    });

    if (typeof (this.encoder as any).restartAll === 'function') {
      await (this.encoder as any).restartAll();
    } else {
      await this.encoder.restart();
    }
  }

  /**
   * CATCHUP ペーシングを中断し、バッファ未再生分を破棄して最新の LIVE ストリームへ即時ジャンプ
   */
  private abortCatchupAndSwitchToLive(session: ClientSession): void {
    if (session.pacingTimer) {
      clearTimeout(session.pacingTimer);
      session.pacingTimer = null;
    }
    session.playbackQueue = [];
    session.mode = 'LIVE';

    // ライブ最新 IDR（必要なら encoder.restart()）へ即ジャンプ (目標切替遅延: 1秒以内)
    const cachedKeyframe = this.encoder.getCachedKeyframe();
    let isStale = false;
    if (cachedKeyframe) {
      if (typeof this.encoder.isKeyframeStale === 'function') {
        isStale = this.encoder.isKeyframeStale(2000000n);
      } else if (typeof (this.encoder as any).getCurrentPts === 'function') {
        const currentPts = (this.encoder as any).getCurrentPts();
        isStale = (currentPts - cachedKeyframe.pts) >= 2000000n;
      }
    } else {
      isStale = true;
    }

    if (isStale) {
      console.log('[WebSocketHandler] Live jump on input: cached keyframe is stale. Restarting encoder...');
      this.encoder.restart().catch((err) => {
        console.error('[WebSocketHandler] Failed to restart encoder on input interrupt:', err);
      });
    } else if (cachedKeyframe && session.socket.readyState === 1) {
      const cachedSpsPps = this.encoder.getCachedSpsPps();
      if (cachedSpsPps) {
        session.socket.send(MessageMultiplexer.packVideo(VIDEO_FLAGS.CONFIG, 0n, cachedSpsPps));
      }
      session.socket.send(
        MessageMultiplexer.packVideo(
          VIDEO_FLAGS.KEYFRAME | VIDEO_FLAGS.CONFIG,
          cachedKeyframe.pts,
          cachedKeyframe.data
        )
      );
    }
  }

  private async handleAuthMessage(socket: WebSocket, buf: Buffer): Promise<void> {
    const authPayload = buf.subarray(1).toString('utf-8').trim();
    const config = this.configStore.getConfig();

    // Check if client is authenticating with an existing session token (e.g. on WebSocket auto-reconnect)
    if (authPayload.startsWith('TOKEN:')) {
      const token = authPayload.slice(6).trim();
      if (this.authService.validateSession(token)) {
        this.authenticatedClients.add(socket);
        this.sendControl(socket, { type: 'AUTH_SUCCESS', token });
        this.onClientAuthenticated(socket);
        return;
      } else {
        this.sendControl(socket, {
          type: 'AUTH_FAILED',
          error: 'Session expired or invalid',
          remainingAttempts: 10,
        });
        return;
      }
    }

    const pin = authPayload;

    if (!config.isSetupCompleted) {
      // First-time setup
      try {
        await this.authService.setPin(pin);
        const authRes = await this.authService.verifyPin(pin);
        this.authenticatedClients.add(socket);
        this.sendControl(socket, { type: 'AUTH_SUCCESS', token: authRes.token || 'session_token' });
        this.onClientAuthenticated(socket);
      } catch (err: any) {
        this.sendControl(socket, { type: 'AUTH_FAILED', error: err.message, remainingAttempts: 10 });
      }
      return;
    }

    const result = await this.authService.verifyPin(pin);
    if (result.success) {
      this.authenticatedClients.add(socket);
      this.sendControl(socket, { type: 'AUTH_SUCCESS', token: result.token });
      this.onClientAuthenticated(socket);
    } else {
      this.sendControl(socket, {
        type: 'AUTH_FAILED',
        error: 'Invalid PIN code',
        remainingAttempts: result.remainingAttempts,
      });
    }
  }

  private onClientAuthenticated(socket: WebSocket): void {
    console.log('[WebSocketHandler] Client successfully authenticated.');

    // If browser was paused, resume it immediately
    if (this.browserManager.getState() === 'paused') {
      this.browserManager.resume();
    } else if (this.browserManager.getState() === 'stopped') {
      this.browserManager.start().catch((err) => console.error('Start error:', err));
    } else if (!this.browserManager.isChromeAlive()) {
      console.warn('[WebSocketHandler] Browser is marked running but Chrome is not alive. Restarting Chrome...');
      this.browserManager.restartChrome().catch((err) => console.error('Restart Chrome error:', err));
    }

    // Ensure FFmpeg encoder is running if it was stopped during idle sleep
    if (!this.encoder.isRunning()) {
      console.log('[WebSocketHandler] Resuming FFmpeg encoder on client authentication...');
      this.encoder.start();
    }

    const session = this.clientSessions.get(socket);
    const lastAckPts = session?.lastAckPts ?? this.lastKnownAckPts;

    // 要件4: now - lastInputAt > IDLE_TO_BUFFER_SECONDS（既定5秒、環境変数）なら CATCHUP 許可状態
    const idleThresholdMs = (Number(process.env.IDLE_TO_BUFFER_SECONDS) || 5) * 1000;
    const isIdle = (Date.now() - this.lastInputAt) > idleThresholdMs;

    const catchupData = (isIdle && lastAckPts !== null && lastAckPts > 0n)
      ? this.playbackBuffer.getFramesToCatchup(lastAckPts)
      : null;

    if (catchupData && catchupData.frames.length > 0 && session) {
      // 要件6: CATCHUP 許可状態での再接続 = バッファから lastAckPts 以降を再生
      console.log(`[WebSocketHandler] Client reconnected in idle state. Starting CATCHUP playback (${catchupData.frames.length} frames from lastAckPts=${lastAckPts})...`);
      this.startCatchup(session, catchupData);
    } else {
      // 要件5: LIVE 状態での再接続 = 現挙動のまま（stale判定→restart→ライブ）
      if (session) {
        session.mode = 'LIVE';
      }
      this.startLive(socket);
    }

    // Send browser status
    this.sendControl(socket, {
      type: 'BROWSER_STATUS',
      state: this.browserManager.getState(),
      url: this.browserManager.getCurrentUrl(),
      dimensions: this.browserManager.getDimensions(),
    });
  }

  /**
   * LIVE 再接続処理 (現挙動を完全維持: stale判定 -> restart -> ライブ)
   */
  private startLive(socket: WebSocket): void {
    const cachedKeyframe = this.encoder.getCachedKeyframe();
    let isStale = false;
    if (cachedKeyframe) {
      if (typeof this.encoder.isKeyframeStale === 'function') {
        isStale = this.encoder.isKeyframeStale(2000000n);
      } else if (typeof (this.encoder as any).getCurrentPts === 'function') {
        const currentPts = (this.encoder as any).getCurrentPts();
        isStale = (currentPts - cachedKeyframe.pts) >= 2000000n;
      }
    }

    if (isStale) {
      console.log('[WebSocketHandler] Cached keyframe is stale (>= 2s). Restarting video encoder for fresh IDR keyframe...');
      this.encoder.restart().catch((err) => {
        console.error('[WebSocketHandler] Failed to restart encoder on stale keyframe:', err);
      });
    } else if (cachedKeyframe && socket.readyState === 1) {
      const packet = MessageMultiplexer.packVideo(VIDEO_FLAGS.KEYFRAME | VIDEO_FLAGS.CONFIG, cachedKeyframe.pts, cachedKeyframe.data);
      socket.send(packet);
    } else {
      const cachedSpsPps = this.encoder.getCachedSpsPps();
      if (cachedSpsPps && socket.readyState === 1) {
        const packet = MessageMultiplexer.packVideo(VIDEO_FLAGS.CONFIG, 0n, cachedSpsPps);
        socket.send(packet);
      }
    }

    const cachedOpusHead = this.encoder.getCachedOpusHead();
    if (cachedOpusHead && socket.readyState === 1) {
      const packet = MessageMultiplexer.packAudio(AUDIO_FLAGS.CONFIG, 0n, cachedOpusHead);
      socket.send(packet);
    }
  }

  /**
   * CATCHUP ペーシング送出の開始
   */
  private startCatchup(
    session: ClientSession,
    catchupData: { frames: BufferedFrame[]; configVideo?: Buffer; configAudio?: Buffer }
  ): void {
    session.mode = 'CATCHUP';
    session.playbackQueue = [...catchupData.frames];

    // クライアントの VideoDecoder / AudioPlayer を確実に初期化するための CONFIG パケットを送出
    if (catchupData.configVideo && session.socket.readyState === 1) {
      session.socket.send(MessageMultiplexer.packVideo(VIDEO_FLAGS.CONFIG, 0n, catchupData.configVideo));
    }
    if (catchupData.configAudio && session.socket.readyState === 1) {
      session.socket.send(MessageMultiplexer.packAudio(AUDIO_FLAGS.CONFIG, 0n, catchupData.configAudio));
    }

    // 1x 等速ペーシングループ開始
    this.scheduleNextCatchupFrame(session);
  }

  /**
   * 等速 (1x) ペーシングによる順次送出
   */
  private scheduleNextCatchupFrame(session: ClientSession): void {
    if (session.mode !== 'CATCHUP' || session.socket.readyState !== 1) {
      return;
    }

    if (session.playbackQueue.length === 0) {
      console.log('[WebSocketHandler] CATCHUP playback queue empty. Transitioning to LIVE mode.');
      session.mode = 'LIVE';
      return;
    }

    const frame = session.playbackQueue.shift()!;
    const packet = frame.type === 'video'
      ? MessageMultiplexer.packVideo(frame.flags, frame.pts, frame.data)
      : MessageMultiplexer.packAudio(frame.flags, frame.pts, frame.data);

    session.socket.send(packet);

    if (session.playbackQueue.length === 0) {
      console.log('[WebSocketHandler] CATCHUP playback finished after sending last frame. Transitioning to LIVE mode.');
      session.mode = 'LIVE';
      return;
    }

    const nextFrame = session.playbackQueue[0];
    let deltaUs = nextFrame.pts - frame.pts;
    if (deltaUs < 0n) deltaUs = 0n;
    // 異常なPTSジャンプをクランプ (最大100ms)
    if (deltaUs > 100000n) deltaUs = 33000n;

    const delayMs = Math.max(0, Math.round(Number(deltaUs) / 1000));

    session.pacingTimer = setTimeout(() => {
      session.pacingTimer = null;
      this.scheduleNextCatchupFrame(session);
    }, delayMs);
  }

  private handleTouchMessage(buf: Buffer): void {
    if (buf.length < 33) return;
    const action = buf.readUInt8(2);
    const pointerId = Number(buf.readBigInt64BE(3));
    const x = buf.readInt32BE(11);
    const y = buf.readInt32BE(15);
    const screenWidth = buf.readUInt16BE(19);
    const screenHeight = buf.readUInt16BE(21);

    this.inputManager.handleTouchEvent({
      action,
      pointerId,
      x,
      y,
      screenWidth,
      screenHeight,
    });
  }

  private handleResizeMessage(buf: Buffer): void {
    if (buf.length < 5) return;
    const requestedW = buf.readUInt16BE(1);
    const requestedH = buf.readUInt16BE(3);
    const dpr = buf.length >= 7 ? buf.readUInt16BE(5) / 100 : 1;

    let effW = requestedW;
    let effH = requestedH;
    if (requestedW < 1000) {
      const scale = Math.max(1.25, Math.min(1.5, dpr > 1 ? dpr : 1.35));
      effW = Math.round(requestedW * scale);
      effH = Math.round(requestedH * scale);
    }

    const width = Math.max(640, Math.min(1920, effW)) & ~7;
    const height = Math.max(360, Math.min(1080, effH)) & ~1;

    if (width === this.currentResWidth && height === this.currentResHeight) {
      return;
    }

    console.log(`[WebSocketHandler] Client requested resize: ${requestedW}x${requestedH} (dpr=${dpr.toFixed(2)}) -> effective ${width}x${height}`);

    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
    }

    this.resizeTimer = setTimeout(async () => {
      try {
        console.log(`[WebSocketHandler] Executing dynamic server resize to ${width}x${height}...`);
        // 解像度変更時はバッファ全消去 (要件2)
        this.playbackBuffer.clear();
        for (const session of this.clientSessions.values()) {
          if (session.mode === 'CATCHUP') {
            this.abortCatchupAndSwitchToLive(session);
          }
        }

        await this.browserManager.resize(width, height);
        await this.encoder.restart(width, height);
        this.inputManager.updateDimensions(width, height);
        this.currentResWidth = width;
        this.currentResHeight = height;

        this.broadcastControl({
          type: 'RESOLUTION_CHANGED',
          width,
          height,
        });
        console.log(`[WebSocketHandler] Server successfully resized to ${width}x${height}`);
      } catch (err) {
        console.error('[WebSocketHandler] Failed to apply resize:', err);
      }
    }, 400);
  }

  private handleMetricsMessage(buf: Buffer): void {
    try {
      const jsonStr = buf.subarray(1).toString('utf-8');
      const metrics = JSON.parse(jsonStr);
      MetricsManager.getInstance().addMetrics(metrics);
    } catch (err) {
      console.warn('[WebSocketHandler] Failed to parse metrics message:', err);
    }
  }

  private async handleCommandMessage(socket: WebSocket, buf: Buffer): Promise<void> {
    try {
      const jsonStr = buf.subarray(1).toString('utf-8');
      const cmd = JSON.parse(jsonStr);

      switch (cmd.type) {
        // 要件3: ACK プロトコル (デコード済み video PTS)
        case 'ACK': {
          if (cmd.pts !== undefined && cmd.pts !== null) {
            const ackPts = BigInt(Math.round(Number(cmd.pts)));
            const session = this.clientSessions.get(socket);
            if (session) {
              session.lastAckPts = ackPts;
            }
            this.lastKnownAckPts = ackPts;
          }
          return; // ACK はバックグラウンド同期であり、ユーザー入力アクティビティではない
        }

        case 'PING': {
          const session = this.clientSessions.get(socket);
          const latestPts = typeof (this.encoder as any).getCurrentPts === 'function'
            ? Number((this.encoder as any).getCurrentPts())
            : 0;
          const catchupQueueMs =
            session && session.mode === 'CATCHUP' && session.playbackQueue.length > 1
              ? Math.max(0, Math.round(Number(session.playbackQueue[session.playbackQueue.length - 1].pts - session.playbackQueue[0].pts) / 1000))
              : 0;
          socket.send(MessageMultiplexer.packControl({
            type: 'PONG',
            id: cmd.id,
            clientTime: cmd.clientTime,
            serverTime: performance.now(),
            latestPts,
            serverMode: session?.mode || 'LIVE',
            catchupQueueMs,
          }));
          break;
        }

        case 'JUMP_TO_LIVE': {
          this.recordInputActivity(socket);
          const session = this.clientSessions.get(socket);
          if (session) {
            console.log('[WebSocketHandler] Explicit JUMP_TO_LIVE requested by client. Switching immediately to LIVE.');
            this.abortCatchupAndSwitchToLive(session);
          }
          this.sendControl(socket, { type: 'LIVE_JUMPED', timestamp: Date.now() });
          break;
        }

        case 'RESTART_ENCODER':
        case 'CLEAN_RESTART_STREAM': {
          this.recordInputActivity(socket);
          await this.restartStream();
          break;
        }

        case 'SET_ZOOM': {
          this.recordInputActivity(socket);
          if (cmd.displayScale !== undefined) {
            const scale = Number(cmd.displayScale);
            this.configStore.updateConfig({ displayScale: scale });
            if (typeof (this.browserManager as any).setDisplayScale === 'function') {
              await (this.browserManager as any).setDisplayScale(scale);
            }
            this.broadcastControl({ type: 'ZOOM_CHANGED', displayScale: scale });
          }
          break;
        }

        case 'METRICS_REPORT':
          if (cmd.metrics) {
            MetricsManager.getInstance().addMetrics(cmd.metrics);
          }
          break;

        case 'NAVIGATE':
          this.recordInputActivity(socket);
          if (!cmd.url || typeof cmd.url !== 'string' || !/^https?:\/\//i.test(cmd.url.trim())) {
            this.sendControl(socket, { type: 'ERROR', message: 'Invalid URL: Only http:// and https:// URLs are permitted.' });
            break;
          }
          // 要件8: ページ移動・再ナビゲーション時はバッファ消去＋LIVE
          this.playbackBuffer.clear();
          for (const s of this.clientSessions.values()) {
            if (s.mode === 'CATCHUP') {
              this.abortCatchupAndSwitchToLive(s);
            }
          }
          await this.browserManager.navigate(cmd.url);
          this.broadcastControl({ type: 'BROWSER_STATUS', url: cmd.url, state: this.browserManager.getState() });
          break;

        case 'NAVIGATE_BACK':
          this.recordInputActivity(socket);
          this.playbackBuffer.clear();
          for (const s of this.clientSessions.values()) {
            if (s.mode === 'CATCHUP') {
              this.abortCatchupAndSwitchToLive(s);
            }
          }
          this.inputManager.navigateBack();
          break;

        case 'NAVIGATE_FORWARD':
          this.recordInputActivity(socket);
          this.playbackBuffer.clear();
          for (const s of this.clientSessions.values()) {
            if (s.mode === 'CATCHUP') {
              this.abortCatchupAndSwitchToLive(s);
            }
          }
          this.inputManager.navigateForward();
          break;

        case 'RELOAD':
          this.recordInputActivity(socket);
          this.playbackBuffer.clear();
          for (const s of this.clientSessions.values()) {
            if (s.mode === 'CATCHUP') {
              this.abortCatchupAndSwitchToLive(s);
            }
          }
          this.inputManager.reloadPage();
          break;

        case 'TOGGLE_FULLSCREEN':
        case 'TOGGLE_CINEMA':
          this.recordInputActivity(socket);
          this.inputManager.toggleVideoFullscreen();
          break;

        case 'KEY':
          this.recordInputActivity(socket);
          if (cmd.key) {
            this.inputManager.sendKey(cmd.key);
          }
          break;

        case 'TYPE_TEXT':
          this.recordInputActivity(socket);
          if (cmd.text) {
            await this.browserManager.typeText(cmd.text, cmd.enter !== false);
          }
          break;

        case 'PAUSE_BROWSER':
          this.recordInputActivity(socket);
          this.encoder.stop();
          this.browserManager.pause();
          this.broadcastControl({ type: 'BROWSER_STATUS', state: 'paused' });
          break;

        case 'RESUME_BROWSER':
          this.recordInputActivity(socket);
          this.browserManager.resume();
          if (!this.encoder.isRunning()) {
            this.encoder.start();
          }
          this.broadcastControl({ type: 'BROWSER_STATUS', state: 'running' });
          break;

        case 'RESTART_BROWSER':
          this.recordInputActivity(socket);
          this.playbackBuffer.clear();
          for (const s of this.clientSessions.values()) {
            if (s.mode === 'CATCHUP') {
              this.abortCatchupAndSwitchToLive(s);
            }
          }
          await this.browserManager.restartChrome();
          if (!this.encoder.isRunning()) {
            this.encoder.start();
          }
          this.broadcastControl({ type: 'BROWSER_STATUS', state: 'running' });
          break;

        default:
          console.warn('[WebSocketHandler] Unknown command type:', cmd.type);
      }
    } catch (err) {
      console.warn('[WebSocketHandler] Failed to parse command JSON:', err);
    }
  }

  private bindEncoderEvents(): void {
    // Video packet from FFmpeg
    this.encoder.on('video', ({ flags, pts, data }: { flags: number; pts: bigint; data: Buffer }) => {
      // 要件2: 'video' イベント時にバッファへ追記
      this.playbackBuffer.addVideo(flags, pts, data);

      if (this.authenticatedClients.size === 0) return;

      const packet = MessageMultiplexer.packVideo(flags, pts, data);
      this.videoFramesSent++;
      this.videoBytesSent += packet.length;

      const isKeyframe = (flags & VIDEO_FLAGS.KEYFRAME) !== 0;
      const bps = this.configStore.getConfig().stream?.bitrate || 1000000;
      // Hysteresis backpressure watermarks: must be large enough (512KB-1536KB) so a 60KB IDR keyframe
      // never triggers false GOP dropping on mobile LTE connections!
      const HIGH_WATER_MARK = Math.max(512 * 1024, Math.min(1536 * 1024, Math.round((bps / 8) * 3.0)));
      const LOW_WATER_MARK = Math.max(96 * 1024, Math.round(HIGH_WATER_MARK * 0.2));

      for (const client of this.authenticatedClients) {
        if (client.readyState === 1) { // OPEN
          const session = this.clientSessions.get(client);
          if (session && session.mode === 'CATCHUP') {
            // CATCHUP クライアントにはキュー末尾へ追記（追いつくまでバッファ優先）
            session.playbackQueue.push({ type: 'video', flags, pts, data });
            if (session.playbackQueue.length > 2000) {
              console.warn('[WebSocketHandler] Catchup queue exceeded limit (2000 frames). Falling back to LIVE.');
              this.abortCatchupAndSwitchToLive(session);
            }
            continue;
          }

          // LIVE クライアント: 既存のヒステリシスバックプレッシャー処理
          const buffered = (client as any).bufferedAmount || 0;

          if (buffered > HIGH_WATER_MARK) {
            (client as any)._droppingGop = true;
          }

          if ((client as any)._droppingGop) {
            if (!isKeyframe || buffered > LOW_WATER_MARK) {
              continue;
            }
            (client as any)._droppingGop = false;
          }

          client.send(packet);
        }
      }
    });

    // Audio packet from FFmpeg
    this.encoder.on('audio', ({ flags, pts, data }: { flags: number; pts: bigint; data: Buffer }) => {
      // 要件2: 'audio' イベント時にバッファへ追記
      this.playbackBuffer.addAudio(flags, pts, data);

      if (this.authenticatedClients.size === 0) return;

      const packet = MessageMultiplexer.packAudio(flags, pts, data);
      this.audioPacketsSent++;

      for (const client of this.authenticatedClients) {
        if (client.readyState === 1) { // OPEN
          const session = this.clientSessions.get(client);
          if (session && session.mode === 'CATCHUP') {
            session.playbackQueue.push({ type: 'audio', flags, pts, data });
            continue;
          }

          const buffered = (client as any).bufferedAmount || 0;
          if (buffered <= 2 * 1024 * 1024) {
            client.send(packet);
          }
        }
      }
    });
  }

  private scheduleAutoSleep(): void {
    if (this.autoSleepTimer) clearTimeout(this.autoSleepTimer);
    const config = this.configStore.getConfig();
    const autoSleepMins = typeof config.autoSleepMinutes === 'number' ? config.autoSleepMinutes : 3;
    if (autoSleepMins === 0) {
      console.log('[WebSocketHandler] Auto-sleep disabled (autoSleepMinutes=0).');
      return;
    }
    const delayMs = Math.max(15000, autoSleepMins * 60 * 1000);
    console.log(`[WebSocketHandler] No clients connected. Scheduling auto-sleep in ${delayMs / 1000}s...`);

    this.autoSleepTimer = setTimeout(() => {
      if (this.authenticatedClients.size === 0) {
        console.log('[WebSocketHandler] Auto-sleep triggered: stopping FFmpeg encoder and pausing browser (True CPU 0%).');
        this.encoder.stop();
        this.browserManager.pause();
      }
    }, delayMs);
  }

  private startStatsBroadcast(): void {
    this.statsTimer = setInterval(() => {
      if (this.authenticatedClients.size === 0) return;

      const now = performance.now();
      const elapsedSec = (now - this.lastStatsTime) / 1000;
      if (elapsedSec < 1) return;

      const fps = Math.round(this.videoFramesSent / elapsedSec);
      const bitrateKbps = Math.round((this.videoBytesSent * 8) / (elapsedSec * 1000));
      const audioPps = Math.round(this.audioPacketsSent / elapsedSec);

      this.videoFramesSent = 0;
      this.videoBytesSent = 0;
      this.audioPacketsSent = 0;
      this.lastStatsTime = now;

      this.broadcastControl({
        type: 'SERVER_METRICS',
        fps,
        bitrateKbps,
        audioPps,
        browserState: this.browserManager.getState(),
      });
    }, 2000).unref();
  }

  private sendControl(socket: WebSocket, payload: unknown): void {
    if (socket.readyState === 1) {
      socket.send(MessageMultiplexer.packControl(payload));
    }
  }

  private broadcastControl(payload: unknown): void {
    const packet = MessageMultiplexer.packControl(payload);
    for (const client of this.authenticatedClients) {
      if (client.readyState === 1) {
        client.send(packet);
      }
    }
  }

  public close(): void {
    if (this.autoSleepTimer) clearTimeout(this.autoSleepTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);

    for (const session of this.clientSessions.values()) {
      if (session.pacingTimer) {
        clearTimeout(session.pacingTimer);
        session.pacingTimer = null;
      }
      session.playbackQueue = [];
    }
    this.clientSessions.clear();
    this.playbackBuffer.clear();

    this.encoder.stop();
    this.authenticatedClients.clear();
    this.allClients.clear();
  }
}
