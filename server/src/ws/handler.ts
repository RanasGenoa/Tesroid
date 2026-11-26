import type { WebSocket } from 'ws';
import type { AuthService } from '../auth.js';
import { type BrowserManager, isSafeHttpUrl } from '../browser/manager.js';
import { type ConfigStore, resolveClientProfile } from '../config.js';
import { computeEncodeDimensions } from '../encoder/encode-dimensions.js';
import type { VaapiEncoder } from '../encoder/ffmpeg.js';
import { type BufferedFrame, PlaybackBuffer } from '../encoder/playback-buffer.js';
import type { X11InputManager } from '../input/xdotool.js';
import { MetricsManager } from '../metrics/manager.js';
import { TelemetryManager } from '../telemetry/manager.js';
import { MessageMultiplexer } from './multiplexer.js';
import { AUDIO_FLAGS, VIDEO_FLAGS, WSS_CHANNEL } from './protocol.js';

export type SessionRole = 'primary' | 'secondary';

export interface ClientSession {
  socket: WebSocket;
  authToken?: string;
  role?: SessionRole;
  isStandby?: boolean;
  isActingPrimary?: boolean;
  intentionalDisconnect?: boolean;
  telemetrySessionId?: string;
  lastAckPts: bigint | null;
  lastSentVideoPts?: bigint | null;
  mode: 'LIVE' | 'CATCHUP';
  pacingTimer: NodeJS.Timeout | null;
  playbackQueue: BufferedFrame[];
  isDroppingGop?: boolean;
  isBurstMode?: boolean;
  isFlowPaused?: boolean;
  bufferedMs?: number;
  audioBufferedMs?: number;
  targetBufferMs?: number;
  isInteractive?: boolean;
  lastBufferFeedbackAt?: number;
  // Issue #104: ACK 進行度から推定する実効排水レート（実時間倍数）とバックログ間引きの間隔制御
  ackDrainRateEwma?: number;
  lastAckProgressAtMs?: number;
  lastAckProgressPts?: bigint;
  lastBacklogPruneAtMs?: number;
  catchupCongestionStreak?: number;
}

export class WebSocketHandler {
  private authService: AuthService;
  private browserManager: BrowserManager;
  private encoder: VaapiEncoder;
  private inputManager: X11InputManager;
  private configStore: ConfigStore;

  private authenticatedClients: Set<WebSocket> = new Set();
  private allClients: Set<WebSocket> = new Set();
  private lastSessionToken: string | null = null;
  private authorizedSessions: Map<
    string,
    { role: SessionRole; standby?: boolean; actingPrimary?: boolean }
  > = new Map();

  private static readonly DEFAULT_TARGET_BUFFER_MS = 10000;
  private static readonly MAX_TARGET_BUFFER_MS = 30000;
  // 60fps video + 50pps (20ms) Opus audio = 110 frames/s -> 30s = 3,300 frames, 60s = 6,600 frames
  private static readonly MAX_CATCHUP_QUEUE_FRAMES = 6600;
  private static readonly ACK_PROGRESS_MIN_WINDOW_MS = 250;
  private static readonly ACK_PROGRESS_MAX_WINDOW_MS = 5000;
  private static readonly DRAIN_RATE_CONGESTION_THRESHOLD = 0.85;
  private static readonly CATCHUP_DEFAULT_SOCKET_GUARD_BYTES = 128 * 1024;
  private static readonly CATCHUP_MIN_BACKLOG_CAP_MS = 30000;

  // Issue #111 Buffer-Hold Pause: 動的閾値の境界。holdTriggerMs は targetBufferMs に連動し
  // 10〜30秒へクランプ (target=0 は Hold 無効)。再開側はハードウェアエンコード (VAAPI/NVENC) の
  // IDR/GOP ヘッドルーム 2s、ソフトウェアエンコード 3s を基準とし、holdTrigger − resume ≥ 7.2s を確保する。
  private static readonly HOLD_TRIGGER_MIN_MS = 10000;
  private static readonly HOLD_TRIGGER_MAX_MS = 30000;
  private static readonly HOLD_HEADROOM_VAAPI_MS = 2000;
  private static readonly HOLD_HEADROOM_SOFTWARE_MS = 3000;
  private static readonly HOLD_MIN_HYSTERESIS_MS = 7200;
  // Issue #111: 復帰ゲートのタイムアウト安全弁 (再起動後に IDR が一度も来ない異常対策)。
  // 本来の境界は PTS 比較 (ffmpeg.ts の resumeBoundaryPtsUs) で決まるため、期限は長めに取る。
  private static readonly RESUME_GATE_MS = 8000;
  // Issue #115: FORCE_VIDEO_IDR のサーバー側レート制限。ペーサー側の 1回/秒と二重に、
  // 映像エンコーダ再起動 (ライブエッジ新規 IDR) は 5s に 1回までとする。
  public static readonly FORCED_IDR_COOLDOWN_MS = 5_000;
  // Issue #112: 正常な LIVE 状態での LIVE タップ時に全体再起動をスキップする滞留上限 (ms)。
  // 250ms の BUFFER_FEEDBACK 周期・クライアント側ペーサークッション・RTT を考慮し 1000ms を許容する。
  private static readonly LIVE_TAP_SKIP_MAX_HELD_MS = 1000;
  // targetBufferMs=0 (オフ) でも CATCHUP 送出ゲートが永久閉鎖しないための実効窓下限
  private static readonly MIN_CATCHUP_WINDOW_MS = 400;

  // Playback ring buffer & CATCHUP state machine
  private playbackBuffer: PlaybackBuffer;
  private lastInputAt: number = Date.now();
  private lastKnownAckPts: bigint | null = null;
  private lastKnownTargetBufferMs: number = WebSocketHandler.DEFAULT_TARGET_BUFFER_MS;
  private clientSessions: Map<WebSocket, ClientSession> = new Map();

  private autoSleepTimer: NodeJS.Timeout | null = null;
  // Issue #111 Buffer-Hold Pause 状態。SLEEP_PAUSED は browserManager の 'paused' 状態と
  // enterSleepPaused() が単一管理するため、このフィールドは ACTIVE / BUFFER_HOLD_PAUSED のみ。
  private pipelineHoldState: 'ACTIVE' | 'BUFFER_HOLD_PAUSED' = 'ACTIVE';
  private holdExpireTimer: NodeJS.Timeout | null = null;
  private holdResumePollTimer: NodeJS.Timeout | null = null;
  private lastHoldEvalAtMs = 0;
  private holdStartedAtMs = 0;
  // Issue #115: 直近の FORCE_VIDEO_IDR 実行時刻 (FORCED_IDR_COOLDOWN_MS の基準)
  private lastForcedVideoIdrAtMs = 0;
  private actingPrimaryGraceTimer: NodeJS.Timeout | null = null;
  private pendingIntentionalPrimaryToken: string | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private resizeTimer: NodeJS.Timeout | null = null;
  private unsubscribePageInfo: (() => void) | null = null;
  private currentResWidth = 1280;
  private currentResHeight = 720;
  // Issue #11: 実際のエンコード出力寸法 (標準プロファイルでは layout 寸法と常に一致)
  private currentEncodeWidth = 1280;
  private currentEncodeHeight = 720;

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
    playbackBuffer?: PlaybackBuffer,
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
    this.currentEncodeWidth = dims.width;
    this.currentEncodeHeight = dims.height;

    if (typeof this.browserManager.onPageInfoChanged === 'function') {
      this.unsubscribePageInfo = this.browserManager.onPageInfoChanged(({ url, title }) => {
        this.broadcastControl({
          type: 'BROWSER_STATUS',
          state: this.browserManager.getState(),
          url,
          title,
          dimensions: this.browserManager.getDimensions(),
        });
      });
    }

