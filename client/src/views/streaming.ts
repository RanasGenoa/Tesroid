import { AdaptiveJitterController } from '../core/adaptive-jitter.js';
import type { AudioPlayer } from '../core/audio-player.js';
import type { AvSyncController } from '../core/av-sync.js';
import { CanvasRenderer } from '../core/canvas-renderer.js';
import { VideoStreamDecoder } from '../core/decoder.js';
import { FramePacer } from '../core/frame-pacer.js';
import { DynamicLatencyController, type LatencyMode } from '../core/latency.js';
import { MetricsCollector } from '../core/metrics.js';
import { TelemetryCollector } from '../core/telemetry.js';
import { TouchMapper } from '../input/touch-mapper.js';
import { ClientProtocol } from '../transport/protocol.js';
import type { WsClient } from '../transport/ws-client.js';
import { ICONS, showToast } from './icons.js';
import { browserRestart, encoderRestart } from './power-actions.js';

const PACKET_STALL_WARN_THRESHOLD_MS = 400;
const PACKET_LOSS_TIMEOUT_MS = 1200;
const RTT_WARN_THRESHOLD_MS = 90;
const ENCODER_RESTART_COOLDOWN_MS = 1000;
const RTT_HISTORY_WINDOW_SIZE = 8;

export function renderStreamingView(
  container: HTMLElement,
  wsClient: WsClient,
  audioPlayer: AudioPlayer,
  avSync: AvSyncController,
  onOpenSettings: () => void,
  authToken?: string | null,
): () => void {
  container.innerHTML = `
    <div id="screen-container">
      <!-- Dedicated Slim Top HUD Dock Bar -->
      <div id="stream-hud" class="stream-hud">
        <!-- Left Group: Stop Button & Telemetry Cluster -->
        <div class="hud-left-group">
          <!-- Always visible Power & Stop Button (Leftmost) -->
          <button id="hud-stop-btn" class="hud-btn hud-stop-btn" title="省電力 & リソース制御">${ICONS.power} 停止</button>

          <div class="hud-divider"></div>

          <!-- Telemetry Cluster (Smart & Cyber Instrument Style) -->
          <div class="hud-telemetry-cluster">
            <!-- Connection Status & Instant RTT with Signal Bars -->
            <span id="hud-conn" class="hud-badge hud-conn-badge" title="接続状態と瞬間ネットワーク往復時間 (RTT)">
              <span id="hud-signal" class="signal-meter signal-level-4">
                <span class="signal-bar bar-1"></span>
                <span class="signal-bar bar-2"></span>
                <span class="signal-bar bar-3"></span>
                <span class="signal-bar bar-4"></span>
              </span>
              <span id="hud-conn-dot" class="status-dot status-online"></span>
              <span id="hud-conn-text" class="telemetry-value">--ms</span>
            </span>

            <!-- Playback Mode / Catch-up Buffer Status & One-Tap Jump to LIVE -->
            <button id="hud-live-btn" class="hud-live-btn" title="再生状態 / タップで最新LIVE同期・再エンコードを一括実行">
              <span id="hud-live-dot" class="status-dot status-online pulse"></span>
              <span id="hud-live-text" class="telemetry-value">LIVE</span>
            </button>

            <!-- Render FPS Real-time -->
            <span id="hud-fps" class="hud-badge telemetry-value" title="実測描画フレームレート">-- FPS</span>

            <!-- Stream Quality Quick Toggles -->
            <button id="hud-fps-toggle" class="hud-pill-btn" title="フレームレート切替 (タップで 30 / 60 切替)">
              ${ICONS.zap} <span id="hud-fps-val" class="telemetry-value">30</span>
            </button>
            <button id="hud-bitrate-toggle" class="hud-pill-btn" title="ビットレート切替 (タップで 0.5M 〜 2.0M 切替)">
              ${ICONS.signal} <span id="hud-bitrate-val" class="telemetry-value">1.0M</span>
            </button>
          </div>
        </div>

        <!-- Right Group: Navigation, Search, Settings -->
        <div class="hud-right-group">
          <!-- Virtual Keyboard Drawer Toggle -->
          <button id="hud-keyboard-btn" class="hud-btn" title="文字入力バーを展開 (車載キーボード入力)">
            ${ICONS.keyboard}
          </button>

          <!-- Browser Navigation Controls -->
          <button id="hud-back-btn" class="hud-btn" title="戻る (Back)">${ICONS.back}</button>
          <button id="hud-home-btn" class="hud-btn" title="YouTube ホーム (Home)">${ICONS.home}</button>

          <div class="hud-divider"></div>

          <!-- YouTube Search Box (Direct Search Page Navigation) -->
          <form id="hud-search-form" class="hud-search-form" style="display: flex; align-items: center; gap: 4px; margin: 0;">
            <input
              id="hud-search-input"
              type="text"
              placeholder="YouTube検索..."
              autocomplete="off"
            />
            <button id="hud-search-btn" class="hud-btn hud-search-submit-btn" type="submit" title="YouTube検索を実行">${ICONS.search}</button>
          </form>

          <div class="hud-divider"></div>

          <!-- Settings Console Trigger -->
          <button id="hud-settings-btn" class="hud-btn" title="設定コンソール">${ICONS.settings}</button>
        </div>
      </div>

      <!-- Virtual Keyboard Drawer (Expands below Top HUD) -->
      <div id="hud-keyboard-drawer" class="hud-keyboard-drawer" style="display: none;">
        <form id="hud-keyboard-form" class="hud-keyboard-form">
          <input
            id="hud-keyboard-input"
            type="text"
            placeholder="文字を入力して送信（テスラキーボードで入力）..."
            autocomplete="off"
          />
          <button id="hud-keyboard-send-btn" type="submit" class="hud-kbd-btn hud-kbd-send-btn" title="入力文字をChromeに送信">
            送信
          </button>
          <button id="hud-keyboard-enter-btn" type="button" class="hud-kbd-btn" title="決定 / フォーム送信 (Enter)">
            Enter ⏎
          </button>
          <button id="hud-keyboard-backspace-btn" type="button" class="hud-kbd-btn" title="1文字削除 (Backspace)">
            ⌫
          </button>
          <button id="hud-keyboard-tab-btn" type="button" class="hud-kbd-btn" title="次の項目へ移動 (Tab)">
            Tab ⇥
          </button>
          <button id="hud-keyboard-close-btn" type="button" class="hud-kbd-close-btn" title="閉じる">
            ${ICONS.close}
          </button>
        </form>
      </div>

      <!-- Dedicated Stream Viewport below the Top HUD Dock -->
      <div id="stream-viewport" class="stream-viewport">
        <!-- Direct rendering target for Tesla Browser (Canvas 2D) -->
        <canvas id="stream-canvas"></canvas>

        <!-- Full-screen Status Notification Overlay (for Disconnect, Sleep, Startup) -->
        <div id="stream-status-overlay" class="stream-notice-overlay" style="display: flex;">
          <div class="notice-card">
            <div id="notice-spinner" class="spinner"></div>
            <h3 id="notice-title" style="margin: 12px 0 6px;">画面配信準備中...</h3>
            <p id="notice-desc" style="margin: 0; font-size: 14px; color: var(--text-muted);">サーバーから映像を受信しています</p>

            <!-- Real-time Status Badges -->
            <div id="health-badges" style="display: flex; gap: 8px; justify-content: center; margin-top: 16px; font-size: 12px; flex-wrap: wrap;">
              <span id="health-browser" style="background: rgba(255,255,255,0.08); padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border-color); display: flex; align-items: center; gap: 6px;">
                <span class="status-dot status-warning"></span> Browser: 準備中...
              </span>
              <span id="health-stream" style="background: rgba(255,255,255,0.08); padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border-color); display: flex; align-items: center; gap: 6px;">
                <span class="status-dot status-idle"></span> 配信: 待機中
              </span>
            </div>

            <!-- Action Buttons for Resume or Disconnect -->
            <div id="notice-action-box" style="margin-top: 20px; display: none; display: flex; flex-direction: column; gap: 10px;">
              <button id="notice-action-btn" class="btn btn-primary" style="padding: 12px 24px; font-size: 15px; width: 100%;">再開する (タップで復帰)</button>
              <button id="notice-disconnect-btn" class="btn btn-secondary" style="padding: 10px 18px; font-size: 13px; width: 100%;">切断して待機画面へ</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const canvas = document.getElementById('stream-canvas') as HTMLCanvasElement;
  const streamViewport = document.getElementById('stream-viewport') as HTMLElement;
  const hudConn = document.getElementById('hud-conn') as HTMLElement;
  const hudSignal = document.getElementById('hud-signal') as HTMLElement;
  const connDot = document.getElementById('hud-conn-dot') as HTMLElement;
  const connText = document.getElementById('hud-conn-text') as HTMLElement;
  const hudLiveBtn = document.getElementById('hud-live-btn') as HTMLButtonElement;
  const hudLiveDot = document.getElementById('hud-live-dot') as HTMLElement;
  const hudLiveText = document.getElementById('hud-live-text') as HTMLElement;
  const fpsBadge = document.getElementById('hud-fps') as HTMLElement;
  const statusOverlay = document.getElementById('stream-status-overlay') as HTMLElement;
  const noticeSpinner = document.getElementById('notice-spinner') as HTMLElement;
  const noticeTitle = document.getElementById('notice-title') as HTMLElement;
  const noticeDesc = document.getElementById('notice-desc') as HTMLElement;
  const healthBrowser = document.getElementById('health-browser') as HTMLElement;
  const healthStream = document.getElementById('health-stream') as HTMLElement;
  const noticeActionBox = document.getElementById('notice-action-box') as HTMLElement;
  const noticeActionBtn = document.getElementById('notice-action-btn') as HTMLButtonElement;
  const noticeDisconnectBtn = document.getElementById('notice-disconnect-btn') as HTMLButtonElement;

  type BrowserPowerState = 'active' | 'sleeping' | 'waking';
  let browserPowerState: BrowserPowerState = 'active';

  let instantRtt = 0;
  let minRtt = Number.POSITIVE_INFINITY;
  let rttHistory: number[] = [];
  let lastPacketReceivedTime = performance.now();
  let pingId = 0;
  let targetFps = 30;
  let currentFps = 30;
  let currentBitrate = 1000000;

  const fpsOptions = [30, 60];
  const bitrateOptions = [500000, 750000, 1000000, 1500000, 2000000];

  const fpsToggleBtn = document.getElementById('hud-fps-toggle') as HTMLButtonElement;
  const bitrateToggleBtn = document.getElementById('hud-bitrate-toggle') as HTMLButtonElement;
  const hudFpsVal = document.getElementById('hud-fps-val') as HTMLElement;
  const hudBitrateVal = document.getElementById('hud-bitrate-val') as HTMLElement;

  const streamHud = document.getElementById('stream-hud') as HTMLElement;
  let hasPromptedAudioUnlock = false;

  // Auto-dimming HUD after 4 seconds of inactivity
  let hudDimTimer: any = null;
  const resetHudDimTimer = () => {
    if (!streamHud) return;
    streamHud.classList.remove('dimmed');
    if (hudDimTimer) clearTimeout(hudDimTimer);
    hudDimTimer = setTimeout(() => {
      if (browserPowerState === 'active') {
        streamHud.classList.add('dimmed');
      }
    }, 4000);
  };

  window.addEventListener('pointermove', resetHudDimTimer);
  window.addEventListener('pointerdown', resetHudDimTimer);
  resetHudDimTimer();

  const formatBitrateLabel = (bps: number): string => {
    if (bps === 500000) return '0.5M';
    if (bps === 750000) return '0.75M';
    if (bps === 1000000) return '1.0M';
    if (bps === 1500000) return '1.5M';
    if (bps === 2000000) return '2.0M';
    return `${(bps / 1000000).toFixed(1)}M`;
  };

  const updateToggleButtons = () => {
    if (hudFpsVal) hudFpsVal.textContent = `${currentFps}`;
    if (hudBitrateVal) hudBitrateVal.textContent = formatBitrateLabel(currentBitrate);
  };

  // 1. Core Streaming Pipeline
  const telemetryCollector = new TelemetryCollector();
  telemetryCollector.onFlush = (events) => {
    if (wsClient.isConnected()) {
      wsClient.send(ClientProtocol.packTelemetry(events));
    }
  };

  const metricsCollector = new MetricsCollector();
  metricsCollector.onReport = (metrics) => {
    if (wsClient.isConnected()) {
      wsClient.send(ClientProtocol.packMetrics(metrics));
    } else {
      const token =
        authToken ||
        localStorage.getItem('tesroid_token') ||
        sessionStorage.getItem('tesroid_token');
      fetch('/api/metrics/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(metrics),
      }).catch(() => {});
    }
  };

  const renderer = new CanvasRenderer(canvas);
  const framePacer = new FramePacer(renderer, targetFps, avSync);

  // 1.1. Adaptive Jitter Buffer Controller for LTE Jitter & Spikes
  const jitterController = new AdaptiveJitterController({
    onDelayChanged: (delayMs: number) => {
      framePacer.setAdditionalDelay(delayMs);
      audioPlayer.setAdditionalDelay(delayMs);
    },
  });

  // Sync settings on startup
  const effectiveToken =
    authToken || localStorage.getItem('tesroid_token') || sessionStorage.getItem('tesroid_token');
  if (effectiveToken) {
    fetch('/api/settings', {
      headers: { Authorization: `Bearer ${effectiveToken}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.stream?.maxFps) {
          currentFps = Number(data.stream.maxFps);
          targetFps = currentFps;
          framePacer.setTargetFps(targetFps);
        }
        if (data?.stream?.bitrate) {
          currentBitrate = Number(data.stream.bitrate);
        }
        updateToggleButtons();
      })
      .catch(() => {});
  }

  // Debounced settings persistence & server notify
  let saveSettingsTimer: any = null;
  const triggerSaveSettings = () => {
    if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
    saveSettingsTimer = setTimeout(async () => {
      const token =
        authToken ||
        localStorage.getItem('tesroid_token') ||
        sessionStorage.getItem('tesroid_token');
      if (!token) return;
      try {
        await fetch('/api/settings', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            stream: {
              maxFps: currentFps,
              bitrate: currentBitrate,
            },
          }),
        });
        window.dispatchEvent(
          new CustomEvent('tesroid:settings-updated', {
            detail: { stream: { maxFps: currentFps, bitrate: currentBitrate } },
          }),
        );
        showToast(
          `画質設定を更新しました: ${currentFps}FPS / ${formatBitrateLabel(currentBitrate)}`,
          'success',
        );
      } catch (err) {
        console.error('[HUD] Failed to update stream settings:', err);
      }
    }, 300);
  };

  // Circular toggle clicks
  fpsToggleBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const nextIdx = (fpsOptions.indexOf(currentFps) + 1) % fpsOptions.length;
    currentFps = fpsOptions[nextIdx];
    targetFps = currentFps;
    framePacer.setTargetFps(targetFps);
    updateToggleButtons();
    triggerSaveSettings();
  });

  bitrateToggleBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    let idx = bitrateOptions.indexOf(currentBitrate);
    if (idx === -1) idx = 2; // Default to 1.0M
    const nextIdx = (idx + 1) % bitrateOptions.length;
    currentBitrate = bitrateOptions[nextIdx];
    updateToggleButtons();
    triggerSaveSettings();
  });

  const onSettingsUpdated = (e: any) => {
    let changed = false;
    if (e.detail?.stream?.maxFps) {
      currentFps = Number(e.detail.stream.maxFps);
      targetFps = currentFps;
      framePacer.setTargetFps(targetFps);
      changed = true;
    }
    if (e.detail?.stream?.bitrate) {
      currentBitrate = Number(e.detail.stream.bitrate);
      changed = true;
    }
    if (e.detail?.bufferDepth !== undefined) {
      targetBufferMs = Number(e.detail.bufferDepth);
      if (typeof decoder.setBufferDepth === 'function') {
        decoder.setBufferDepth({ targetDurationMs: targetBufferMs });
      }
      sendBufferFeedback(true);
    }
    if (e.detail?.telemetryEnabled !== undefined) {
      const enabled = Boolean(e.detail.telemetryEnabled);
      telemetryCollector.setEnabled(enabled);
      syncTelemetryAttachment(enabled);
    }
    if (changed) {
      updateToggleButtons();
    }
  };
  window.addEventListener('tesroid:settings-updated', onSettingsUpdated);

  // Initialize configurable buffer depth (e.g. ?buffer=2s for Intel MCU2, ?buffer=10s for Ryzen MCU3)
  const getInitialBufferDepthMs = (): number => {
    try {
      const params = new URLSearchParams(window.location.search);
      const bufParam = params.get('buffer');
      if (bufParam) {
        if (bufParam.endsWith('s')) return parseFloat(bufParam) * 1000;
        return parseInt(bufParam, 10);
      }
      const saved = localStorage.getItem('tesroid_prefetch_buffer_ms');
      if (saved !== null) {
        const val = parseInt(saved, 10);
        if (!isNaN(val)) return val;
      }
    } catch {}
    return 10000; // Default 10s prefetch cushion
  };

  let targetBufferMs = getInitialBufferDepthMs();
  let lastDecodedPts = 0;
  let lastAckSentPts = -1;
  let serverCatchupQueueMs = 0;
  let serverBufferMs = 0;
  let serverMode: 'LIVE' | 'CATCHUP' = 'LIVE';

  const decoder = new VideoStreamDecoder(
    (frame: VideoFrame) => {
      metricsCollector.recordFrameRendered();
      framePacer.queueFrame(frame);
      hideOverlay();
    },
    (ptsUs: number) => {
      lastDecodedPts = ptsUs;
    },
  );

  if (typeof decoder.setBufferDepth === 'function') {
    decoder.setBufferDepth({ targetDurationMs: targetBufferMs });
  }

  const syncTelemetryAttachment = (enabled: boolean) => {
    const activeCollector = enabled ? telemetryCollector : undefined;
    if (typeof (framePacer as any).setTelemetryCollector === 'function') {
      (framePacer as any).setTelemetryCollector(activeCollector);
    }
    if (typeof (audioPlayer as any).setTelemetryCollector === 'function') {
      (audioPlayer as any).setTelemetryCollector(activeCollector);
    }
    if (typeof decoder.setTelemetryCollector === 'function') {
      decoder.setTelemetryCollector(activeCollector);
    }
  };
  syncTelemetryAttachment(telemetryCollector.isEnabled());

  if (typeof decoder.setDownstreamQueueLengthProvider === 'function') {
    decoder.setDownstreamQueueLengthProvider(() =>
      typeof framePacer.getQueueLength === 'function' ? framePacer.getQueueLength() : 0,
    );
  }

  framePacer.onFrameProcessed = () => {
    if (typeof decoder.pumpPendingPackets === 'function') {
      decoder.pumpPendingPackets();
    }
    if (typeof audioPlayer.syncWithVideo === 'function') {
      audioPlayer.syncWithVideo();
    }
    sendBufferFeedback();
  };

  decoder.onDecoderError = () => {
    metricsCollector.recordDecoderError();
    // デコードエラー時も即座に最新デコード済み PTS を ACK 送付
    if (wsClient.isConnected() && lastDecodedPts > 0) {
      wsClient.send(ClientProtocol.packAck(lastDecodedPts));
      lastAckSentPts = lastDecodedPts;
    }
  };

  const getTotalBufferedBehindMs = () => {
    const pacerBufferedMs =
      typeof framePacer.getBufferedDurationMs === 'function'
        ? framePacer.getBufferedDurationMs()
        : 0;
    const decoderBufferedMs =
      typeof decoder.getPendingBufferedMs === 'function' ? decoder.getPendingBufferedMs() : 0;
    const audioBufferedMs =
      typeof audioPlayer.getBufferedAudioMs === 'function' ? audioPlayer.getBufferedAudioMs() : 0;
    // Notice: Do NOT use raw `(serverLatestPts - lastDecodedPts)` as "buffered behind" because on a static screen
    // FFmpeg does not emit new frames while server wall-clock advances, which previously caused false 2-3s catch-up display!
    const clientBufferedMs = Math.max(
      pacerBufferedMs + decoderBufferedMs,
      Math.max(0, audioBufferedMs - 160),
    );
    return clientBufferedMs + Math.max(serverCatchupQueueMs, serverBufferMs);
  };

  const setTextIfChanged = (el: HTMLElement | null, text: string) => {
    if (el && el.textContent !== text) el.textContent = text;
  };
  const setClassIfChanged = (el: HTMLElement | null, cls: string) => {
    if (el && el.className !== cls) el.className = cls;
  };
  const setTitleIfChanged = (el: HTMLElement | null, title: string) => {
    if (el && el.title !== title) el.title = title;
  };
  const setColorIfChanged = (el: HTMLElement | null, color: string) => {
    if (el && el.style.color !== color) el.style.color = color;
  };

  const updateHudConnStatus = () => {
    if (!connText || !connDot || !hudSignal) return;

    let targetClass = '';
    let signalLevelClass = 'signal-meter signal-level-4';
    let targetText = '';
    let targetTitle = '';

    if (!wsClient.isConnected()) {
      targetClass = 'status-dot status-offline';
      signalLevelClass = 'signal-meter signal-level-0';
      targetText = '切断';
      targetTitle = '接続状態: 切断';
    } else {
      const elapsed = performance.now() - lastPacketReceivedTime;

      if (elapsed > PACKET_LOSS_TIMEOUT_MS) {
        // 1.2秒以上パケットが途絶えている（パケロス・電波瞬断）
        targetClass = 'status-dot status-offline';
        signalLevelClass = 'signal-meter signal-level-0';
        targetText = '瞬断中';
        targetTitle = `通信断 / パケット未着: ${(elapsed / 1000).toFixed(1)}秒 (瞬間RTT: ${instantRtt}ms)`;
      } else if (elapsed > PACKET_STALL_WARN_THRESHOLD_MS || instantRtt >= RTT_WARN_THRESHOLD_MS) {
        // パケット到着間隔の拡大、または回線RTTが警告レベル
        targetClass = 'status-dot status-warning';
        signalLevelClass =
          instantRtt >= 130 ? 'signal-meter signal-level-1' : 'signal-meter signal-level-2';
        targetText = instantRtt > 0 ? `${instantRtt}ms` : '接続中';
        targetTitle = `通信不安定 (瞬間RTT: ${instantRtt}ms, 受信間隔: ${Math.round(elapsed)}ms)`;
      } else {
        // パケットが円滑に届いており回線も良好
        targetClass = 'status-dot status-online';
        signalLevelClass =
          instantRtt >= 60 ? 'signal-meter signal-level-3' : 'signal-meter signal-level-4';
        targetText = instantRtt > 0 ? `${instantRtt}ms` : '接続中';
        targetTitle = `通信良好 (瞬間RTT: ${instantRtt}ms)`;
      }
    }

    setClassIfChanged(connDot, targetClass);
    setClassIfChanged(hudSignal, signalLevelClass);
    setTextIfChanged(connText, targetText);
    setTitleIfChanged(hudConn, targetTitle);
  };

  let lastHudLiveState: 'interactive' | 'buffering' | 'catchup' | 'live' | '' = '';

  const updateHudLiveStatus = () => {
    if (!hudLiveBtn || !hudLiveText || !hudLiveDot) return;

    const isBuffering =
      typeof framePacer.getIsBuffering === 'function' ? framePacer.getIsBuffering() : false;
    const isInteractive =
      typeof framePacer.getMode === 'function' && framePacer.getMode() === 'ACTIVE_INTERACTION';

    const pacerMs =
      typeof framePacer.getBufferedDurationMs === 'function'
        ? framePacer.getBufferedDurationMs()
        : 0;
    const decoderMs =
      typeof decoder.getPendingBufferedMs === 'function' ? decoder.getPendingBufferedMs() : 0;
    const localMs = pacerMs + decoderMs;
    const serverMs = Math.max(serverCatchupQueueMs, serverBufferMs);

    const localSec = (localMs / 1000).toFixed(1);
    const serverSec = (serverMs / 1000).toFixed(1);

    const currentState = isInteractive
      ? 'interactive'
      : isBuffering
        ? 'buffering'
        : localMs >= 800 || serverMs >= 600
          ? 'catchup'
          : 'live';

    if (currentState !== lastHudLiveState) {
      lastHudLiveState = currentState;
      hudLiveBtn.classList.remove('is-catchup', 'is-buffering');
      if (currentState === 'buffering') {
        hudLiveBtn.classList.add('is-buffering');
      } else if (currentState === 'catchup') {
        hudLiveBtn.classList.add('is-catchup');
      }

      const targetDotClass =
        currentState === 'buffering' ? 'status-dot status-warning' : 'status-dot status-online';
      setClassIfChanged(hudLiveDot, targetDotClass);
    }

    let targetText = 'LIVE';
    let targetTitle = 'リアルタイム再生中 (タップで最新LIVE同期・再エンコード)';

    if (currentState === 'interactive') {
      targetText = 'DIRECT LIVE';
      targetTitle =
        '操作優先: バッファゼロ・超低遅延モードで動作中 (タップで最新LIVE同期・再エンコード)';
    } else if (currentState === 'buffering') {
      targetText = `WAIT L:${localSec}s S:${serverSec}s`;
      targetTitle = `受信待機中 (ローカル: ${localSec}秒, サーバー: ${serverSec}秒) — タップで最新LIVE同期・再エンコード`;
    } else if (currentState === 'catchup') {
      targetText = `BUF L:${localSec}s S:${serverSec}s`;
      targetTitle = `キャッシュ再生中 (ローカル: ${localSec}秒, サーバー: ${serverSec}秒) — タップで最新LIVE同期・再エンコード`;
    } else {
      const cushionMs =
        typeof framePacer.getAutoCushionMs === 'function' ? framePacer.getAutoCushionMs() : 0;
      targetText = cushionMs > 50 ? `LIVE (+${Math.round(cushionMs)}ms)` : 'LIVE';
    }

    setTextIfChanged(hudLiveText, targetText);
    setTitleIfChanged(hudLiveBtn, targetTitle);
  };

  framePacer.onBufferingChange = () => {
    if (typeof audioPlayer.syncWithVideo === 'function') {
      audioPlayer.syncWithVideo();
    }
    updateHudLiveStatus();
  };

  const executeJumpToLive = (silent = false) => {
    if (typeof decoder.flushPendingForLiveJump === 'function') {
      decoder.flushPendingForLiveJump();
    }
    if (typeof framePacer.jumpToLive === 'function') {
      framePacer.jumpToLive();
    }
    if (typeof audioPlayer.jumpToLive === 'function') {
      audioPlayer.jumpToLive();
    } else if (typeof audioPlayer.resetJitterBuffer === 'function') {
      audioPlayer.resetJitterBuffer();
    }
    jitterController.reset();
    serverCatchupQueueMs = 0;
    serverBufferMs = 0;
    serverMode = 'LIVE';
    lastHudLiveState = '';
    if (wsClient.isConnected()) {
      wsClient.send(ClientProtocol.packCommand({ type: 'JUMP_TO_LIVE' }));
    }
    updateHudLiveStatus();
    if (!silent) {
      showToast('未再生バッファを破棄し、最新LIVE映像へ同期しました', 'info');
    }
  };

  let isRestartingEncoder = false;
  let encoderRestartTimer: ReturnType<typeof setTimeout> | null = null;

  hudLiveBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    resetHudDimTimer();

    if (isRestartingEncoder) return;
    isRestartingEncoder = true;

    // バッファ破棄とエンコーダ再起動を一括実行
    executeJumpToLive(true);

    const token =
      authToken ||
      localStorage.getItem('tesroid_token') ||
      sessionStorage.getItem('tesroid_token') ||
      '';
    try {
      await encoderRestart(token);
    } catch (err: unknown) {
      console.error('[StreamingView] Failed to restart encoder on live tap:', err);
    } finally {
      if (encoderRestartTimer) clearTimeout(encoderRestartTimer);
      encoderRestartTimer = setTimeout(() => {
        isRestartingEncoder = false;
        encoderRestartTimer = null;
      }, ENCODER_RESTART_COOLDOWN_MS);
    }
  });

  // 2. Auto-Hybrid Dynamic Latency Controller:
  // - While touching/scrolling (searching for videos): switches to ACTIVE_INTERACTION (zero buffer, instant touch response).
  //   If the stream was lagging behind (> 400ms or in CATCHUP), automatically syncs to LIVE so UI operation is snappy!
  // - 4 seconds after user stops touching (watching a video): automatically transitions to PASSIVE_STREAMING (smooth AV-synced cushion).
  const latencyController = new DynamicLatencyController((mode: LatencyMode) => {
    if (mode === 'ACTIVE_INTERACTION') {
      const behindMs = getTotalBufferedBehindMs();
      if (behindMs >= 400 || serverMode === 'CATCHUP') {
        executeJumpToLive(true);
      } else {
        if (typeof decoder.flushPendingForLiveJump === 'function') {
          decoder.flushPendingForLiveJump();
        }
        jitterController.reset();
      }
    }
    framePacer.setMode(mode);
    updateHudLiveStatus();
  }, 4000);

  // 3. Touch Mapper
  const touchMapper = new TouchMapper(canvas, wsClient, latencyController);

  // Auto-unlock AudioContext on any user touch/click anywhere on screen
  const autoUnlockAudio = () => {
    const stats = audioPlayer.getStats();
    if (!stats.isUnlocked || stats.state === 'suspended') {
      audioPlayer.unlock();
    }
  };
  canvas.addEventListener('pointerdown', autoUnlockAudio);
  window.addEventListener('pointerdown', autoUnlockAudio, { capture: true });

  // 4. Dynamic Resolution Fit (Zero-Black-Bar, dedicated viewport above bottom HUD)
  let resizeTimer: any = null;
  const sendResize = (immediate: boolean = false) => {
    const execute = () => {
      const vpWidth = streamViewport?.clientWidth || 0;
      const vpHeight = streamViewport?.clientHeight || 0;
      const width = vpWidth > 0 ? vpWidth : window.innerWidth;
      const height = vpHeight > 0 ? vpHeight : window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      wsClient.send(ClientProtocol.packResize(width, height, dpr));
    };

    if (immediate) {
      execute();
    } else {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(execute, 350);
    }
  };

  const onResize = () => sendResize(false);
  window.addEventListener('resize', onResize);
  sendResize(false);

  // 5. Connect WebSocket streams
  const handleVideo = (msg: { flags: number; pts: bigint; data: Uint8Array }) => {
    lastPacketReceivedTime = performance.now();
    metricsCollector.recordVideoPacket(msg.data.byteLength);
    jitterController.recordVideoArrival();
    decoder.handlePacket(msg.flags, msg.pts, msg.data);
    if (healthStream) {
      healthStream.innerHTML = `<span class="status-dot status-online"></span> 配信: 送信中`;
    }
  };

  const handleAudio = (msg: { flags: number; pts: bigint; data: Uint8Array }) => {
    lastPacketReceivedTime = performance.now();
    metricsCollector.recordAudioPacket();
    audioPlayer.handleAudioPacket(msg.flags, msg.pts, msg.data);
  };

  const showOverlay = (title: string, desc: string, showSpinner = true) => {
    noticeTitle.textContent = title;
    noticeDesc.textContent = desc;
    if (noticeSpinner) noticeSpinner.style.display = showSpinner ? 'block' : 'none';
    statusOverlay.style.display = 'flex';
  };

  const hideOverlay = () => {
    statusOverlay.style.display = 'none';
    if (noticeActionBox) noticeActionBox.style.display = 'none';
  };

  const showSleepingScreen = () => {
    browserPowerState = 'sleeping';
    showOverlay(
      '省電力一時停止中 (CPU/GPU 0%)',
      'ブラウザと配信は休止中です。再開ボタンまたは画面タップで即時復帰します。',
      false,
    );
    if (noticeActionBox && noticeActionBtn) {
      noticeActionBtn.textContent = '再開する (タップで復帰)';
      noticeActionBox.style.display = 'flex';
    }
    if (healthBrowser) {
      healthBrowser.innerHTML = `<span class="status-dot status-idle"></span> Browser: 一時停止`;
    }
  };

  const triggerResume = () => {
    browserPowerState = 'waking';
    showOverlay('復帰処理中...', 'ブラウザとハードウェアエンコーダを再開しています...', true);
    if (noticeActionBox) noticeActionBox.style.display = 'none';
    wsClient.send(ClientProtocol.packCommand({ type: 'RESUME_BROWSER' }));
  };

  // Immediate Stop Action
  const triggerStop = () => {
    wsClient.send(ClientProtocol.packCommand({ type: 'PAUSE_BROWSER' }));
    audioPlayer.resetJitterBuffer();
    decoder.reset();
    showSleepingScreen();
    showToast('ブラウザと配信プロセスを停止しました (CPU/GPU 0%)', 'info');
  };

  const openPowerModal = () => {
    const existing = document.getElementById('power-menu-modal');
    if (existing) {
      existing.remove();
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'power-menu-modal';

    overlay.innerHTML = `
      <div class="card" style="max-width: 440px; width: 90%; max-height: 85vh; overflow-y: auto; position: relative; border-radius: 4px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <h3 style="margin: 0; font-size: 17px; display: flex; align-items: center; gap: 8px;">
            ${ICONS.power} 省電力 & リソース制御
          </h3>
          <button id="power-modal-close-btn" class="hud-btn" style="font-size: 18px; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; border-radius: 3px;">✕</button>
        </div>
        <p style="font-size: 13px; margin-bottom: 16px; color: var(--text-muted);">車を離れる際や一時停止時にCPU/GPU負荷を0%に凍結します。</p>
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <button id="power-quick-stop-btn" class="btn btn-danger" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 14px; font-weight: 700; border-radius: 4px;">
            ${ICONS.stop} ワンタップ停止 (省電力スタンバイ)
          </button>
          <button id="power-browser-restart-btn" class="btn btn-secondary" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 14px; font-weight: 600; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.18);">
            ${ICONS.refresh} ブラウザ＆配信再起動
          </button>
        </div>
      </div>
    `;

    const closePowerModal = () => {
      overlay.remove();
      resetHudDimTimer();
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closePowerModal();
      }
    });

    overlay.querySelector('#power-modal-close-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closePowerModal();
    });

    const token =
      authToken ||
      localStorage.getItem('tesroid_token') ||
      sessionStorage.getItem('tesroid_token') ||
      '';

    overlay.querySelector('#power-quick-stop-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      resetHudDimTimer();
      closePowerModal();
      triggerStop();
    });

    overlay.querySelector('#power-browser-restart-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      resetHudDimTimer();
      closePowerModal();
      browserRestart(token);
    });

    container.appendChild(overlay);
    resetHudDimTimer();
  };

  document.getElementById('hud-stop-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    resetHudDimTimer();
    openPowerModal();
  });

  const resetClientStreamPipeline = (
    reasonTitle = '配信プロセスを再起動中...',
    reasonDesc = 'クリーンな映像・音声ストリームを再構築しています...',
  ) => {
    decoder.reset();
    if (typeof framePacer.reset === 'function') {
      framePacer.reset();
    } else {
      framePacer.resetFirstFrame();
    }
    audioPlayer.resetJitterBuffer();
    jitterController.reset();
    renderer.resetFirstFrame();
    avSync.reset();
    lastDecodedPts = 0;
    lastAckSentPts = -1;
    serverCatchupQueueMs = 0;
    serverBufferMs = 0;
    serverMode = 'LIVE';
    updateHudLiveStatus();
    if (browserPowerState !== 'sleeping') {
      showOverlay(reasonTitle, reasonDesc, true);
    }
  };

  const onStreamResetEvent = () => {
    resetClientStreamPipeline();
  };
  window.addEventListener('tesroid:stream-reset', onStreamResetEvent);

  const handleControl = (msg: any) => {
    lastPacketReceivedTime = performance.now();
    if (msg.type === 'PONG') {
      const now = performance.now();
      const rawRtt = Math.max(1, Math.round(now - msg.clientTime));

      if (typeof msg.catchupQueueMs === 'number') {
        serverCatchupQueueMs = Math.max(0, msg.catchupQueueMs);
      }
      if (typeof msg.serverBufferMs === 'number') {
        serverBufferMs = Math.max(0, msg.serverBufferMs);
      }
      if (msg.serverMode === 'CATCHUP' || msg.serverMode === 'LIVE') {
        serverMode = msg.serverMode;
      }

      // 瞬間ネットワーク往復時間（Instantaneous RTT）の測定と表示 (Issue 24):
      // バッファ蓄積中（CATCHUP中やサーバー送出キュー滞留時）は、単一WebSocket内のパケット待ち行列遅延によって
      // rawRtt が肥大化するため、キュー滞留時間と回線自体の遅延（物理RTT）を明確に分離する。
      const hasQueueDelay = serverMode === 'CATCHUP' || serverCatchupQueueMs > 0;
      if (!hasQueueDelay) {
        rttHistory.push(rawRtt);
        if (rttHistory.length > RTT_HISTORY_WINDOW_SIZE) rttHistory.shift();
        minRtt = rttHistory.length > 0 ? Math.min(...rttHistory) : rawRtt;
        instantRtt = instantRtt === 0 ? rawRtt : Math.round(instantRtt * 0.7 + rawRtt * 0.3);
      } else {
        // CATCHUP中は直近の有効な物理RTTまたは安定値を維持し、回線状態指標の肥大化を防ぐ。
        // 初回起動直後かつ最初から CATCHUP 状態であった場合（instantRtt未決定時）は、
        // 過去の最小物理RTT（minRtt）またはフォールバック値を使用する。
        if (instantRtt === 0) {
          instantRtt = Number.isFinite(minRtt) ? minRtt : rawRtt;
        }
      }
      metricsCollector.updateRtt(instantRtt);
      jitterController.updateRtt(instantRtt);

      updateHudConnStatus();
      updateHudLiveStatus();
    } else if (msg.type === 'AUTH_SUCCESS') {
      sendBufferFeedback(true);
    } else if (msg.type === 'LIVE_JUMPED') {
      serverCatchupQueueMs = 0;
      serverBufferMs = 0;
      serverMode = 'LIVE';
      updateHudLiveStatus();
    } else if (msg.type === 'STREAM_RESET') {
      resetClientStreamPipeline(
        '配信プロセスを再起動中...',
        'エンコーダとバッファをクリーンに再初期化しています...',
      );
    } else if (msg.type === 'BROWSER_STATUS') {
      if (healthBrowser) {
        if (msg.state === 'paused') {
          healthBrowser.innerHTML = `<span class="status-dot status-idle"></span> Browser: 一時停止`;
          showSleepingScreen();
        } else if (msg.state === 'running') {
          healthBrowser.innerHTML = `<span class="status-dot status-online"></span> Browser: 稼働中`;
          browserPowerState = 'active';
        } else {
          healthBrowser.innerHTML = `<span class="status-dot status-idle"></span> Browser: ${msg.state}`;
        }
      }
    } else if (msg.type === 'SERVER_METRICS') {
      if (msg.browserState === 'paused') {
        showSleepingScreen();
      }
    } else if (msg.type === 'RESOLUTION_CHANGED') {
      console.log(`[StreamingView] Server resolution updated to ${msg.width}x${msg.height}`);
    }
  };

  let disconnectSurvivalTimer: any = null;
  let lastReportedBufferedMs = -1;

  const sendBufferFeedback = (force = false) => {
    if (!wsClient.isConnected()) return;

    const pendingBufferedMs =
      typeof decoder.getPendingBufferedMs === 'function' ? decoder.getPendingBufferedMs() : 0;
    const pacerBufferedMs =
      typeof framePacer.getBufferedDurationMs === 'function'
        ? framePacer.getBufferedDurationMs()
        : 0;
    const totalBufferedMs = pendingBufferedMs + pacerBufferedMs;
    const isInteractive = latencyController.getMode() === 'ACTIVE_INTERACTION';

    const actualRenderedPts =
      typeof framePacer.getLastRenderedPtsUs === 'function' ? framePacer.getLastRenderedPtsUs() : 0;
    const reportedPts =
      actualRenderedPts > 0 ? actualRenderedPts : lastDecodedPts > 0 ? lastDecodedPts : undefined;

    const ptsChanged = reportedPts !== undefined && reportedPts !== lastAckSentPts;
    const bufferDelta = Math.abs(totalBufferedMs - lastReportedBufferedMs);

    if (!force && !ptsChanged && bufferDelta < 250) return;

    wsClient.send(
      ClientProtocol.packBufferFeedback({
        bufferedMs: totalBufferedMs,
        targetBufferMs,
        lastRenderedPts: reportedPts,
        isInteractive,
      }),
    );
    if (reportedPts !== undefined) {
      lastAckSentPts = reportedPts;
    }
    lastReportedBufferedMs = totalBufferedMs;
  };

  const handleOpen = () => {
    if (disconnectSurvivalTimer) {
      clearTimeout(disconnectSurvivalTimer);
      disconnectSurvivalTimer = null;
    }

    const pendingBufferedMs =
      typeof decoder.getPendingBufferedMs === 'function' ? decoder.getPendingBufferedMs() : 0;
    const pacerBufferedMs =
      typeof framePacer.getBufferedDurationMs === 'function'
        ? framePacer.getBufferedDurationMs()
        : 0;
    const totalBufferedMs = pendingBufferedMs + pacerBufferedMs;

    if (totalBufferedMs <= 0) {
      decoder.reset();
      jitterController.reset();
    } else {
      console.log(
        `[StreamingView] Reconnected with ${totalBufferedMs}ms buffer active. Seamlessly resuming...`,
      );
    }

    lastPacketReceivedTime = performance.now();
    instantRtt = 0;
    minRtt = Number.POSITIVE_INFINITY;
    rttHistory = [];

    if (connText) connText.textContent = '接続中';
    if (connDot) connDot.className = 'status-dot status-online';
    if (hudConn) hudConn.title = '接続状態: 接続中 (RTT計測待機)';
    if (browserPowerState === 'sleeping') {
      showSleepingScreen();
    } else if (totalBufferedMs <= 0) {
      showOverlay('画面配信準備中...', '映像ストリームを待機しています...', true);
    } else {
      hideOverlay();
    }

    // Send immediate ping and buffer feedback so RTT and server buffer metrics update instantly!
    pingId++;
    wsClient.send(ClientProtocol.packPing(pingId));
    sendBufferFeedback(true);
  };

  const handleClose = () => {
    if (connText) connText.textContent = '一時切断';
    if (connDot) connDot.className = 'status-dot status-warning';
    if (hudConn) hudConn.title = '接続状態: 一時切断';

    const pendingBufferedMs =
      typeof decoder.getPendingBufferedMs === 'function' ? decoder.getPendingBufferedMs() : 0;
    const pacerBufferedMs =
      typeof framePacer.getBufferedDurationMs === 'function'
        ? framePacer.getBufferedDurationMs()
        : 0;
    const totalBufferedMs = pendingBufferedMs + pacerBufferedMs;

    if (totalBufferedMs > 250) {
      // Survive temporary network drops by playing through local prefetch buffer
      console.log(
        `[StreamingView] Disconnected, surviving stall with ${totalBufferedMs}ms local prefetch buffer...`,
      );
      if (disconnectSurvivalTimer) clearTimeout(disconnectSurvivalTimer);
      disconnectSurvivalTimer = setTimeout(() => {
        disconnectSurvivalTimer = null;
        if (!wsClient.isConnected()) {
          decoder.reset();
          jitterController.reset();
          renderer.resetFirstFrame();
          framePacer.resetFirstFrame();
          avSync.reset();
          if (connText) connText.textContent = '切断';
          if (connDot) connDot.className = 'status-dot status-offline';
          if (hudConn) hudConn.title = '接続状態: 切断';
          showOverlay('サーバーと切断されました', '自動再接続を試行しています...', true);
        }
      }, totalBufferedMs);
    } else {
      decoder.reset();
      jitterController.reset();
      renderer.resetFirstFrame();
      framePacer.resetFirstFrame();
      avSync.reset();
      if (connText) connText.textContent = '切断';
      if (connDot) connDot.className = 'status-dot status-offline';
      if (hudConn) hudConn.title = '接続状態: 切断';
      showOverlay('サーバーと切断されました', '自動再接続を試行しています...', true);
    }
  };

  wsClient.on('video', handleVideo);
  wsClient.on('audio', handleAudio);
  wsClient.on('control', handleControl);
  wsClient.on('open', handleOpen);
  wsClient.on('close', handleClose);

  // 6. Ping / Pong loop for RTT measurement and buffer status update
  const pingTimer = setInterval(() => {
    pingId++;
    wsClient.send(ClientProtocol.packPing(pingId));
  }, 1000);

  // 6.1. Periodic Buffer Feedback & Flow Control Loop (250msごとに残量・再生PTSフィードバック & 通信状態評価)
  const ackTimer = setInterval(() => {
    if (wsClient.isConnected()) {
      sendBufferFeedback();
      updateHudConnStatus();
    }
  }, 250);

  // 7. HUD Status Loop
  const hudTimer = setInterval(() => {
    const fps = renderer.getFps();
    const lastRenderElapsed = performance.now() - renderer.getLastRenderTime();

    metricsCollector.updateDecodeQueueSize(decoder.getDecodeQueueSize());
    metricsCollector.updateAvDrift(avSync.getDriftMs());

    const jitterDelay = jitterController.getCurrentDelayMs();

    let targetFpsText = '';
    let targetFpsColor = '';
    let targetFpsTitle = '';

    if (lastRenderElapsed > 1500) {
      targetFpsText = '静止中';
      targetFpsColor = '#8e8e93';
      targetFpsTitle = '実測描画フレームレート';
    } else {
      targetFpsText = `${fps} FPS`;
      const healthyThreshold = Math.round(targetFps * 0.8);
      targetFpsColor = fps >= healthyThreshold ? '#34c759' : '#ff9500';
      targetFpsTitle =
        jitterDelay > 0
          ? `実測描画フレームレート (ジッタバッファ: +${jitterDelay}ms)`
          : '実測描画フレームレート';
    }

    setTextIfChanged(fpsBadge, targetFpsText);
    setColorIfChanged(fpsBadge, targetFpsColor);
    setTitleIfChanged(fpsBadge, targetFpsTitle);

    updateHudConnStatus();
    updateHudLiveStatus();

    // Audio Autoplay & Unlock Guidance for Tesla Browser
    const audioStats = audioPlayer.getStats();
    if (audioStats.packetsReceived > 0 && audioStats.state === 'suspended') {
      if (!hasPromptedAudioUnlock) {
        hasPromptedAudioUnlock = true;
        showToast('画面をタップすると音声を再生します', 'info');
      }
    }
  }, 1000);

  // 8. Navigation & Controls
  document.getElementById('hud-back-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    wsClient.send(ClientProtocol.packCommand({ type: 'NAVIGATE_BACK' }));
  });

  document.getElementById('hud-home-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    wsClient.send(ClientProtocol.packCommand({ type: 'NAVIGATE', url: 'https://www.youtube.com' }));
  });

  // Search / Text Input Bar Handlers (Direct YouTube Search Navigation)
  const searchForm = document.getElementById('hud-search-form') as HTMLFormElement;
  const searchInput = document.getElementById('hud-search-input') as HTMLInputElement;

  searchForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = searchInput.value.trim();
    if (text) {
      const searchUrl = /^https?:\/\//i.test(text)
        ? text
        : `https://www.youtube.com/results?search_query=${encodeURIComponent(text)}`;
      wsClient.send(
        ClientProtocol.packCommand({
          type: 'NAVIGATE',
          url: searchUrl,
        }),
      );
      searchInput.value = '';
      searchInput.blur();
      showToast(`YouTube検索へ移動中: "${text}"`, 'info');
    }
  });

  searchInput?.addEventListener('focus', () => {
    searchInput.style.width = '160px';
    searchInput.style.borderColor = '#3e6ae1';
  });
  searchInput?.addEventListener('blur', () => {
    searchInput.style.width = '120px';
    searchInput.style.borderColor = 'rgba(255, 255, 255, 0.2)';
  });

  // Virtual Keyboard Drawer Handlers (In-Car Tesla On-Screen Keyboard)
  const kbdBtn = document.getElementById('hud-keyboard-btn') as HTMLButtonElement | null;
  const kbdDrawer = document.getElementById('hud-keyboard-drawer') as HTMLElement | null;
  const kbdForm = document.getElementById('hud-keyboard-form') as HTMLFormElement | null;
  const kbdInput = document.getElementById('hud-keyboard-input') as HTMLInputElement | null;
  const kbdEnterBtn = document.getElementById('hud-keyboard-enter-btn') as HTMLButtonElement | null;
  const kbdBackspaceBtn = document.getElementById(
    'hud-keyboard-backspace-btn',
  ) as HTMLButtonElement | null;
  const kbdTabBtn = document.getElementById('hud-keyboard-tab-btn') as HTMLButtonElement | null;
  const kbdCloseBtn = document.getElementById('hud-keyboard-close-btn') as HTMLButtonElement | null;

  const toggleKeyboardDrawer = (show?: boolean) => {
    if (!kbdDrawer || !kbdBtn) return;
    const isCurrentlyOpen = kbdDrawer.style.display !== 'none';
    const nextState = show !== undefined ? show : !isCurrentlyOpen;

    if (nextState) {
      kbdDrawer.style.display = 'flex';
      kbdBtn.classList.add('is-active');
      // Synchronous focus preserves user gesture context for Tesla OSK popup
      kbdInput?.focus();
    } else {
      kbdDrawer.style.display = 'none';
      kbdBtn.classList.remove('is-active');
      kbdInput?.blur();
    }
  };

  kbdBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleKeyboardDrawer();
  });

  kbdCloseBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleKeyboardDrawer(false);
  });

  const sendTypedText = (text: string, enter = false) => {
    if (!text) return;
    wsClient.send(ClientProtocol.packCommand({ type: 'TYPE_TEXT', text, enter }));
    showToast(enter ? `送信 & 決定: "${text}"` : `送信: "${text}"`, 'info', 1500);
  };

  kbdForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!kbdInput) return;
    const text = kbdInput.value;
    if (text) {
      // OSK Enter / Form submission defaults to enter: true for seamless search / next action
      sendTypedText(text, true);
      kbdInput.value = '';
    }
  });

  // Explicit 'Send' button sends text only (enter: false)
  document.getElementById('hud-keyboard-send-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!kbdInput) return;
    const text = kbdInput.value;
    if (text) {
      sendTypedText(text, false);
      kbdInput.value = '';
    }
  });

  kbdEnterBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (kbdInput && kbdInput.value) {
      const text = kbdInput.value;
      kbdInput.value = '';
      sendTypedText(text, true);
    } else {
      wsClient.send(ClientProtocol.packCommand({ type: 'SEND_KEY', key: 'Enter' }));
      showToast('Enter ⏎', 'info', 1000);
    }
  });

  kbdBackspaceBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    wsClient.send(ClientProtocol.packCommand({ type: 'SEND_KEY', key: 'Backspace' }));
  });

  kbdTabBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    wsClient.send(ClientProtocol.packCommand({ type: 'SEND_KEY', key: 'Tab' }));
    showToast('Tab ⇥ (フォーカス移動)', 'info', 1000);
  });

  // Tap-to-resume handlers
  let lastResumeTrigger = 0;
  const onOverlayTap = (e: Event) => {
    if (
      (e.target as HTMLElement).id === 'notice-action-btn' ||
      (e.target as HTMLElement).id === 'notice-disconnect-btn'
    )
      return;
    if (browserPowerState === 'sleeping') {
      const now = performance.now();
      if (now - lastResumeTrigger < 800) return;
      lastResumeTrigger = now;
      triggerResume();
    }
  };

  statusOverlay.addEventListener('pointerdown', onOverlayTap);
  statusOverlay.addEventListener('click', onOverlayTap);

  noticeActionBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const now = performance.now();
    if (now - lastResumeTrigger < 800) return;
    lastResumeTrigger = now;
    triggerResume();
  });

  noticeDisconnectBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    wsClient.close();
    window.location.reload();
  });

  // Settings
  document.getElementById('hud-settings-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    onOpenSettings();
  });

  // Cleanup function when navigating away
  return () => {
    if (disconnectSurvivalTimer) clearTimeout(disconnectSurvivalTimer);
    if (encoderRestartTimer) clearTimeout(encoderRestartTimer);
    isRestartingEncoder = false;
    document.getElementById('power-menu-modal')?.remove();
    if (hudDimTimer) clearTimeout(hudDimTimer);
    window.removeEventListener('pointermove', resetHudDimTimer);
    window.removeEventListener('pointerdown', resetHudDimTimer);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('tesroid:settings-updated', onSettingsUpdated);
    window.removeEventListener('tesroid:stream-reset', onStreamResetEvent);
    if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
    clearInterval(pingTimer);
    clearInterval(ackTimer);
    clearInterval(hudTimer);
    wsClient.off('video', handleVideo);
    wsClient.off('audio', handleAudio);
    wsClient.off('control', handleControl);
    wsClient.off('open', handleOpen);
    wsClient.off('close', handleClose);
    telemetryCollector.destroy();
    metricsCollector.destroy();
    jitterController.destroy();
    framePacer.destroy();
    decoder.close();
    touchMapper.destroy();
  };
}