    this.bindEncoderEvents();
    this.startStatsBroadcast();
    this.scheduleAutoSleep();
  }

  public hasActiveClients(): boolean {
    return this.authenticatedClients.size > 0;
  }

  public hasPrimaryClients(): boolean {
    return this.getPrimarySession() !== undefined;
  }

  public hasActingPrimaryClients(): boolean {
    for (const client of this.authenticatedClients) {
      const session = this.clientSessions.get(client);
      if (session?.role === 'secondary' && session.isActingPrimary) {
        return true;
      }
    }
    return false;
  }

  private isEffectivelyPrimary(session?: ClientSession): boolean {
    return Boolean(session && (session.role !== 'secondary' || session.isActingPrimary));
  }

  public broadcastStreamSettings(stream: {
    maxFps?: number;
    bitrate?: number;
    fpsOptions?: number[]; // Issue #11: HUD の FPS 選択肢 (クライアント負荷プロファイル由来)
  }): void {
    this.broadcastControl({
      type: 'STREAM_SETTINGS_UPDATED',
      stream,
    });
  }

  private getPrimarySession(): ClientSession | undefined {
    for (const client of this.authenticatedClients) {
      const session = this.clientSessions.get(client);
      if (session && session.role !== 'secondary') {
        return session;
      }
    }
    return undefined;
  }

  private notifySecondaryClientsPrimaryStatus(active: boolean): WebSocket[] {
    const transitionedClients: WebSocket[] = [];
    for (const client of this.authenticatedClients) {
      const session = this.clientSessions.get(client);
      if (session?.role !== 'secondary') continue;
      if (active && !session.isStandby) {
        if (session.authToken) {
          const authEntry = this.authorizedSessions.get(session.authToken);
          if (authEntry) authEntry.standby = false;
        }
        continue;
      }
      session.isStandby = !active;
      if (session.authToken) {
        const authEntry = this.authorizedSessions.get(session.authToken);
        if (authEntry) authEntry.standby = !active;
      }
      this.sendControl(client, {
        type: 'PRIMARY_SESSION_STATUS',
        active,
      });
      if (active) {
        this.sendControl(client, {
          type: 'BROWSER_STATUS',
          state: this.browserManager.getState(),
          url: this.browserManager.getCurrentUrl(),
          title:
            typeof this.browserManager.getCurrentTitle === 'function'
              ? this.browserManager.getCurrentTitle()
              : '',
          dimensions: this.browserManager.getDimensions(),
        });
        transitionedClients.push(client);
      }
    }
    return transitionedClients;
  }

  private hasActiveStreamingSecondary(): boolean {
    for (const client of this.authenticatedClients) {
      const session = this.clientSessions.get(client);
      if (session?.role === 'secondary' && !session.isStandby && client.readyState === 1) {
        return true;
      }
    }
    return false;
  }

  private clearActingPrimaryGraceTimer(): void {
    if (this.actingPrimaryGraceTimer) {
      clearTimeout(this.actingPrimaryGraceTimer);
      this.actingPrimaryGraceTimer = null;
    }
    this.pendingIntentionalPrimaryToken = null;
  }

  private enterSecondaryStandby(): void {
    for (const client of this.authenticatedClients) {
      const session = this.clientSessions.get(client);
      if (session?.role === 'secondary' && !session.isStandby) {
        session.isStandby = true;
        session.isActingPrimary = false;
        if (session.pacingTimer) {
          clearTimeout(session.pacingTimer);
          session.pacingTimer = null;
        }
        session.playbackQueue = [];
        session.mode = 'LIVE';
        if (session.authToken) {
          const authEntry = this.authorizedSessions.get(session.authToken);
          if (authEntry) {
            authEntry.standby = true;
            authEntry.actingPrimary = false;
          }
        }
        this.sendControl(client, {
          type: 'PRIMARY_SESSION_STATUS',
          active: false,
        });
      }
    }
  }

  private promoteSecondaryToActingPrimary(): boolean {
    if (this.hasActingPrimaryClients()) return true;
    for (const client of this.authenticatedClients) {
      const session = this.clientSessions.get(client);
      if (session?.role === 'secondary' && !session.isStandby && client.readyState === 1) {
        session.isActingPrimary = true;
        if (session.authToken) {
          const authEntry = this.authorizedSessions.get(session.authToken);
          if (authEntry) authEntry.actingPrimary = true;
        }
        if (this.autoSleepTimer) {
          clearTimeout(this.autoSleepTimer);
          this.autoSleepTimer = null;
        }
        this.sendControl(client, {
          type: 'SESSION_ROLE_CHANGED',
          effectiveRole: 'acting_primary',
        });
        const cachedOpusHead = this.encoder.getCachedOpusHead();
        if (cachedOpusHead) {
          client.send(MessageMultiplexer.packAudio(AUDIO_FLAGS.CONFIG, 0n, cachedOpusHead));
        }
        console.log(
          '[WebSocketHandler] Promoted active secondary display to acting primary after intentional primary disconnect.',
        );
        return true;
      }
    }
    return false;
  }

  private sendLiveJumped(socket: WebSocket): void {
    const liveEdgePtsUs =
      typeof this.encoder.getCurrentPts === 'function' ? Number(this.encoder.getCurrentPts()) : 0;
    // Issue #111: クライアントへライブエッジ基準 PTS を返すだけでなく、サーバー側でも同一境界より古い
    // 音声パケットの送出を破棄する (滞留音声が A/V オフセットとして残留するのを防ぐ)。
    if (liveEdgePtsUs > 0 && typeof this.encoder.setResumeBoundary === 'function') {
      this.encoder.setResumeBoundary(BigInt(Math.round(liveEdgePtsUs)));
    }
    this.sendControl(socket, {
      type: 'LIVE_JUMPED',
      timestamp: Date.now(),
      ...(liveEdgePtsUs > 0 ? { dropAudioBeforePts: liveEdgePtsUs } : {}),
    });
  }

  private notifyOtherSessionsLiveJump(sourceSocket: WebSocket): void {
    // Issue #103: 他の認証済みセッションにも確定ライブエッジ PTS を通知し、PONG 外挿の
    // 暫定バリアだけでなく同一の基準値で滞留音声の混入を防ぐ（マルチセッション構成対策）
    const liveEdgePtsUs =
      typeof this.encoder.getCurrentPts === 'function' ? Number(this.encoder.getCurrentPts()) : 0;
    for (const client of this.authenticatedClients) {
      if (client === sourceSocket) continue;
      const session = this.clientSessions.get(client);
      if (!session) continue;
      if (session.mode === 'CATCHUP') {
        this.abortCatchupAndSwitchToLive(session);
      }
      this.sendControl(client, {
        type: 'PRIMARY_JUMP_TO_LIVE',
        timestamp: Date.now(),
        ...(liveEdgePtsUs > 0 ? { dropAudioBeforePts: liveEdgePtsUs } : {}),
      });
    }
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
      targetBufferMs: this.lastKnownTargetBufferMs,
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
          if (this.clientSessions.get(socket)?.isStandby) {
            return;
          }
          this.recordInputActivity(socket);
          this.handleTouchMessage(buf);
          return;
        }

        // 3. Resize Channel (0x11)
        if (channel === WSS_CHANNEL.RESIZE) {
          this.handleResizeMessage(buf, socket);
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

        // 6. Telemetry Channel (0x15)
        if (channel === WSS_CHANNEL.TELEMETRY) {
          const session = this.clientSessions.get(socket);
          if (session) {
            this.handleTelemetryMessage(session, buf);
          }
          return;
        }
      } catch (err) {
        console.error('[WebSocketHandler] Error handling WS message:', err);
      }
    });

    socket.on('close', (code?: number) => {
      const wasAuthenticated = this.authenticatedClients.has(socket);
      this.allClients.delete(socket);
      this.authenticatedClients.delete(socket);

      const session = this.clientSessions.get(socket);
      const wasPrimary = wasAuthenticated && session?.role !== 'secondary';
      const isExplicitDisconnect = Boolean(session?.intentionalDisconnect) || code === 1000;
      const isGoingAwayClose = !isExplicitDisconnect && code === 1001;
      const closedAuthToken = session?.authToken;
      if (session) {
        if (session.pacingTimer) {
          clearTimeout(session.pacingTimer);
          session.pacingTimer = null;
        }
        session.playbackQueue = [];
        if (this.isEffectivelyPrimary(session)) {
          if (session.lastAckPts !== null) {
            this.lastKnownAckPts = session.lastAckPts;
          }
          if (typeof session.targetBufferMs === 'number') {
            this.lastKnownTargetBufferMs = session.targetBufferMs;
          }
        }
        this.clientSessions.delete(socket);
      }
      if (isExplicitDisconnect && closedAuthToken) {
        this.authorizedSessions.delete(closedAuthToken);
      }

      console.log(
        `[WebSocketHandler] Client disconnected (code=${code ?? 'unknown'}). Remaining auth: ${this.authenticatedClients.size}, total: ${this.allClients.size}`,
      );

      if (wasPrimary && !this.hasPrimaryClients()) {
        if (isExplicitDisconnect) {
          if (this.promoteSecondaryToActingPrimary()) {
            return;
          }
        } else if (isGoingAwayClose && this.hasActiveStreamingSecondary()) {
          // Delay acting-primary promotion briefly on code 1001 (Going Away) so page reloads
          // that reconnect immediately with TOKEN: do not cause unnecessary role/encoder churn.
          this.clearActingPrimaryGraceTimer();
          this.pendingIntentionalPrimaryToken = closedAuthToken ?? null;
          this.actingPrimaryGraceTimer = setTimeout(() => {
            this.actingPrimaryGraceTimer = null;
            const expiredToken = this.pendingIntentionalPrimaryToken;
            this.pendingIntentionalPrimaryToken = null;
            if (!this.hasPrimaryClients()) {
              if (expiredToken) {
                this.authorizedSessions.delete(expiredToken);
              }
              if (!this.promoteSecondaryToActingPrimary()) {
                const isPipelineActive =
                  this.browserManager.getState() === 'running' || this.encoder.isRunning();
                if (isPipelineActive) {
                  this.scheduleAutoSleep();
                } else {
                  this.enterSecondaryStandby();
                }
              }
            }
          }, 3000);
          return;
        }
        const isPipelineActive =
          this.browserManager.getState() === 'running' || this.encoder.isRunning();
        if (isPipelineActive) {
          // Keep existing secondary clients streaming during the auto-sleep grace period
          // so transient network drops (within autoSleepMinutes, default 3 min) recover seamlessly for both front & rear.
          this.scheduleAutoSleep();
        } else {
          this.enterSecondaryStandby();
        }
      } else if (
        !this.hasPrimaryClients() &&
        !this.hasActingPrimaryClients() &&
        !this.actingPrimaryGraceTimer &&
        !this.autoSleepTimer &&
        (this.browserManager.getState() === 'running' || this.encoder.isRunning())
      ) {
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
    // Issue #111: Hold 中のユーザー操作は即解除 (キュー破棄と LIVE_JUMPED は下の既存経路が担う)。
    // 凍結 Chrome への入力注入を発生させないため、SIGCONT + FFmpeg 再開を先に行う。
    if (this.pipelineHoldState === 'BUFFER_HOLD_PAUSED') {
      this.exitBufferHold('user_input');
    }
    if (socket) {
      const session = this.clientSessions.get(socket);
      let switchedAnyCatchup = false;
      if (session && session.mode === 'CATCHUP') {
        console.log(
          '[WebSocketHandler] Auto-Hybrid: User input detected during CATCHUP. Switching immediately to LIVE mode.',
        );
        this.abortCatchupAndSwitchToLive(session);
        this.sendLiveJumped(socket);
        switchedAnyCatchup = true;
      }
      for (const otherClient of this.authenticatedClients) {
        if (otherClient !== socket && this.clientSessions.get(otherClient)?.mode === 'CATCHUP') {
          switchedAnyCatchup = true;
          break;
        }
      }
      if (switchedAnyCatchup) {
        this.notifyOtherSessionsLiveJump(socket);
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
   * Video / Audio の両エンコーダが稼働していることを保証する。
   * startLive() 等の Video-only restart 後に Audio FFmpeg が未起動のまま残留する
   * 「片肺無音」状態を防ぐため、isFullyRunning() を優先参照して不足側を起動する。
   */
  private ensureEncoderRunning(): void {
    const fullyRunning =
      typeof this.encoder.isFullyRunning === 'function'
        ? this.encoder.isFullyRunning()
        : this.encoder.isRunning();
    if (!fullyRunning) {
      this.encoder.start();
    }
  }

  /**
   * Issue #112: LIVE タップ由来の全体再起動を安全にスキップできるかを判定する。
   * パイプラインが既に正常な LIVE 状態 (Hold 非発動・Video/Audio 両エンコーダ稼働・
   * CATCHUP / GOPドロップ中セッション無し・サーバー保持量 serverHeldMs が小さい) の場合のみ true。
   * PlaybackBuffer は過去 60 秒の再接続用履歴を常時保持するリングバッファのため、
   * getBufferedDurationMs() は滞留指標に使わない。
   * 明示再起動 (?force=1 / RESTART_ENCODER 等) はこの判定を通さず常に restartStream() を実行する。
   */
  public canSkipFullRestart(): boolean {
    if (this.pipelineHoldState !== 'ACTIVE') return false;
    const encoderHealthy =
      typeof this.encoder.isFullyRunning === 'function'
        ? this.encoder.isFullyRunning()
        : this.encoder.isRunning();
    if (!encoderHealthy) return false;
    for (const session of this.clientSessions.values()) {
      if (session.mode === 'CATCHUP') return false;
      if ((session.socket as any)?._droppingGop) return false;
    }
    // クライアント再生位置よりサーバーが先に保持している時間 (Hold 判定と同じ実効プライマリ基準)
    if (this.serverHeldMs() > WebSocketHandler.LIVE_TAP_SKIP_MAX_HELD_MS) return false;
    return true;
  }

  /**
   * 配信プロセス（FFmpeg Video/Audio + サーバーリングバッファ + 全クライアントセッション）を完全にクリーン再起動する
   */
  public async restartStream(): Promise<void> {
    console.log(
      '[WebSocketHandler] Clean restarting entire streaming pipeline (FFmpeg Video/Audio + Buffers + Client Sessions)...',
    );
    if (this.pipelineHoldState === 'BUFFER_HOLD_PAUSED') {
      this.clearHoldTimers();
      this.pipelineHoldState = 'ACTIVE';
      this.browserManager.resumeFromBufferHold();
      this.encoder.resetHoldCompensation?.();
      this.broadcastControl({ type: 'BUFFER_HOLD', paused: false });
    }
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
  private abortCatchupAndSwitchToLive(
    session: ClientSession,
    options?: { skipEncoderRestart?: boolean },
  ): void {
    if (session.pacingTimer) {
      clearTimeout(session.pacingTimer);
      session.pacingTimer = null;
    }
    session.playbackQueue = [];
    session.mode = 'LIVE';
    session.isFlowPaused = false;
    session.lastSentVideoPts = null;
    session.catchupCongestionStreak = 0;
    (session.socket as any)._droppingGop = false;
    // Issue #104: LIVE ジャンプによる PTS 不連続跳躍を排水レート推定に混ぜない。
    // 学習済みの EWMA は保持し、基準点のみ再初期化する（ジャンプ直後の擬似高レート防止）
    session.lastAckProgressPts = undefined;
    session.lastAckProgressAtMs = undefined;

    if (options?.skipEncoderRestart) {
      return;
    }

    // ライブ最新 IDR（必要なら encoder.restart()）へ即ジャンプ (目標切替遅延: 1秒以内)
    const cachedKeyframe = this.encoder.getCachedKeyframe();
    let isStale = false;
    if (cachedKeyframe) {
      if (typeof this.encoder.isKeyframeStale === 'function') {
        isStale = this.encoder.isKeyframeStale(2000000n);
      } else if (typeof this.encoder.getCurrentPts === 'function') {
        const currentPts = this.encoder.getCurrentPts();
        isStale = currentPts - cachedKeyframe.pts >= 2000000n;
      }
    } else {
      isStale = true;
    }

    if (isStale) {
      console.log(
        '[WebSocketHandler] Live jump on input: cached keyframe is stale. Restarting encoder...',
      );
      this.encoder.restart().catch((err) => {
        console.error('[WebSocketHandler] Failed to restart encoder on input interrupt:', err);
      });
    } else if (session.socket.readyState === 1) {
      const sent = this.sendCachedKeyframeAndConfig(session.socket);
      if (!sent) {
        this.encoder.restart().catch((err) => {
          console.error('[WebSocketHandler] Failed to restart encoder on missing cache:', err);
        });
      }
    }
  }

  private async handleAuthMessage(socket: WebSocket, buf: Buffer): Promise<void> {
    const authPayload = buf.subarray(1).toString('utf-8').trim();
    const config = this.configStore.getConfig();

    // Check if client is authenticating with an existing session token (e.g. on WebSocket auto-reconnect)
    if (authPayload.startsWith('TOKEN:')) {
      const token = authPayload.slice(6).trim();
      if (!this.authService.validateSession(token)) {
        this.sendControl(socket, {
          type: 'AUTH_FAILED',
          error: 'Session expired or invalid',
          remainingAttempts: 10,
        });
        return;
      }

      // Allow reconnect for authorized primary/secondary sessions,
      // but reject background auto-reconnect from an unauthorized session while another client is active.
      const otherActiveSockets = [...this.authenticatedClients].filter((s) => s !== socket);
      const isPermittedWhileOthersActive =
        this.authorizedSessions.has(token) ||
        otherActiveSockets.every(
          (existing) => this.clientSessions.get(existing)?.authToken === token,
        );

      if (otherActiveSockets.length > 0 && !isPermittedWhileOthersActive) {
        console.log(
          '[WebSocketHandler] Rejecting auto-reconnect from unauthorized session while another client is active.',
        );
        this.sendControl(socket, {
          type: 'SESSION_CONFLICT',
          error: '他の端末が接続中のため自動再接続を中止しました。PINを再入力してください。',
        });
        this.evictClientSocket(socket, 4009, 'Another session is active');
        return;
      }

      for (const existing of otherActiveSockets) {
        if (this.clientSessions.get(existing)?.authToken === token) {
          this.evictClientSocket(existing, 4000, 'Replaced by reconnect');
        }
      }

      const existingAuth = this.authorizedSessions.get(token);
      const role: SessionRole = existingAuth?.role || 'primary';
      const wasStandby = Boolean(existingAuth?.standby);
      const wasActingPrimary = Boolean(existingAuth?.actingPrimary);
      this.authorizedSessions.set(token, {
        role,
        standby: wasStandby,
        actingPrimary: wasActingPrimary,
      });
      this.activateAuthenticatedSession(socket, token, false, role, true);
      return;
    }

    const isSecondary = authPayload.startsWith('SECONDARY:');
    const pin = isSecondary ? authPayload.slice('SECONDARY:'.length).trim() : authPayload;

    if (!config.isSetupCompleted) {
      // First-time setup always establishes a primary session
      try {
        await this.authService.setPin(pin);
        const authRes = await this.authService.verifyPin(pin);
        this.applyManualLogin(socket, authRes.token || 'session_token', false);
      } catch (err: any) {
        this.sendControl(socket, {
          type: 'AUTH_FAILED',
          error: err.message,
          remainingAttempts: 10,
        });
      }
      return;
    }

    const result = await this.authService.verifyPin(pin);
    if (result.success && result.token) {
      this.applyManualLogin(socket, result.token, isSecondary);
    } else {
      this.sendControl(socket, {
        type: 'AUTH_FAILED',
        error: 'Invalid PIN code',
        remainingAttempts: result.remainingAttempts,
      });
    }
  }

  private applyManualLogin(socket: WebSocket, token: string, isSecondary: boolean): void {
    if (isSecondary) {
      if (!this.hasPrimaryClients() && this.hasActingPrimaryClients()) {
        console.log(
          '[WebSocketHandler] Rejecting secondary login while acting primary is active; primary login required.',
        );
        this.sendControl(socket, {
          type: 'SESSION_CONFLICT',
          error:
            '現在、後席がメインセッション代理として稼働中のためセカンドディスプレイとして参加できません。メインとしてログインしてください。',
          hasActiveSession: false,
        });
        this.evictClientSocket(socket, 4009, 'Acting primary active; secondary join rejected');
        return;
      }

      // Prune stale inactive secondary tokens so authorizedSessions does not grow unbounded
      const activeTokens = new Set<string>();
      for (const client of this.authenticatedClients) {
        const activeToken = this.clientSessions.get(client)?.authToken;
        if (activeToken) activeTokens.add(activeToken);
      }
      for (const [existingToken, existingAuth] of this.authorizedSessions.entries()) {
        if (existingAuth.role === 'secondary' && !activeTokens.has(existingToken)) {
          this.authorizedSessions.delete(existingToken);
        }
      }
      this.authorizedSessions.set(token, {
        role: 'secondary',
        standby: !this.hasPrimaryClients(),
        actingPrimary: false,
      });
      this.activateAuthenticatedSession(socket, token, false, 'secondary');
      return;
    }

    // Manual primary PIN login supersedes existing primary sessions while keeping active secondary sessions
    const activeSecondaryTokens = new Set<string>();
    for (const client of this.authenticatedClients) {
      const clientSession = this.clientSessions.get(client);
      if (clientSession?.role === 'secondary' && clientSession.authToken) {
        activeSecondaryTokens.add(clientSession.authToken);
      }
    }
    for (const [existingToken, existingAuth] of this.authorizedSessions.entries()) {
      if (existingAuth.role !== 'secondary' || !activeSecondaryTokens.has(existingToken)) {
        this.authorizedSessions.delete(existingToken);
      }
    }
    this.authorizedSessions.set(token, { role: 'primary', standby: false, actingPrimary: false });
    this.activateAuthenticatedSession(socket, token, true, 'primary');
  }

  private activateAuthenticatedSession(
    socket: WebSocket,
    token: string,
    supersedeExisting = false,
    role: SessionRole = 'primary',
    isTokenReconnect = false,
  ): void {
    if (supersedeExisting) {
      const otherActiveSockets = [...this.authenticatedClients].filter((s) => s !== socket);
      for (const existing of otherActiveSockets) {
        const existingSession = this.clientSessions.get(existing);
        if (existingSession?.role === 'secondary') {
          continue;
        }
        console.log(
          '[WebSocketHandler] Disconnecting previous client session superseded by new PIN login.',
        );
        this.sendControl(existing, {
          type: 'SESSION_CONFLICT',
          error: '別の端末からPIN認証で接続されたため切断されました。',
        });
        this.evictClientSocket(existing, 4009, 'Superseded by new PIN login');
      }
    }

    let demotedActingPrimary = false;
    if (role === 'primary') {
      for (const client of this.authenticatedClients) {
        if (client === socket) continue;
        const existingSession = this.clientSessions.get(client);
        if (existingSession?.role === 'secondary' && existingSession.isActingPrimary) {
          existingSession.isActingPrimary = false;
          demotedActingPrimary = true;
          if (existingSession.authToken) {
            const authEntry = this.authorizedSessions.get(existingSession.authToken);
            if (authEntry) authEntry.actingPrimary = false;
          }
          this.sendControl(client, {
            type: 'SESSION_ROLE_CHANGED',
            effectiveRole: 'secondary',
          });
        }
      }
    }

    const otherActiveSockets = [...this.authenticatedClients].filter((s) => s !== socket);
    const hasOtherActiveClients = otherActiveSockets.length > 0;
    const isSwitchedSession = this.lastSessionToken !== null && this.lastSessionToken !== token;
    const preserveActivePipeline =
      (role === 'secondary' && (hasOtherActiveClients || this.encoder.isRunning())) ||
      (isTokenReconnect && hasOtherActiveClients);

    if (role === 'primary') {
      this.lastSessionToken = token;
    }

    const session = this.clientSessions.get(socket);
    if (session) {
      session.authToken = token;
      session.role = role;
      if (role === 'secondary' || (isSwitchedSession && !preserveActivePipeline)) {
        session.lastAckPts = null;
      }
    }

    if ((isSwitchedSession && !preserveActivePipeline) || demotedActingPrimary) {
      console.log(
        '[WebSocketHandler] New client session started; resetting playback buffer and restarting encoders...',
      );
      // Buffer-Hold Pause 中に新セッションへ切り替わった場合、バッファを消去するため Hold も解除する。
      // Hold のまま startLive() へ落ちると Video のみ restart され Audio FFmpeg が未起動のまま残る。
      if (this.pipelineHoldState === 'BUFFER_HOLD_PAUSED') {
        this.clearHoldTimers();
        this.pipelineHoldState = 'ACTIVE';
        this.browserManager.resumeFromBufferHold();
        this.encoder.resetHoldCompensation?.();
        this.broadcastControl({ type: 'BUFFER_HOLD', paused: false });
      }
      this.playbackBuffer.clear();
      this.lastKnownAckPts = null;
      if (this.encoder.isRunning()) {
        this.encoder.stop();
        this.encoder.start();
      }
    }

    this.authenticatedClients.add(socket);
    this.sendControl(socket, { type: 'AUTH_SUCCESS', token, role });
    this.onClientAuthenticated(socket, isTokenReconnect);
  }

  private evictClientSocket(socket: WebSocket, code: number, reason: string): void {
    this.allClients.delete(socket);
    this.authenticatedClients.delete(socket);

    const session = this.clientSessions.get(socket);
    if (session) {
      if (session.pacingTimer) {
        clearTimeout(session.pacingTimer);
        session.pacingTimer = null;
      }
      session.playbackQueue = [];
      this.clientSessions.delete(socket);
    }

    try {
      if (typeof (socket as any).close === 'function') {
        socket.close(code, reason);
      }
    } catch {}
  }

  private onClientAuthenticated(socket: WebSocket, isTokenReconnect = false): void {
    console.log('[WebSocketHandler] Client successfully authenticated.');
    const session = this.clientSessions.get(socket);

    // Rear-seat standby / acting-primary mode:
    // - Manual secondary login while primary is absent -> enter standby immediately.
    // - Token auto-reconnect while primary is absent ->
    //   * If previously actingPrimary and pipeline is still active (and no other actingPrimary), resume as actingPrimary.
    //   * Enter standby if previously standby OR pipeline already stopped/slept.
    //   * Otherwise, if pipeline is still active within the auto-sleep grace period (default 3 min) and secondary was streaming, resume seamlessly!
    if (session?.role === 'secondary' && !this.hasPrimaryClients()) {
      const authEntry = session.authToken
        ? this.authorizedSessions.get(session.authToken)
        : undefined;
      const isPipelineActive =
        this.browserManager.getState() === 'running' || this.encoder.isRunning();
      const canResumeActingPrimary =
        isTokenReconnect &&
        Boolean(authEntry?.actingPrimary) &&
        isPipelineActive &&
        !this.hasActingPrimaryClients();

      if (canResumeActingPrimary) {
        session.isActingPrimary = true;
        session.isStandby = false;
        this.sendControl(socket, {
          type: 'SESSION_ROLE_CHANGED',
          effectiveRole: 'acting_primary',
        });
      } else {
        const shouldEnterStandby =
          !isTokenReconnect || Boolean(authEntry?.standby) || !isPipelineActive;

        if (shouldEnterStandby) {
          console.log(
            '[WebSocketHandler] Secondary client connected in rear-seat standby mode (no primary session). Keeping browser/encoder idle.',
          );
          session.mode = 'LIVE';
          session.isStandby = true;
          session.isActingPrimary = false;
          if (authEntry) {
            authEntry.standby = true;
            authEntry.actingPrimary = false;
          }
          this.sendControl(socket, {
            type: 'PRIMARY_SESSION_STATUS',
            active: false,
          });
          if (!this.autoSleepTimer && isPipelineActive) {
            this.scheduleAutoSleep();
          }
          this.sendControl(socket, {
            type: 'BROWSER_STATUS',
            state: this.browserManager.getState(),
            url: this.browserManager.getCurrentUrl(),
            title:
              typeof this.browserManager.getCurrentTitle === 'function'
                ? this.browserManager.getCurrentTitle()
                : '',
            dimensions: this.browserManager.getDimensions(),
          });
          return;
        }
      }
    }

    if (session) {
      session.isStandby = false;
      if (session.role !== 'secondary') {
        session.isActingPrimary = false;
      }
      if (session.authToken) {
        const authEntry = this.authorizedSessions.get(session.authToken);
        if (authEntry) {
          authEntry.standby = false;
          if (session.role !== 'secondary') authEntry.actingPrimary = false;
        }
      }
    }

    if (this.isEffectivelyPrimary(session)) {
      this.clearActingPrimaryGraceTimer();
      if (this.autoSleepTimer) {
        clearTimeout(this.autoSleepTimer);
        this.autoSleepTimer = null;
      }
    }

    // Issue #111: Hold 停止中 (BUFFER_HOLD_PAUSED) のプライマリ再接続は、生成を凍結したまま
    // CATCHUP で再生位置へ追いつかせ、resumeTriggerServerMs 到達後に自動再開する。
    // セカンダリ接続では消費者が不在のまま holdExpireTimer が消えないよう解除しない。
    const holdingForReconnect =
      this.pipelineHoldState === 'BUFFER_HOLD_PAUSED' && session?.role !== 'secondary';
    if (holdingForReconnect) {
      if (this.holdExpireTimer) {
        clearTimeout(this.holdExpireTimer);
        this.holdExpireTimer = null;
      }
    }

    // If browser was paused, resume it immediately
    let encoderJustStartedOnAuth = false;
    if (!holdingForReconnect) {
      if (this.browserManager.getState() === 'paused') {
        this.browserManager.resume();
      } else if (this.browserManager.getState() === 'stopped') {
        this.browserManager.start().catch((err) => console.error('Start error:', err));
      } else if (!this.browserManager.isChromeAlive()) {
        console.warn(
          '[WebSocketHandler] Browser is marked running but Chrome is not alive. Restarting Chrome...',
        );
        this.browserManager
          .restartChrome()
          .catch((err) => console.error('Restart Chrome error:', err));
      }

      // Ensure both Video and Audio FFmpeg encoders are running if stopped during idle sleep or hold
      const wasRunning = this.encoder.isRunning();
      const wasFullyRunning =
        typeof this.encoder.isFullyRunning === 'function'
          ? this.encoder.isFullyRunning()
          : wasRunning;
      if (!wasFullyRunning) {
        console.log('[WebSocketHandler] Resuming FFmpeg encoder on client authentication...');
        this.encoder.start();
        if (!wasRunning) {
          encoderJustStartedOnAuth = true;
        }
      }
    }

    if (session?.role === 'secondary') {
      this.sendControl(socket, {
        type: 'PRIMARY_SESSION_STATUS',
        active: true,
      });
      const primarySession = this.getPrimarySession();
      const latestPts =
        typeof this.encoder.getCurrentPts === 'function'
          ? BigInt(this.encoder.getCurrentPts())
          : 0n;
      const primaryAckPts = primarySession?.lastAckPts ?? null;
      const primaryBehindUs =
        primaryAckPts !== null && primaryAckPts > 0n && latestPts > primaryAckPts
          ? latestPts - primaryAckPts
          : 0n;

      const secondaryCatchupData =
        primaryAckPts !== null && primaryAckPts > 0n && primaryBehindUs >= 300000n
          ? this.playbackBuffer.getFramesToCatchup(primaryAckPts)
          : null;

      if (secondaryCatchupData && secondaryCatchupData.frames.length > 0) {
        console.log(
          `[WebSocketHandler] Secondary joined while primary is buffered (${Math.round(Number(primaryBehindUs) / 1000)}ms behind). Syncing from primaryAckPts=${primaryAckPts}...`,
        );
        this.startCatchup(session, secondaryCatchupData);
      } else {
        session.mode = 'LIVE';
        this.startLive(socket);
      }
    } else {
      let lastAckPts = session?.lastAckPts ?? this.lastKnownAckPts;

      // Issue #111 (ack 遅延補正): 切断前の高RTT in-flight で lastAckPts が陳腐化すると、
      // backlog が holdTrigger を大幅に超えて再生開始 (または保持範囲外 → LIVE 強制 = 大幅スキップ)
      // していた。再開位置を resumeFromPts = max(lastAckPts, latestBuffered − holdTriggerMs)
      // (getFramesToCatchup により直前 KEYFRAME へスナップ) へクランプし、backlog を常に
      // holdTrigger 以下に収めてから CATCHUP を開始する。
      const holdCfgForReconnect = this.computeHoldConfig();
      if (holdCfgForReconnect && lastAckPts !== null && lastAckPts > 0n) {
        const latestBuf = this.playbackBuffer.getLatestVideoPts();
        if (latestBuf !== null) {
          const floorPts = latestBuf - BigInt(holdCfgForReconnect.holdTriggerMs) * 1000n;
          if (lastAckPts < floorPts) {
            console.log(
              `[WebSocketHandler] Reconnect ack is stale (${Math.round(Number(latestBuf - lastAckPts) / 1000)}ms behind live edge). Clamping CATCHUP resume from lastAckPts=${lastAckPts} to resumeFromPts=${floorPts} (max(lastAckPts, latestBuffered - holdTriggerMs)).`,
            );
            lastAckPts = floorPts;
          }
        }
      }

      // now - lastInputAt > IDLE_TO_BUFFER_SECONDS（既定5秒、環境変数）なら CATCHUP 許可状態
      const idleThresholdMs = (Number(process.env.IDLE_TO_BUFFER_SECONDS) || 5) * 1000;
      const isIdle = Date.now() - this.lastInputAt > idleThresholdMs;

      const catchupData =
        isIdle && lastAckPts !== null && lastAckPts > 0n
          ? this.playbackBuffer.getFramesToCatchup(lastAckPts)
          : null;

      if (catchupData && catchupData.frames.length > 0 && session) {
        // CATCHUP 許可状態での再接続: バッファから lastAckPts 以降を再生
        console.log(
          `[WebSocketHandler] Client reconnected in idle state. Starting CATCHUP playback (${catchupData.frames.length} frames from lastAckPts=${lastAckPts})...`,
        );
        this.startCatchup(session, catchupData);
      } else {
        // LIVE 状態での再接続: キーフレーム鮮度判定のうえライブ配信を開始
        if (session) {
          session.mode = 'LIVE';
        }
        let exitedHoldForLive = false;
        if (holdingForReconnect) {
          // CATCHUP に入らず LIVE 開始する場合は、ここで Hold を解除して Chrome と
          // Video/Audio 両エンコーダを再開しないと、映像永久停止または片肺無音になる。
          this.exitBufferHold('reconnect_live');
          exitedHoldForLive = true;
        }
        this.startLive(socket, {
          skipVideoRestart: exitedHoldForLive || encoderJustStartedOnAuth,
        });
      }

      // Notify only previously-standby secondary clients that primary is now active and deliver fresh keyframe if cached
      const resumedStandbyClients = this.notifySecondaryClientsPrimaryStatus(true);
      const isKeyframeStale =
        typeof this.encoder.isKeyframeStale === 'function'
          ? this.encoder.isKeyframeStale(2000000n)
          : false;
      if (this.encoder.isRunning() && !isKeyframeStale) {
        for (const client of resumedStandbyClients) {
          if (client !== socket) {
            this.sendCachedKeyframeAndConfig(client);
          }
        }
      }
    }

    // Send browser status
    this.sendControl(socket, {
      type: 'BROWSER_STATUS',
      state: this.browserManager.getState(),
      url: this.browserManager.getCurrentUrl(),
      title:
        typeof this.browserManager.getCurrentTitle === 'function'
          ? this.browserManager.getCurrentTitle()
          : '',
      dimensions: this.browserManager.getDimensions(),
    });
  }

  /**
   * Send cached SPS/PPS parameter sets (CONFIG) followed by the cached AVCC keyframe
   * to immediately initialize and display video on the client with zero copy.
   * Returns true if both cached parameter sets and keyframe were present and sent, false otherwise.
   */
  private sendCachedKeyframeAndConfig(socket: WebSocket): boolean {
    if (socket.readyState !== 1) return false;
    const cachedKeyframe = this.encoder.getCachedKeyframe();
    const cachedSpsPps = this.encoder.getCachedSpsPps();
    if (!cachedKeyframe || !cachedSpsPps) return false;

    socket.send(MessageMultiplexer.packVideo(VIDEO_FLAGS.CONFIG, 0n, cachedSpsPps));
    socket.send(
      MessageMultiplexer.packVideo(
        VIDEO_FLAGS.KEYFRAME | VIDEO_FLAGS.AVCC,
        cachedKeyframe.pts,
        cachedKeyframe.data,
      ),
    );
    return true;
  }

  /**
   * LIVE 接続・再接続処理 (キャッシュ済みキーフレームの鮮度を確認し、必要に応じて映像エンコーダを再起動してライブ配信を開始する)
   */
  private startLive(socket: WebSocket, options?: { skipVideoRestart?: boolean }): void {
    const cachedKeyframe = this.encoder.getCachedKeyframe();
    let isStale = false;
    if (cachedKeyframe) {
      if (typeof this.encoder.isKeyframeStale === 'function') {
        isStale = this.encoder.isKeyframeStale(2000000n);
      } else if (typeof this.encoder.getCurrentPts === 'function') {
        const currentPts = this.encoder.getCurrentPts();
        isStale = currentPts - cachedKeyframe.pts >= 2000000n;
      }
    } else {
      isStale = true;
    }

    if (isStale) {
      if (!options?.skipVideoRestart) {
        console.log(
          '[WebSocketHandler] Cached keyframe is stale (>= 2s). Restarting video encoder for fresh IDR keyframe...',
        );
        this.encoder.restart().catch((err) => {
          console.error('[WebSocketHandler] Failed to restart encoder on stale keyframe:', err);
        });
      }
    } else if (socket.readyState === 1) {
      const sent = this.sendCachedKeyframeAndConfig(socket);
      if (!sent && !options?.skipVideoRestart) {
        console.log(
          '[WebSocketHandler] Incomplete video cache (missing keyframe or SPS/PPS). Restarting video encoder...',
        );
        this.encoder.restart().catch((err) => {
          console.error('[WebSocketHandler] Failed to restart encoder on incomplete cache:', err);
        });
      }
    }

    const session = this.clientSessions.get(socket);
    const cachedOpusHead = this.encoder.getCachedOpusHead();
    if (this.isEffectivelyPrimary(session) && cachedOpusHead && socket.readyState === 1) {
      const packet = MessageMultiplexer.packAudio(AUDIO_FLAGS.CONFIG, 0n, cachedOpusHead);
      socket.send(packet);
    }
  }

  /**
   * クライアントの手元にある確定未再生バッファ量（ミリ秒）を取得
   *
   * 【スライディングウィンドウ・In-Flight フロー制御】:
   * - サーバー送信済み最新映像PTS (lastSentVideoPts) とクライアント再生済みPTS (lastAckPts) の差分により、
   *   ネットワーク中およびクライアント未再生バッファの合計ミリ秒数をリアルタイムに算出する。
   * - クライアントから報告された最新のローカルバッファ量 (bufferedMs) と比較し、より大きい方を採用することで、
   *   フィードバック受信直後 (bufferedMs=0) でもバースト送出がクライアント許容上限 (targetBufferMs) を
   *   突破しないよう確実に保護する (Issue #26)。
   */
  private getClientInFlightBufferMs(session: ClientSession): number {
    let ptsInFlightMs = 0;
    if (
      session.lastSentVideoPts !== null &&
      session.lastSentVideoPts !== undefined &&
      session.lastAckPts !== null &&
      session.lastAckPts !== undefined &&
      session.lastSentVideoPts > session.lastAckPts
    ) {
      ptsInFlightMs = Math.round(Number(session.lastSentVideoPts - session.lastAckPts) / 1000);
    }

    const clientReportedMs =
      typeof session.bufferedMs === 'number' && session.bufferedMs >= 0 ? session.bufferedMs : 0;
    // Issue #106: 音声キュー滞留も実滞留時間の一部。映像経路の報告だけだと音声バックログ中に
    // サーバー側の窓計算が過小評価されるため、報告された音声滞留も max() に含める。
    const clientReportedAudioMs =
      typeof session.audioBufferedMs === 'number' && session.audioBufferedMs >= 0
        ? session.audioBufferedMs
        : 0;

    return Math.max(ptsInFlightMs, clientReportedMs, clientReportedAudioMs);
  }

  /**
   * Issue #104: ACK (および BUFFER_FEEDBACK の lastRenderedPts) の進行度から、クライアントの
   * 実効排水レート（実時間に対する倍数）を EWMA で推定する。CATCHUP バーストがモバイル等の
   * 低速リンクへ自己輻輳を招く前に、窓を排水速度に見合った大きさへ縮めるための入力信号。
   */
  private observeAckProgress(session: ClientSession, newPts: bigint): void {
    const nowMs = performance.now();
    // 基準点未設定（計測開始時・LIVE ジャンプ後の再初期化時）は基準だけを置く。
    // 学習済み排水レート（EWMA）はリンク特性なので消さない
    if (session.lastAckProgressPts === undefined) {
      session.lastAckProgressPts = newPts;
      session.lastAckProgressAtMs = nowMs;
      return;
    }
    // PTS 逆行（再エンコード・再接続で 0 から再カウント）は基準点と EWMA を共に再初期化する
    if (newPts < session.lastAckProgressPts) {
      session.lastAckProgressPts = newPts;
      session.lastAckProgressAtMs = nowMs;
      session.ackDrainRateEwma = undefined;
      return;
    }
    if (session.lastAckProgressAtMs === undefined || newPts === session.lastAckProgressPts) {
      return;
    }
    const wallDeltaMs = nowMs - session.lastAckProgressAtMs;
    // 短間隔サンプルは分母が制御メッセージ粒度に律速されレートが過小評価になるため、
    // 250ms 以上の窓が溜まるまで計測しない（ACK と BUFFER_FEEDBACK の連続到着対策）
    if (wallDeltaMs < WebSocketHandler.ACK_PROGRESS_MIN_WINDOW_MS) {
      return;
    }
    // 5秒超の無通信・停止明け後の1サンプルで極小レート（例: 0.01x）が混入するのを防ぐ
    if (wallDeltaMs > WebSocketHandler.ACK_PROGRESS_MAX_WINDOW_MS) {
      session.lastAckProgressPts = newPts;
      session.lastAckProgressAtMs = nowMs;
      return;
    }
    const mediaDeltaMs = Number(newPts - session.lastAckProgressPts) / 1000;
    const rate = mediaDeltaMs / wallDeltaMs;
    if (Number.isFinite(rate) && rate >= 0 && rate <= 20) {
      session.ackDrainRateEwma =
        session.ackDrainRateEwma === undefined ? rate : session.ackDrainRateEwma * 0.7 + rate * 0.3;
    }
    session.lastAckProgressPts = newPts;
    session.lastAckProgressAtMs = nowMs;
  }

  /**
   * targetBufferMs の共通解決ロジック。スライディングウィンドウ制御と Issue #107 の診断ログで
   * 参照が食い違わないよう共通化する（再接続直後等で session.targetBufferMs が未設定でも、
   * 直前の有効値 lastKnownTargetBufferMs を基準にする）。
   */
  private getBaseTargetBufferMs(session: ClientSession): number {
    return (
      session.targetBufferMs ??
      this.lastKnownTargetBufferMs ??
      WebSocketHandler.DEFAULT_TARGET_BUFFER_MS
    );
  }

  /**
   * Issue #104: CATCHUP のスライディングウィンドウを実測排水レートへ適応させる。
   * 健全なリンク（排水レート >= 0.85x）では targetBufferMs（下限 400ms）をそのまま使用し、
   * 排水レート < 0.85x の低速リンクでは in-flight 上限を「target × レート（下限 2.5秒、target 以下）」
   * へ縮めることで、中間バッファへの過剰な詰め込み（自己輻輳）を抑制する。
   */
  private effectiveCatchupWindowMs(session: ClientSession): number {
    // Issue #111: targetBufferMs=0 (オフ) でも送出ゲート (inFlight >= window) が永久閉鎖せぬよう
    // 実効窓に 400ms の下限保護を置く。Hold 無効化 (computeHoldConfig null) とは独立の防御。
    const target = Math.max(
      WebSocketHandler.MIN_CATCHUP_WINDOW_MS,
      this.getBaseTargetBufferMs(session),
    );
    const rate = session.ackDrainRateEwma;
    if (rate === undefined || rate >= WebSocketHandler.DRAIN_RATE_CONGESTION_THRESHOLD) {
      return target;
    }
    return Math.min(target, Math.max(2500, Math.round(target * rate)));
  }

  private isCatchupLinkCongested(session: ClientSession): boolean {
    return (
      (session.catchupCongestionStreak ?? 0) >= 3 ||
      (session.ackDrainRateEwma !== undefined &&
        session.ackDrainRateEwma < WebSocketHandler.DRAIN_RATE_CONGESTION_THRESHOLD)
    );
  }

  /**
   * Issue #104: CATCHUP 時のソケット送出ガード閾値。
   * 健全時は従来どおり 128KB、ソケット滞留連続または低排水レート検知時は 32KB〜64KB へ絞り、
   * 浅いモバイルリンクの中間バッファへの詰め込み（bufferbloat）を抑制する。
   */
  private getEffectiveCatchupSocketGuardBytes(session: ClientSession): number {
    if (!this.isCatchupLinkCongested(session)) {
      return WebSocketHandler.CATCHUP_DEFAULT_SOCKET_GUARD_BYTES;
    }
    const bps = this.configStore.getConfig().stream?.bitrate || 1000000;
    return Math.max(32 * 1024, Math.min(64 * 1024, Math.round((bps / 8) * 0.25)));
  }

  /** バースト CATCHUP の有効無効（環境変数、既定有効）。 */
  private isBurstCatchupEnabled(): boolean {
    return (
      process.env.BURST_CATCHUP_ENABLED !== 'false' && process.env.BURST_CATCHUP_ENABLED !== '0'
    );
  }

  /**
   * Issue #104: CATCHUP キューのバックログ上限。先行バッファ深度の2倍（最低30秒）を超える
   * 古い GOP を安全に間引き、キャッチアップが無限に続かないことを保証しつつ、
   * Issue #26 / #56 の 25〜30 秒無欠落復旧を保護する。
   */
  private enforceCatchupBacklogCap(session: ClientSession): void {
    if (session.playbackQueue.length === 0) return;
    const nowMs = performance.now();
    if (session.lastBacklogPruneAtMs !== undefined && nowMs - session.lastBacklogPruneAtMs < 2000) {
      return;
    }
    let firstPts: bigint | null = null;
    let lastPts: bigint | null = null;
    for (const f of session.playbackQueue) {
      if (f.type !== 'video') continue;
      if (firstPts === null) firstPts = f.pts;
      lastPts = f.pts;
    }
    if (firstPts === null || lastPts === null || lastPts <= firstPts) return;
    const spanMs = Number(lastPts - firstPts) / 1000;
    const capMs = Math.max(
      2 * this.getBaseTargetBufferMs(session),
      WebSocketHandler.CATCHUP_MIN_BACKLOG_CAP_MS,
    );
    if (spanMs > capMs) {
      const before = session.playbackQueue.length;
      this.pruneSessionQueue(session);
      if (session.playbackQueue.length < before) {
        session.lastBacklogPruneAtMs = nowMs;
        console.log(
          `[WebSocketHandler] CATCHUP backlog ${Math.round(spanMs)}ms exceeds cap ${capMs}ms. Pruned oldest GOP (${before} -> ${session.playbackQueue.length} frames).`,
        );
      }
    }
  }

  /**
   * CATCHUP ペーシング送出の開始
   */
  private startCatchup(
    session: ClientSession,
    catchupData: { frames: BufferedFrame[]; configVideo?: Buffer; configAudio?: Buffer },
  ): void {
    const muteAudio = !this.isEffectivelyPrimary(session);
    session.mode = 'CATCHUP';
    session.playbackQueue = muteAudio
      ? catchupData.frames.filter((f) => f.type !== 'audio')
      : [...catchupData.frames];
    session.lastAckProgressPts = undefined;
    session.lastAckProgressAtMs = undefined;
    session.catchupCongestionStreak = 0;
    session.isBurstMode = this.isBurstCatchupEnabled();

    // Issue #107: 障害解析時にフロー制御設定を追跡できるよう、実効ウィンドウ・ソケットガード・バースト設定を出力する
    console.log(
      `[WebSocketHandler] CATCHUP pacing started (queued=${session.playbackQueue.length} frames, targetBufferMs=${this.getBaseTargetBufferMs(session)}, effectiveWindowMs=${this.effectiveCatchupWindowMs(session)}, socketGuardKB=${Math.round(this.getEffectiveCatchupSocketGuardBytes(session) / 1024)}, burst=${session.isBurstMode})`,
    );

    // キャッチアップ送出開始にあたり、基準ACKがキュー先頭キーフレームより古い、または未設定の場合は
    // キュー先頭の映像PTS（フォールバックとして先頭フレームPTS）でアンカーを初期化し、正確なIn-Flightウィンドウ計算を保証する (Issue #26)
    const firstVideoPts =
      session.playbackQueue.find((f) => f.type === 'video')?.pts ?? session.playbackQueue[0]?.pts;
    if (
      session.lastAckPts === null ||
      (firstVideoPts !== undefined && firstVideoPts > session.lastAckPts)
    ) {
      session.lastAckPts = firstVideoPts ?? session.lastAckPts;
    }
    session.lastSentVideoPts = session.lastAckPts;
    session.isFlowPaused = false;

    // クライアントの VideoDecoder / AudioPlayer を確実に初期化するための CONFIG パケットを送出
    if (catchupData.configVideo && session.socket.readyState === 1) {
      session.socket.send(
        MessageMultiplexer.packVideo(VIDEO_FLAGS.CONFIG, 0n, catchupData.configVideo),
      );
    }
    if (!muteAudio && catchupData.configAudio && session.socket.readyState === 1) {
      session.socket.send(
        MessageMultiplexer.packAudio(AUDIO_FLAGS.CONFIG, 0n, catchupData.configAudio),
      );
    }

    // ペーシングループ開始 (バーストまたは1x)
    this.scheduleNextCatchupFrame(session);
  }

  /**
   * サーバー側キューが長くなりすぎた場合、最古のGOPを安全に間引いてメモリを保護
   */
  private pruneSessionQueue(session: ClientSession): void {
    let nextKeyframeIdx = -1;
    for (let i = 1; i < session.playbackQueue.length; i++) {
      const f = session.playbackQueue[i];
      if (f.type === 'video' && (f.flags & VIDEO_FLAGS.KEYFRAME) !== 0) {
        nextKeyframeIdx = i;
        break;
      }
    }
    if (nextKeyframeIdx > 0) {
      session.playbackQueue = session.playbackQueue.slice(nextKeyframeIdx);
    }
  }

  /**
   * クライアントのバッファ消費（再生進捗）に応じてCATCHUP送出を安全に再開
   */
  private checkAndResumeCatchup(session: ClientSession): void {
    if (session.mode !== 'CATCHUP' || session.isStandby || session.socket.readyState !== 1) {
      return;
    }
    // Issue #104: ソケット滞留でペーシングが停止している間もフレームはキューへ蓄積され続けるため、
    // 再開判定のたびにバックログ上限を監視する（完全ストール時の無限成長防止。内部 2 秒スロットル）
    this.enforceCatchupBacklogCap(session);
    if (session.playbackQueue.length === 0) {
      console.log(
        '[WebSocketHandler] CATCHUP playback queue empty on resume check. Transitioning to LIVE mode.',
      );
      session.mode = 'LIVE';
      session.isFlowPaused = false;
      session.catchupCongestionStreak = 0;
      return;
    }
    if (session.pacingTimer) {
      return;
    }

    // ソケットの詰まり確認: 送信バッファに溜まっている間は通信悪化継続中なので送出しない
    const socketBuffered = (session.socket as any).bufferedAmount || 0;
    const socketGuardBytes = this.getEffectiveCatchupSocketGuardBytes(session);
    if (socketBuffered > socketGuardBytes) {
      session.catchupCongestionStreak = Math.min(20, (session.catchupCongestionStreak ?? 0) + 1);
      session.isFlowPaused = true;
      session.pacingTimer = setTimeout(() => {
        session.pacingTimer = null;
        this.checkAndResumeCatchup(session);
      }, 50);
      return;
    }

    const targetBufferMs = this.effectiveCatchupWindowMs(session);
    const inFlightMs = this.getClientInFlightBufferMs(session);

    if (inFlightMs < targetBufferMs) {
      session.isFlowPaused = false;
      this.scheduleNextCatchupFrame(session);
    } else {
      session.isFlowPaused = true;
      session.pacingTimer = setTimeout(() => {
        session.pacingTimer = null;
        this.checkAndResumeCatchup(session);
      }, 50);
    }
  }

  /**
   * バーストまたは等速 (1x) ペーシングによる順次送出（スライディングウィンドウ・フロー制御付き）
   */
  private scheduleNextCatchupFrame(session: ClientSession): void {
    if (session.mode !== 'CATCHUP' || session.isStandby || session.socket.readyState !== 1) {
      return;
    }

    if (session.playbackQueue.length === 0) {
      console.log('[WebSocketHandler] CATCHUP playback queue empty. Transitioning to LIVE mode.');
      session.mode = 'LIVE';
      session.isFlowPaused = false;
      session.catchupCongestionStreak = 0;
      return;
    }

    // Issue #104: バックログが上限を超えた古い GOP を安全に間引き、無限キャッチアップを防ぐ
    this.enforceCatchupBacklogCap(session);

    // ソケットの詰まり確認: 送信バッファに溜まっている間は送出を控える
    const socketBuffered = (session.socket as any).bufferedAmount || 0;
    const socketGuardBytes = this.getEffectiveCatchupSocketGuardBytes(session);
    if (socketBuffered > socketGuardBytes) {
      session.catchupCongestionStreak = Math.min(20, (session.catchupCongestionStreak ?? 0) + 1);
      session.isFlowPaused = true;
      if (!session.pacingTimer) {
        session.pacingTimer = setTimeout(() => {
          session.pacingTimer = null;
          this.checkAndResumeCatchup(session);
        }, 50);
      }
      return;
    }
    if (socketBuffered <= socketGuardBytes / 2 && (session.catchupCongestionStreak ?? 0) > 0) {
      session.catchupCongestionStreak = Math.max(0, (session.catchupCongestionStreak ?? 0) - 1);
    }

    // クライアント先行バッファ上限チェック（スライディングウィンドウ・フロー制御）
    // 実効スライディングウィンドウ (effectiveCatchupWindowMs、既定10秒) を超えて送信しないよう、満杯時は一時停止する
    const targetBufferMs = this.effectiveCatchupWindowMs(session);
    const inFlightMs = this.getClientInFlightBufferMs(session);

    if (inFlightMs >= targetBufferMs) {
      session.isFlowPaused = true;
      if (!session.pacingTimer) {
        session.pacingTimer = setTimeout(() => {
          session.pacingTimer = null;
          this.checkAndResumeCatchup(session);
        }, 50);
      }
      return;
    }

    session.isFlowPaused = false;

    // In burst mode, deliver frames with minimal interval (e.g. 2ms on healthy links, relaxed to 10ms when congested)
    // so 10s of buffer pre-fills rapidly without flooding shallow mobile buffers.
    const frame = session.playbackQueue.shift()!;
    if (
      frame.type === 'video' ||
      session.lastSentVideoPts === null ||
      session.lastSentVideoPts === undefined
    ) {
      if (
        session.lastSentVideoPts === null ||
        session.lastSentVideoPts === undefined ||
        frame.pts > session.lastSentVideoPts
      ) {
        session.lastSentVideoPts = frame.pts;
      }
    }

    const packet =
      frame.type === 'video'
        ? MessageMultiplexer.packVideo(frame.flags, frame.pts, frame.data)
        : MessageMultiplexer.packAudio(frame.flags, frame.pts, frame.data);

    session.socket.send(packet);

    if (session.playbackQueue.length === 0) {
      console.log(
        '[WebSocketHandler] CATCHUP playback finished after sending last frame. Transitioning to LIVE mode.',
      );
      session.mode = 'LIVE';
      session.isFlowPaused = false;
      session.catchupCongestionStreak = 0;
      return;
    }

    let delayMs = session.isBurstMode ? (this.isCatchupLinkCongested(session) ? 10 : 2) : 4;
    if (!session.isBurstMode) {
      const nextFrame = session.playbackQueue[0];
      let deltaUs = nextFrame.pts - frame.pts;
      if (deltaUs < 0n) deltaUs = 0n;
      if (deltaUs > 100000n) deltaUs = 33000n;
      delayMs = Math.max(0, Math.round(Number(deltaUs) / 1000));
    }

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

  private handleResizeMessage(buf: Buffer, socket?: WebSocket): void {
    if (socket) {
      const session = this.clientSessions.get(socket);
      if (session?.role === 'secondary' && !session.isActingPrimary) {
        console.log('[WebSocketHandler] Ignoring RESIZE from secondary display session.');
        return;
      }
    }
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

    const configuredMaxSize = this.configStore.getConfig().stream?.maxSize ?? 1280;
    const maxSize = Math.max(640, Math.min(1920, configuredMaxSize));
    const maxDim = Math.max(effW, effH);
    if (maxDim > maxSize) {
      const scale = maxSize / maxDim;
      effW = Math.round(effW * scale);
      effH = Math.round(effH * scale);
    }

    const width = Math.max(640, Math.min(maxSize, effW)) & ~7;
    const height = Math.max(360, Math.min(Math.min(1080, maxSize), effH)) & ~1;

    // Issue #11: クライアント負荷プロファイルによるエンコード寸法 (レイアウト寸法は変更しない)
    const resolvedProfile = resolveClientProfile(this.configStore.getConfig().stream);
    const encodeDims = computeEncodeDimensions(width, height, resolvedProfile.resolutionScale);
    const encodeW = encodeDims ? encodeDims.width : width;
    const encodeH = encodeDims ? encodeDims.height : height;

    if (
      width === this.currentResWidth &&
      height === this.currentResHeight &&
      encodeW === this.currentEncodeWidth &&
      encodeH === this.currentEncodeHeight
    ) {
      return;
    }

    console.log(
      `[WebSocketHandler] Client requested resize: ${requestedW}x${requestedH} (dpr=${dpr.toFixed(2)}) -> effective ${width}x${height} (encode ${encodeW}x${encodeH})`,
    );

    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
    }

    this.resizeTimer = setTimeout(async () => {
      try {
        // デバウンス待機中にプロファイル変更があった場合へ備え、
        // タイマー発火時点で実効スケールからエンコード寸法を再計算する
        const liveProfile = resolveClientProfile(this.configStore.getConfig().stream);
        const liveEncodeDims = computeEncodeDimensions(width, height, liveProfile.resolutionScale);
        const liveEncodeW = liveEncodeDims ? liveEncodeDims.width : width;
        const liveEncodeH = liveEncodeDims ? liveEncodeDims.height : height;
        console.log(`[WebSocketHandler] Executing dynamic server resize to ${width}x${height}...`);
        // 解像度変更時はバッファを全消去する
        this.playbackBuffer.clear();
        for (const session of this.clientSessions.values()) {
          if (session.mode === 'CATCHUP') {
            this.abortCatchupAndSwitchToLive(session);
          }
        }

        await this.browserManager.resize(width, height);
        if (liveEncodeDims) {
          await this.encoder.restart(
            width,
            height,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            liveEncodeDims,
          );
        } else {
          // エンコード縮小なし (scale 1.0) の場合は通常リスタートのみ実行する
          await this.encoder.restart(width, height);
        }
        this.inputManager.updateDimensions(width, height);
        this.currentResWidth = width;
        this.currentResHeight = height;
        this.currentEncodeWidth = liveEncodeW;
        this.currentEncodeHeight = liveEncodeH;

        this.broadcastControl({
          type: 'RESOLUTION_CHANGED',
          width: liveEncodeW,
          height: liveEncodeH,
        });
        console.log(
          `[WebSocketHandler] Server successfully resized to ${width}x${height} (encode ${liveEncodeW}x${liveEncodeH})`,
        );
      } catch (err) {
        console.error('[WebSocketHandler] Failed to apply resize:', err);
      }
    }, 400);
  }

  /**
   * Issue #11: クライアント負荷プロファイル変更時に設定ルートから呼ばれる。
   * レイアウト (リモートビューポート) 寸法は変えず、エンコード出力寸法のみを再計算して適用する。
   * streamUpdate を渡した場合は、ビットレート・FPS 等の連動変更を新しいエンコード寸法と
   * 単一の updateConfig 再起動へ統合して二重再起動を防ぐ。
   */
  public async reapplyClientProfile(streamUpdate?: {
    fps?: number;
    bitrate?: string | number;
    audioBitrate?: string | number;
    compressionLevel?: number;
    lowPower?: boolean;
    gpuColorConversion?: boolean;
    x264Preset?: string;
  }): Promise<void> {
    const layoutW = this.currentResWidth;
    const layoutH = this.currentResHeight;
    const resolvedProfile = resolveClientProfile(this.configStore.getConfig().stream);
    const encodeDims = computeEncodeDimensions(layoutW, layoutH, resolvedProfile.resolutionScale);
    const encodeW = encodeDims ? encodeDims.width : layoutW;
    const encodeH = encodeDims ? encodeDims.height : layoutH;
    const encodeDimsChanged =
      encodeW !== this.currentEncodeWidth || encodeH !== this.currentEncodeHeight;
    if (!encodeDimsChanged && !streamUpdate) {
      return;
    }
    if (encodeDimsChanged) {
      console.log(
        `[WebSocketHandler] Re-applying client load profile: encode ${this.currentEncodeWidth}x${this.currentEncodeHeight} -> ${encodeW}x${encodeH} (layout ${layoutW}x${layoutH} unchanged)`,
      );
      this.playbackBuffer.clear();
      for (const session of this.clientSessions.values()) {
        if (session.mode === 'CATCHUP') {
          this.abortCatchupAndSwitchToLive(session);
        }
      }
    }
    if (streamUpdate) {
      // 寸法変更の有無に関わらず、連動変更と寸法適用は updateConfig の 1 回に統合する
      await this.encoder.updateConfig({
        ...streamUpdate,
        ...(encodeDimsChanged ? { encodeDimensions: encodeDims } : {}),
      });
    } else {
      await this.encoder.setEncodeDimensions(encodeDims);
    }
    this.currentEncodeWidth = encodeW;
    this.currentEncodeHeight = encodeH;
    if (encodeDimsChanged) {
      this.broadcastControl({
        type: 'RESOLUTION_CHANGED',
        width: encodeW,
        height: encodeH,
      });
    }
  }

  /**
   * Issue #11: サーバー起動時に保存済みクライアント負荷プロファイルを実際のエンコード寸法へ適用する。
   * これにより lightweight 設定のコンテナで、最初の RESIZE 受信前も縮小エンコードが維持される。
   * (後の RESIZE は currentEncode* との比較で冪等にスキップされる)
   */
  public async syncEncodeDimensionsFromConfig(): Promise<void> {
    const dims = this.browserManager.getDimensions();
    const resolvedProfile = resolveClientProfile(this.configStore.getConfig().stream);
    const encodeDims = computeEncodeDimensions(
      dims.width,
      dims.height,
      resolvedProfile.resolutionScale,
    );
    if (!encodeDims) {
      return;
    }
    console.log(
      `[WebSocketHandler] Applying saved client load profile at startup: encode ${encodeDims.width}x${encodeDims.height} (layout ${dims.width}x${dims.height})`,
    );
    this.currentEncodeWidth = encodeDims.width;
    this.currentEncodeHeight = encodeDims.height;
    await this.encoder.setEncodeDimensions(encodeDims);
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

  private static readonly MAX_TELEMETRY_PAYLOAD_BYTES = 512 * 1024;

  private handleTelemetryMessage(session: ClientSession, buf: Buffer): void {
    if (buf.length <= 1) return;
    if (buf.length > WebSocketHandler.MAX_TELEMETRY_PAYLOAD_BYTES) {
      console.warn(
        `[WebSocketHandler] Dropping oversized telemetry payload (${buf.length} bytes > ${WebSocketHandler.MAX_TELEMETRY_PAYLOAD_BYTES}).`,
      );
      return;
    }

    try {
      const jsonStr = buf.subarray(1).toString('utf-8');
      const events = JSON.parse(jsonStr);
      if (Array.isArray(events) && events.length > 0) {
        const telemetryManager = TelemetryManager.getInstance();
        if (!session.telemetrySessionId) {
          session.telemetrySessionId = telemetryManager.createSessionId();
        }
        telemetryManager.appendEvents(session.telemetrySessionId, events).catch((err) => {
          console.warn('[WebSocketHandler] Error saving telemetry events:', err);
        });
      }
    } catch (err) {
      console.warn('[WebSocketHandler] Failed to parse telemetry message:', err);
    }
  }

  private async handleCommandMessage(socket: WebSocket, buf: Buffer): Promise<void> {
    try {
      const jsonStr = buf.subarray(1).toString('utf-8');
      const cmd = JSON.parse(jsonStr);

      switch (cmd.type) {
        // ACK プロトコル (デコード済み video PTS)
        case 'ACK': {
          if (cmd.pts !== undefined && cmd.pts !== null) {
            const ackPts = BigInt(Math.round(Number(cmd.pts)));
            const session = this.clientSessions.get(socket);
            if (session) {
              session.lastAckPts = ackPts;
              this.observeAckProgress(session, ackPts); // Issue #104: 実効排水レートの推定入力
              if (session.isFlowPaused) {
                this.checkAndResumeCatchup(session);
              }
            }
            if (this.isEffectivelyPrimary(session)) {
              this.lastKnownAckPts = ackPts;
            }
          }
          return; // ACK はバックグラウンド同期であり、ユーザー入力アクティビティではない
        }

        case 'BUFFER_FEEDBACK': {
          const session = this.clientSessions.get(socket);
          if (session) {
            session.bufferedMs =
              typeof cmd.bufferedMs === 'number' && Number.isFinite(cmd.bufferedMs)
                ? Math.max(0, cmd.bufferedMs)
                : 0;
            // Issue #106: 音声キュー滞留の報告（旧クライアントは未送信 → 0 として扱い窓計算へ寄与しない = 従来動作）
            session.audioBufferedMs =
              typeof cmd.audioBufferedMs === 'number' && Number.isFinite(cmd.audioBufferedMs)
                ? Math.max(0, cmd.audioBufferedMs)
                : 0;
            const rawTargetMs =
              typeof cmd.targetBufferMs === 'number' && Number.isFinite(cmd.targetBufferMs)
                ? Math.round(cmd.targetBufferMs)
                : WebSocketHandler.DEFAULT_TARGET_BUFFER_MS;
            session.targetBufferMs = Math.max(
              0,
              Math.min(WebSocketHandler.MAX_TARGET_BUFFER_MS, rawTargetMs),
            );
            if (this.isEffectivelyPrimary(session)) {
              this.lastKnownTargetBufferMs =
                session.targetBufferMs ?? WebSocketHandler.DEFAULT_TARGET_BUFFER_MS;
            }
            session.isInteractive = Boolean(cmd.isInteractive);
            session.lastBufferFeedbackAt = Date.now();
            if (cmd.lastRenderedPts !== undefined && cmd.lastRenderedPts !== null) {
              const renderedPts = BigInt(Math.round(Number(cmd.lastRenderedPts)));
              if (renderedPts > 0n) {
                session.lastAckPts = renderedPts;
                this.observeAckProgress(session, renderedPts); // Issue #104: 実効排水レートの推定入力
                if (this.isEffectivelyPrimary(session)) {
                  this.lastKnownAckPts = renderedPts;
                }
              }
            }

            // If client is in interactive mode, abort any pending catchup queue immediately
            if (session.isInteractive && session.mode === 'CATCHUP') {
              this.abortCatchupAndSwitchToLive(session);
              this.sendLiveJumped(socket);
            } else if (session.mode === 'CATCHUP') {
              this.checkAndResumeCatchup(session);
            }
          }
          return;
        }

        case 'PING': {
          const session = this.clientSessions.get(socket);
          const latestPts =
            typeof this.encoder.getCurrentPts === 'function'
              ? Number(this.encoder.getCurrentPts())
              : 0;
          // 1. サーバー側送出待ちキューの長さ (ms)
          let catchupQueueMs = 0;
          if (session && session.playbackQueue.length > 0) {
            let firstPts: bigint | null = null;
            let lastPts: bigint | null = null;
            for (const f of session.playbackQueue) {
              if (f.type === 'video') {
                if (firstPts === null) firstPts = f.pts;
                lastPts = f.pts;
              }
            }
            if (firstPts !== null && lastPts !== null && lastPts > firstPts) {
              catchupQueueMs = Math.round(Number(lastPts - firstPts) / 1000);
            } else {
              catchupQueueMs = Math.round((session.playbackQueue.length * 1000) / 30);
            }
          }

          // 2. サーバー最新PTSとクライアント描画PTSとの遅延差分
          let serverLagMs = 0;
          const lastAck = session?.lastAckPts ?? this.lastKnownAckPts;
          if (lastAck !== null && latestPts > Number(lastAck)) {
            serverLagMs = Math.round((latestPts - Number(lastAck)) / 1000);
          }

          // 3. クライアント未達のサーバー側保持バッファ時間 (ms: 全体遅延からクライアント手元バッファを除いた残余)
          const clientBufferedMs = session?.bufferedMs ?? 0;
          const serverRemainingMs = Math.max(0, serverLagMs - clientBufferedMs);

          // 物理送出キューと未達残余バッファの大きい方を serverBufferMs とする
          const serverBufferMs = Math.max(catchupQueueMs, serverRemainingMs);

          const primarySession =
            session?.role === 'secondary' && !session.isActingPrimary
              ? this.getPrimarySession()
              : undefined;
          const primaryRenderedPts =
            primarySession?.lastAckPts !== null &&
            primarySession?.lastAckPts !== undefined &&
            primarySession.lastAckPts > 0n
              ? Number(primarySession.lastAckPts)
              : null;
          const primaryFeedbackAgeMs =
            primarySession?.lastBufferFeedbackAt !== undefined
              ? Math.max(0, Date.now() - primarySession.lastBufferFeedbackAt)
              : null;

          socket.send(
            MessageMultiplexer.packControl({
              type: 'PONG',
              id: cmd.id,
              clientTime: cmd.clientTime,
              serverTime: performance.now(),
              latestPts,
              serverMode: session?.mode || 'LIVE',
              catchupQueueMs,
              serverBufferMs,
              serverLagMs,
              // Issue #111: HUD の HOLD バッジ表示用 (旧クライアントは未読で無害)
              holdPaused: this.pipelineHoldState === 'BUFFER_HOLD_PAUSED',
              ...(session?.role === 'secondary' && !session.isActingPrimary
                ? primarySession
                  ? {
                      primaryRenderedPts,
                      primaryFeedbackAgeMs,
                      primaryTargetBufferMs:
                        primarySession.targetBufferMs ?? WebSocketHandler.DEFAULT_TARGET_BUFFER_MS,
                      primaryMode: primarySession.mode,
                    }
                  : {
                      primaryRenderedPts: null,
                      primaryFeedbackAgeMs: null,
                    }
                : {}),
            }),
          );
          break;
        }

        case 'JUMP_TO_LIVE': {
          if (this.clientSessions.get(socket)?.isStandby) {
            break;
          }
          const wasHolding = this.pipelineHoldState === 'BUFFER_HOLD_PAUSED';
          // Issue #111: Hold 中に LIVE ジャンプされた場合は即座に Hold を解除し、エンコードを再開する。
          this.exitBufferHold('jump_to_live');
          // Issue #103: recordInputActivity(socket) を呼ぶと CATCHUP 中に abortCatchupAndSwitchToLive と
          // notifyOtherSessionsLiveJump が二重実行されるため、入力時刻のみ更新して下の単一経路に集約する
          this.lastInputAt = Date.now();
          const session = this.clientSessions.get(socket);
          if (session) {
            // Issue #104: クライアント側の LIVE ジャンプでも再生 PTS が一気に進むため、
            // 排水レート推定の基準点だけ再初期化する（LIVE 滞在時のジャンプも対象）
            session.lastAckProgressPts = undefined;
            session.lastAckProgressAtMs = undefined;
            const needsStreamResync =
              session.mode === 'CATCHUP' || Boolean((socket as any)._droppingGop);
            console.log(
              '[WebSocketHandler] Explicit JUMP_TO_LIVE requested by client. Switching immediately to LIVE.',
            );
            if (needsStreamResync) {
              // Hold 解除直後は exitBufferHold() が直前に encoder.start() を呼んでいるため、
              // 起動直後の Video FFmpeg を stale 判定で即殺して二重起動するのを防ぐ。
              this.abortCatchupAndSwitchToLive(session, { skipEncoderRestart: wasHolding });
            } else {
              // 既に正常な LIVE セッションで JUMP_TO_LIVE を受けた場合、過去キーフレーム再送や
              // Video FFmpeg の強制再起動を行うと画面の瞬間巻き戻り・FPS 急落の原因になる (Issue #112)。
              // エンコーダ稼働のみ保証し、ストリームを途切れさせずに LIVE 同期を完了する。
              if (session.pacingTimer) {
                clearTimeout(session.pacingTimer);
                session.pacingTimer = null;
              }
              session.playbackQueue = [];
              session.isFlowPaused = false;
              this.ensureEncoderRunning();
            }
            this.notifyOtherSessionsLiveJump(socket);
          }
          // Issue #103: 破棄基準となる確定ライブエッジ PTS をクライアントへ返し、
          // 経路上に滞留している古い音声（straggler）を受信側で確実に破棄できるようにする
          this.sendLiveJumped(socket);
          break;
        }

        case 'FORCE_VIDEO_IDR': {
          // Issue #115: クライアント検知 (音声先行 ≥800ms 持続) 起点で、ライブエッジでの
          // 新規 IDR を要求する。セッション再接続でしか消えなかった pre-decode / in-flight
          // 滞留を、音声完全不変の映像のみクローズド再起動 (resize と同一の実証済み経路)
          // で自動解消する。
          if (this.clientSessions.get(socket)?.isStandby) {
            break;
          }
          const session = this.clientSessions.get(socket);
          if (!session) {
            break;
          }
          if (this.pipelineHoldState === 'BUFFER_HOLD_PAUSED') {
            // Hold 解除自体が FFmpeg 両系統の新規起動 (= ライブエッジ IDR + 音声境界ゲート)
            // を伴うため、重ねて再起動はしない。
            this.exitBufferHold('force_video_idr');
            break;
          }
          const forcedNowMs = Date.now();
          if (forcedNowMs - this.lastForcedVideoIdrAtMs < WebSocketHandler.FORCED_IDR_COOLDOWN_MS) {
            break;
          }
          this.lastForcedVideoIdrAtMs = forcedNowMs;
          console.log(
            '[WebSocketHandler] FORCE_VIDEO_IDR (Issue #115): sustained audio lead detected. Restarting video encoder only with a fresh IDR at the live edge (audio process untouched)...',
          );
          if (session.pacingTimer) {
            clearTimeout(session.pacingTimer);
            session.pacingTimer = null;
          }
          session.playbackQueue = [];
          session.isFlowPaused = false;
          // 新 IDR より古い音声 straggler をサーバー側で破棄 (Hold 復帰と同じ保護機構)
          this.encoder.armResumeGate(WebSocketHandler.RESUME_GATE_MS);
          await this.encoder.restart();
          break;
        }

        case 'RESTART_ENCODER':
        case 'CLEAN_RESTART_STREAM': {
          if (this.clientSessions.get(socket)?.isStandby) {
            break;
          }
          this.recordInputActivity(socket);
          await this.restartStream();
          break;
        }

        case 'SET_ZOOM': {
          if (this.clientSessions.get(socket)?.isStandby) {
            break;
          }
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

        case 'NAVIGATE': {
          if (this.clientSessions.get(socket)?.isStandby) {
            break;
          }
          this.recordInputActivity(socket);
          const rawUrl = typeof cmd.url === 'string' ? cmd.url.trim() : '';
          if (!rawUrl || !isSafeHttpUrl(rawUrl)) {
            this.sendControl(socket, {
              type: 'ERROR',
              message: 'Invalid URL: Only http:// and https:// URLs are permitted.',
            });
            break;
          }
          // ページ移動・再ナビゲーション時はバッファ消去＋LIVE 復帰
          this.playbackBuffer.clear();
          for (const s of this.clientSessions.values()) {
            if (s.mode === 'CATCHUP') {
              this.abortCatchupAndSwitchToLive(s);
            }
          }
          await this.browserManager.navigate(rawUrl);
          this.broadcastControl({
            type: 'BROWSER_STATUS',
            url: rawUrl,
            title:
              typeof this.browserManager.getCurrentTitle === 'function'
                ? this.browserManager.getCurrentTitle()
                : '',
            state: this.browserManager.getState(),
            dimensions: this.browserManager.getDimensions(),
          });
          break;
        }

        case 'NAVIGATE_BACK':
          if (this.clientSessions.get(socket)?.isStandby) {
            break;
          }
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
          if (this.clientSessions.get(socket)?.isStandby) {
            break;
          }
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
          if (this.clientSessions.get(socket)?.isStandby) {
            break;
          }
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
          if (this.clientSessions.get(socket)?.isStandby) {
            break;
          }
          this.recordInputActivity(socket);
          this.inputManager.toggleVideoFullscreen();
          break;

        case 'KEY':
        case 'SEND_KEY':
          if (this.clientSessions.get(socket)?.isStandby) {
            break;
          }
          this.recordInputActivity(socket);
          if (cmd.key) {
            this.inputManager.sendKey(cmd.key);
          }
          break;

        case 'TYPE_TEXT':
          if (this.clientSessions.get(socket)?.isStandby) {
            break;
          }
          this.recordInputActivity(socket);
          if (cmd.text) {
            if (typeof this.inputManager.insertText === 'function') {
              this.inputManager.insertText(cmd.text);
              if (cmd.enter === true) {
                this.inputManager.sendKey('Enter');
              }
            } else if (typeof (this.browserManager as any).typeText === 'function') {
              await this.browserManager.typeText(cmd.text, cmd.enter === true);
            }
          }
          break;

        case 'PAUSE_BROWSER':
          if (this.clientSessions.get(socket)?.isStandby) {
            break;
          }
          // Issue #111: 手動停止は Hold をスリープへ排他変換する。recordInputActivity() を呼ぶと
          // CATCHUP セッションに対して非同期 encoder.restart() が発火し直後の encoder.stop() と
          // 競合する恐れがあるため、入力時刻更新と CATCHUP キュー破棄 (skipEncoderRestart) のみ行う。
          this.convertHoldToSleep('manual_pause');
          this.lastInputAt = Date.now();
          for (const s of this.clientSessions.values()) {
            if (s.mode === 'CATCHUP') {
              this.abortCatchupAndSwitchToLive(s, { skipEncoderRestart: true });
            }
          }
          this.encoder.stop();
          this.browserManager.pause();
          this.broadcastControl({ type: 'BROWSER_STATUS', state: 'paused' });
          break;

        case 'DISCONNECT_SESSION': {
          const session = this.clientSessions.get(socket);
          if (session) {
            session.intentionalDisconnect = true;
          }
          break;
        }

        case 'RESUME_BROWSER':
          if (
            this.clientSessions.get(socket)?.isStandby ||
            (this.clientSessions.get(socket)?.role === 'secondary' &&
              !this.clientSessions.get(socket)?.isActingPrimary &&
              !this.hasPrimaryClients())
          ) {
            break;
          }
          this.recordInputActivity(socket);
          this.browserManager.resume();
          this.ensureEncoderRunning();
          this.broadcastControl({ type: 'BROWSER_STATUS', state: 'running' });
          break;

        case 'RESTART_BROWSER':
          if (this.clientSessions.get(socket)?.isStandby) {
            break;
          }
          this.recordInputActivity(socket);
          this.playbackBuffer.clear();
          for (const s of this.clientSessions.values()) {
            if (s.mode === 'CATCHUP') {
              this.abortCatchupAndSwitchToLive(s);
            }
          }
          await this.browserManager.restartChrome();
          this.ensureEncoderRunning();
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
    this.encoder.on(
      'video',
      ({ flags, pts, data }: { flags: number; pts: bigint; data: Buffer }) => {
        // 'video' イベント時にバッファへ追記
        this.playbackBuffer.addVideo(flags, pts, data);

        // Issue #111: 生成が続く限り、切断中の蓄積や CATCHUP 滞留による Buffer-Hold 発動条件を評価する。
        // Hold 発動後は FFmpeg が停止するためこのフック自体も停止し、再開判定は
        // holdResumePollTimer (消費=ack 進捗) が担う。
        this.evaluateBufferHold();

        if (this.authenticatedClients.size === 0) return;

        const packet = MessageMultiplexer.packVideo(flags, pts, data);
        this.videoFramesSent++;
        this.videoBytesSent += packet.length;

        const isKeyframe = (flags & VIDEO_FLAGS.KEYFRAME) !== 0;
        const bps = this.configStore.getConfig().stream?.bitrate || 1000000;
        // Hysteresis backpressure watermarks: must be large enough (512KB-1536KB) so a 60KB IDR keyframe
        // never triggers false GOP dropping on mobile LTE connections!
        const HIGH_WATER_MARK = Math.max(
          512 * 1024,
          Math.min(1536 * 1024, Math.round((bps / 8) * 3.0)),
        );
        const LOW_WATER_MARK = Math.max(96 * 1024, Math.round(HIGH_WATER_MARK * 0.2));

        for (const client of this.authenticatedClients) {
          if (client.readyState === 1) {
            // OPEN
            const session = this.clientSessions.get(client);
            if (!session || session.isStandby) continue;

            const buffered = (client as any).bufferedAmount || 0;

            // 1. CATCHUP クライアント: キュー末尾へ追記（追いつくまでバッファ優先）
            if (session.mode === 'CATCHUP') {
              session.playbackQueue.push({ type: 'video', flags, pts, data });
              if (session.playbackQueue.length > WebSocketHandler.MAX_CATCHUP_QUEUE_FRAMES) {
                this.pruneSessionQueue(session);
              }
              this.checkAndResumeCatchup(session);
              continue;
            }

            // 2. LIVE 送信（ヒステリシスバックプレッシャー）:
            // Issue #109: 従来はここでアイドル視聴中のソケット詰まり (buffered > 512KB) を検知すると
            // CATCHUP へ切り替えフレームを蓄積していたが、クライアントのジッターバッファが
            // targetBufferMs で満杯の状態で CATCHUP 化すると送出ゲート
            // (inFlight < effectiveCatchupWindowMs) が閉じたままとなり、backlog が永久に排水されない
            // (通信回復後も配信遅延・A/Vオフセットが恒久化する)。リアルタイム配信ではリンクが生成速度を
            // 運べずクライアントバッファも満杯なら余剰フレームはいずれどこかで必ず破棄されるため、
            // 破棄はヒステリシススキップへ一元化し、通信回復時に即時復帰させる。
            // CATCHUP キューは再接続や追っかけ再開時 (上記 1. の経路) のみで使用する。
            if (buffered > HIGH_WATER_MARK) {
              (client as any)._droppingGop = true;
            }

            if ((client as any)._droppingGop) {
              if (!isKeyframe || buffered > LOW_WATER_MARK) {
                continue;
              }
              (client as any)._droppingGop = false;
            }

            session.lastSentVideoPts = pts;
            client.send(packet);
          }
        }
      },
    );

    // Audio packet from FFmpeg
    this.encoder.on(
      'audio',
      ({ flags, pts, data }: { flags: number; pts: bigint; data: Buffer }) => {
        // 'audio' イベント時にバッファへ追記
        this.playbackBuffer.addAudio(flags, pts, data);

        if (this.authenticatedClients.size === 0) return;

        const packet = MessageMultiplexer.packAudio(flags, pts, data);
        this.audioPacketsSent++;

        for (const client of this.authenticatedClients) {
          if (client.readyState === 1) {
            // OPEN
            const session = this.clientSessions.get(client);
            if (!session || session.isStandby || !this.isEffectivelyPrimary(session)) continue;

            // 1. CATCHUP クライアント: 映像と同様にキューへ格納
            if (session.mode === 'CATCHUP') {
              session.playbackQueue.push({ type: 'audio', flags, pts, data });
              continue;
            }

            // 2. LIVE クライアント: リアルタイム送信 (GOP ドロップ対象外とし、ソケット滞留 2MB 以下なら送出・超過時のみ破棄)
            const buffered = (client as any).bufferedAmount || 0;
            if (buffered <= 2 * 1024 * 1024) {
              client.send(packet);
            }
          }
        }
      },
    );
  }

  /**
   * Issue #111: Buffer-Hold Pause の動的閾値算出。
   * holdTriggerMs = clamp(targetBufferMs, 10s, 30s)、target=0 は Hold 無効 (null)。
   * resumeTriggerServerMs = target >= HEADROOM ? 500ms : max(1000, HEADROOM − target) で、
   * 設計不変条件 holdTrigger − resume ≥ 7.2s を機械的に保証する。
   */
  private computeHoldConfig(): { holdTriggerMs: number; resumeTriggerServerMs: number } | null {
    const target = this.lastKnownTargetBufferMs ?? WebSocketHandler.DEFAULT_TARGET_BUFFER_MS;
    if (!(target > 0)) return null;
    const holdTriggerMs = Math.min(
      WebSocketHandler.HOLD_TRIGGER_MAX_MS,
      Math.max(WebSocketHandler.HOLD_TRIGGER_MIN_MS, target),
    );
    const headroom =
      typeof this.encoder.getActiveBackend === 'function' &&
      this.encoder.getActiveBackend() === 'software'
        ? WebSocketHandler.HOLD_HEADROOM_SOFTWARE_MS
        : WebSocketHandler.HOLD_HEADROOM_VAAPI_MS;
    const resumeRaw = target >= headroom ? 500 : Math.max(1000, headroom - target);
    const resumeTriggerServerMs = Math.max(
      500,
      Math.min(resumeRaw, holdTriggerMs - WebSocketHandler.HOLD_MIN_HYSTERESIS_MS),
    );
    return { holdTriggerMs, resumeTriggerServerMs };
  }

  /**
   * Issue #111: サーバーがクライアント再生位置より先に保持している時間 (ms)。
   * 生成アンカー (PlaybackBuffer 最新映像 PTS) − 実効プライマリ ack。後席セッションは
   * lastKnownAckPts に寄与しないため、Hold 判定は常に実効プライマリのみで行われる。
   */
  private serverHeldMs(): number {
    const latest = this.playbackBuffer.getLatestVideoPts();
    const ack = this.lastKnownAckPts;
    if (latest === null || ack === null || latest <= ack) return 0;
    return Number(latest - ack) / 1000;
  }

  /** 生成イベント起点の Buffer-Hold 評価フック (最大1秒に1回)。切断中の蓄積と CATCHUP 滞留を監視する。 */
  private evaluateBufferHold(): void {
    if (this.pipelineHoldState !== 'ACTIVE') return;
    const nowMs = Date.now();
    if (nowMs - this.lastHoldEvalAtMs < 1000) return;
    this.lastHoldEvalAtMs = nowMs;
    const cfg = this.computeHoldConfig();
    if (!cfg) return;
    const heldMs = this.serverHeldMs();
    const memoryGuard =
      this.playbackBuffer.getCurrentBytes() >= this.playbackBuffer.getMaxBytes() * 0.85;
    if (heldMs >= cfg.holdTriggerMs || memoryGuard) {
      this.enterBufferHold(
        memoryGuard && heldMs < cfg.holdTriggerMs ? 'memory_pressure' : 'backlog',
      );
    }
  }

  /**
   * Issue #111: Buffer-Hold Pause 発動。生成を 0.0x (Chrome SIGSTOP + FFmpeg 停止) に止めて
   * 消費 1.0x との速度差を作り、サーバー残余を自然に収束させる。autoSleepTimer は破棄して
   * holdExpireTimer へ排他引き継ぎする (両タイマー同時稼働ゼロ不変条件)。
   */
  private enterBufferHold(reason: string): void {
    if (this.pipelineHoldState !== 'ACTIVE') return;
    const cfg = this.computeHoldConfig();
    if (!cfg) return;
    const heldMs = Math.round(this.serverHeldMs());

    if (this.autoSleepTimer) {
      clearTimeout(this.autoSleepTimer);
      this.autoSleepTimer = null;
    }

    this.pipelineHoldState = 'BUFFER_HOLD_PAUSED';
    this.holdStartedAtMs = Date.now();
    console.log(
      `[WebSocketHandler] Buffer-Hold Pause engaged (${reason}): serverHeldMs=${heldMs} >= holdTriggerMs=${cfg.holdTriggerMs}. SIGSTOP browser + stop FFmpeg (generation 0.0x < consumption 1.0x). Resume at <=${cfg.resumeTriggerServerMs}ms.`,
    );

    this.encoder.noteHoldPause();
    this.encoder.stop();
    this.browserManager.pauseForBufferHold();

    this.armHoldExpireTimer();

    this.holdResumePollTimer = setInterval(() => {
      this.checkHoldResume();
    }, 500);
    this.holdResumePollTimer.unref();

    this.broadcastControl({
      type: 'BUFFER_HOLD',
      paused: true,
      serverHeldMs: heldMs,
      holdTriggerMs: cfg.holdTriggerMs,
    });
  }

  /** Hold の期限タイマーを設定する (満了時は共通スリープフローへ合流) */
  private armHoldExpireTimer(): void {
    if (this.holdExpireTimer) {
      clearTimeout(this.holdExpireTimer);
      this.holdExpireTimer = null;
    }
    const expireMin = Math.max(1, Number(process.env.BUFFER_HOLD_EXPIRE_MINUTES) || 10);
    this.holdExpireTimer = setTimeout(() => {
      this.holdExpireTimer = null;
      if (this.pipelineHoldState === 'BUFFER_HOLD_PAUSED') {
        console.log(
          '[WebSocketHandler] Buffer-Hold expired without reconnect or resume. Merging into auto-sleep common flow (SLEEP_PAUSED).',
        );
        this.enterSleepPaused('hold_expired');
      }
    }, expireMin * 60_000);
    this.holdExpireTimer.unref();
  }

  /** Hold 中の再開判定。消費者 (実効プライマリ) が 1.0x で消費した ack 進捗のみが条件を進める */
  private checkHoldResume(): void {
    if (this.pipelineHoldState !== 'BUFFER_HOLD_PAUSED') return;
    const cfg = this.computeHoldConfig();
    if (!cfg) {
      this.exitBufferHold('config_disabled');
      return;
    }
    // クライアント不在: 消費者がおらず heldMs は縮まらない。再接続または holdExpire→スリープまで待機
    if (!this.hasPrimaryClients() && !this.hasActingPrimaryClients()) {
      return;
    }
    if (this.serverHeldMs() <= cfg.resumeTriggerServerMs) {
      this.exitBufferHold('backlog_drained');
    }
  }

  /** Hold 解除。PTS はアンカーから単調連続 (noteHoldResume + 停止時間補償)、音声は境界ゲートで保護 */
  private exitBufferHold(reason: string): void {
    if (this.pipelineHoldState !== 'BUFFER_HOLD_PAUSED') return;
    const heldMs = Math.round(this.serverHeldMs());
    const heldForSec = Math.round((Date.now() - this.holdStartedAtMs) / 1000);
    this.clearHoldTimers();
    this.pipelineHoldState = 'ACTIVE';
    console.log(
      `[WebSocketHandler] Buffer-Hold Pause released (${reason}) after ${heldForSec}s, remaining held=${heldMs}ms. SIGCONT browser + restart FFmpeg (PTS continues from anchor).`,
    );
    this.browserManager.resumeFromBufferHold();
    this.encoder.noteHoldResume();
    this.encoder.armResumeGate(WebSocketHandler.RESUME_GATE_MS);
    this.ensureEncoderRunning();
    this.lastHoldEvalAtMs = 0;
    this.broadcastControl({ type: 'BUFFER_HOLD', paused: false });
    if (!this.hasPrimaryClients() && !this.hasActingPrimaryClients()) {
      this.scheduleAutoSleep();
    }
  }

  /** 手動停止など、Hold からスリープへ直接遷移させる排他処理 */
  private convertHoldToSleep(reason: string): void {
    if (this.pipelineHoldState !== 'BUFFER_HOLD_PAUSED') return;
    console.log(`[WebSocketHandler] Converting buffer-hold to sleep pause (${reason}).`);
    this.clearHoldTimers();
    this.pipelineHoldState = 'ACTIVE';
    this.encoder.resetHoldCompensation?.();
    this.broadcastControl({ type: 'BUFFER_HOLD', paused: false });
  }

  private clearHoldTimers(): void {
    if (this.holdExpireTimer) {
      clearTimeout(this.holdExpireTimer);
      this.holdExpireTimer = null;
    }
    if (this.holdResumePollTimer) {
      clearInterval(this.holdResumePollTimer);
      this.holdResumePollTimer = null;
    }
  }

  /**
   * Issue #111: SLEEP_PAUSED への共通フロー (autoSleep 満了と holdExpire 満了の単一経路)。
   */
  private enterSleepPaused(reason: string): void {
    this.clearHoldTimers();
    const wasHolding = this.pipelineHoldState === 'BUFFER_HOLD_PAUSED';
    this.pipelineHoldState = 'ACTIVE';
    if (wasHolding) {
      this.encoder.resetHoldCompensation?.();
      this.broadcastControl({ type: 'BUFFER_HOLD', paused: false });
    }
    console.log(
      `[WebSocketHandler] Entering sleep pause (${reason}${wasHolding ? ', from buffer-hold' : ''}): stopping FFmpeg, pausing browser (True CPU 0%), clearing playback buffer.`,
    );
    this.encoder.stop();
    this.browserManager.pause();
    this.playbackBuffer.clear();
    this.lastKnownAckPts = null;
    this.enterSecondaryStandby();
  }

  private scheduleAutoSleep(): void {
    if (this.autoSleepTimer) {
      clearTimeout(this.autoSleepTimer);
      this.autoSleepTimer = null;
    }
    // Issue #111: Hold 中は autoSleepTimer を起動せず、holdExpireTimer のみで排他管理する。
    // Hold 中の再接続で一旦解除された後に排水前で再切断した場合も、autoSleepMinutes=0 環境を
    // 含めて確実に holdExpireTimer を再設定し、永久 Hold 滞留を防ぐ。
    if (this.pipelineHoldState === 'BUFFER_HOLD_PAUSED') {
      if (!this.holdExpireTimer) {
        this.armHoldExpireTimer();
      }
      return;
    }
    const config = this.configStore.getConfig();
    const autoSleepMins = typeof config.autoSleepMinutes === 'number' ? config.autoSleepMinutes : 3;
    if (autoSleepMins === 0) {
      console.log('[WebSocketHandler] Auto-sleep disabled (autoSleepMinutes=0).');
      return;
    }
    let delayMs = Math.max(15000, autoSleepMins * 60 * 1000);
    // Issue #111: Hold が有効な設定で autoSleepMinutes が極短の場合、Hold が発動する前に
    // スリープしないよう holdTriggerMs + 5s へ繰り延べる (両タイマーの同時稼働は発生しない)
    const holdCfg = this.computeHoldConfig();
    if (holdCfg) {
      delayMs = Math.max(delayMs, holdCfg.holdTriggerMs + 5000);
    }
    console.log(
      `[WebSocketHandler] No clients connected. Scheduling auto-sleep in ${delayMs / 1000}s...`,
    );

    this.autoSleepTimer = setTimeout(() => {
      this.autoSleepTimer = null;
      if (!this.hasPrimaryClients() && !this.hasActingPrimaryClients()) {
        // Issue #111: holdExpire 満了と同一の共通スリープフローへ合流
        this.enterSleepPaused('auto_sleep');
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
    if (this.unsubscribePageInfo) {
      this.unsubscribePageInfo();
      this.unsubscribePageInfo = null;
    }
    if (this.autoSleepTimer) clearTimeout(this.autoSleepTimer);
    this.clearHoldTimers();
    this.clearActingPrimaryGraceTimer();
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
    this.authorizedSessions.clear();
  }
}
