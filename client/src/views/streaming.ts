import { WsClient } from '../transport/ws-client.js';
import { ClientProtocol } from '../transport/protocol.js';
import { CanvasRenderer } from '../core/canvas-renderer.js';
import { FramePacer } from '../core/frame-pacer.js';
import { VideoStreamDecoder } from '../core/decoder.js';
import { AudioPlayer } from '../core/audio-player.js';
import { AvSyncController } from '../core/av-sync.js';
import { DynamicLatencyController, LatencyMode } from '../core/latency.js';
import { TouchMapper } from '../input/touch-mapper.js';
import { MetricsCollector } from '../core/metrics.js';
import { AdaptiveJitterController } from '../core/adaptive-jitter.js';
import { ICONS, showToast } from './icons.js';
import { sleep, resume, encoderRestart, browserRestart } from './power-actions.js';

export function renderStreamingView(
  container: HTMLElement,
  wsClient: WsClient,
  audioPlayer: AudioPlayer,
  avSync: AvSyncController,
  onOpenSettings: () => void,
  authToken?: string | null
): () => void {
  container.innerHTML = `
    <div id="screen-container">
      <!-- Dedicated Stream Viewport above the Bottom HUD Dock -->
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

      <!-- Dedicated Bottom HUD Dock Bar (Browser Controls) -->
      <div id="stream-hud" class="stream-hud">
        <!-- Collapse / Expand Toggle Button -->
        <button id="hud-toggle-btn" class="hud-btn" title="HUDバー展開/最小化" style="font-weight: 700; font-size: 13px;">HUD</button>

        <!-- Connection Status & RTT -->
        <span id="hud-conn" class="hud-badge" title="接続状態と遅延往復時間">
          <span id="hud-conn-dot" class="status-dot status-online"></span>
          <span id="hud-conn-text">--ms</span>
        </span>

        <!-- Playback Mode / Catch-up Buffer Status & One-Tap Jump to LIVE -->
        <button id="hud-live-btn" class="hud-live-btn" title="再生状態 / タップで未再生バッファを破棄して最新LIVE映像へジャンプ">
          <span id="hud-live-dot" class="status-dot status-online"></span>
          <span id="hud-live-text">LIVE</span>
        </button>

        <!-- Render FPS -->
        <span id="hud-fps" class="hud-badge hud-collapsible" title="実測描画フレームレート">-- FPS</span>

        <!-- Stream Quality Quick Toggles -->
        <button id="hud-fps-toggle" class="hud-pill-btn hud-collapsible" title="フレームレート切替 (タップで 30 / 60 切替)">
          ${ICONS.zap} <span id="hud-fps-val">30</span>
        </button>
        <button id="hud-bitrate-toggle" class="hud-pill-btn hud-collapsible" title="ビットレート切替 (タップで 0.5M 〜 2.0M 切替)">
          ${ICONS.signal} <span id="hud-bitrate-val">1.0M</span>
        </button>

        <!-- Browser Navigation Controls -->
        <div class="hud-divider hud-collapsible"></div>
        <button id="hud-back-btn" class="hud-btn hud-collapsible" title="戻る (Back)">${ICONS.back}</button>
        <button id="hud-reload-btn" class="hud-btn hud-collapsible" title="再読み込み (Reload)">${ICONS.reload}</button>
        <button id="hud-home-btn" class="hud-btn hud-collapsible" title="YouTube ホーム (Home)">${ICONS.home}</button>

        <!-- Media Fullscreen Toggle & Window Fit Toggle -->
        <button id="hud-cinema-btn" class="hud-pill-btn hud-collapsible" title="動画全画面切替 (YouTubeプレイヤー拡大)">${ICONS.cinema} 全画面</button>
        <button id="hud-fit-toggle" class="hud-btn hud-collapsible" title="画面フィット切替">${ICONS.fullscreen}</button>

        <!-- Audio Mute Quick Toggle -->
        <button id="hud-mute-btn" class="hud-btn hud-collapsible" title="音声ミュート切替">${ICONS.volume}</button>

        <!-- YouTube Search Box (Direct Search Page Navigation) -->
        <div class="hud-divider hud-collapsible"></div>
        <form id="hud-search-form" class="hud-collapsible" style="display: flex; align-items: center; gap: 4px; margin: 0;">
          <input
            id="hud-search-input"
            type="text"
            placeholder="YouTube検索..."
            autocomplete="off"
            style="
              background: rgba(0, 0, 0, 0.45);
              border: 1px solid rgba(255, 255, 255, 0.2);
              border-radius: 8px;
              color: #fff;
              padding: 6px 10px;
              font-size: 13px;
              width: 115px;
              outline: none;
              transition: all 0.2s;
            "
          />
          <button id="hud-search-btn" class="hud-btn" type="submit" title="YouTube検索を実行" style="padding: 6px 10px;">${ICONS.search}</button>
        </form>

        <!-- Always visible Power & Stop Button -->
        <div class="hud-divider"></div>
        <button id="hud-stop-btn" class="hud-btn hud-stop-btn" title="省電力 & リソース制御">${ICONS.stop} 停止</button>

        <!-- Settings Console Trigger -->
        <button id="hud-settings-btn" class="hud-btn hud-collapsible" title="設定コンソール">${ICONS.settings}</button>
      </div>
    </div>
  `;

  const canvas = document.getElementById('stream-canvas') as HTMLCanvasElement;
  const streamViewport = document.getElementById('stream-viewport') as HTMLElement;
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

  let currentRtt = 0;
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
  const hudToggleBtn = document.getElementById('hud-toggle-btn') as HTMLButtonElement;
  const hudMuteBtn = document.getElementById('hud-mute-btn') as HTMLButtonElement;
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

  hudToggleBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!streamHud) return;
    const isCollapsed = streamHud.classList.toggle('collapsed');
    hudToggleBtn.textContent = isCollapsed ? 'MENU' : 'HUD';
    hudToggleBtn.title = isCollapsed ? 'HUDバーを展開' : 'HUDバーを最小化';
    resetHudDimTimer();
  });

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

  // Mute button handler
  hudMuteBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await audioPlayer.unlock();
    const isMuted = audioPlayer.toggleMute();
    hudMuteBtn.innerHTML = isMuted ? ICONS.volumeMute : ICONS.volume;
    showToast(isMuted ? '音声をミュートしました' : '音声ミュートを解除しました', 'info');
  });

  // 1. Core Streaming Pipeline
  const metricsCollector = new MetricsCollector();
  metricsCollector.onReport = (metrics) => {
    if (wsClient.isConnected()) {
      wsClient.send(ClientProtocol.packMetrics(metrics));
    } else {
      const token = authToken || localStorage.getItem('tesroid_token') || sessionStorage.getItem('tesroid_token');
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
  const effectiveToken = authToken || localStorage.getItem('tesroid_token') || sessionStorage.getItem('tesroid_token');
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
      const token = authToken || localStorage.getItem('tesroid_token') || sessionStorage.getItem('tesroid_token');
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
          })
        );
        showToast(`画質設定を更新しました: ${currentFps}FPS / ${formatBitrateLabel(currentBitrate)}`, 'success');
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
    if (changed) {
      updateToggleButtons();
    }
  };
  window.addEventListener('tesroid:settings-updated', onSettingsUpdated);

  let lastDecodedPts = 0;
  let lastAckSentPts = -1;
  let serverCatchupQueueMs = 0;
  let serverMode: 'LIVE' | 'CATCHUP' = 'LIVE';

  const decoder = new VideoStreamDecoder(
    (frame: VideoFrame) => {
      metricsCollector.recordFrameRendered();
      framePacer.queueFrame(frame);
      hideOverlay();
    },
    (ptsUs: number) => {
      lastDecodedPts = ptsUs;
      avSync.updateVideoPts(ptsUs);
    }
  );

  if (typeof decoder.setDownstreamQueueLengthProvider === 'function') {
    decoder.setDownstreamQueueLengthProvider(() =>
      typeof framePacer.getQueueLength === 'function' ? framePacer.getQueueLength() : 0
    );
  }

  framePacer.onFrameProcessed = () => {
    if (typeof decoder.pumpPendingPackets === 'function') {
      decoder.pumpPendingPackets();
    }
    if (typeof audioPlayer.syncWithVideo === 'function') {
      audioPlayer.syncWithVideo();
    }
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
    const pacerBufferedMs = typeof framePacer.getBufferedDurationMs === 'function' ? framePacer.getBufferedDurationMs() : 0;
    const decoderBufferedMs = typeof decoder.getPendingBufferedMs === 'function' ? decoder.getPendingBufferedMs() : 0;
    const audioBufferedMs = typeof audioPlayer.getBufferedAudioMs === 'function' ? audioPlayer.getBufferedAudioMs() : 0;
    // Notice: Do NOT use raw `(serverLatestPts - lastDecodedPts)` as "buffered behind" because on a static screen
    // FFmpeg does not emit new frames while server wall-clock advances, which previously caused false 2-3s catch-up display!
    const clientBufferedMs = Math.max(pacerBufferedMs + decoderBufferedMs, Math.max(0, audioBufferedMs - 160));
    return clientBufferedMs + serverCatchupQueueMs;
  };

  const updateHudLiveStatus = () => {
    if (!hudLiveBtn || !hudLiveText || !hudLiveDot) return;

    const totalBehindMs = getTotalBufferedBehindMs();
    const isBuffering = typeof framePacer.getIsBuffering === 'function' ? framePacer.getIsBuffering() : false;
    const isInteractive = typeof framePacer.getMode === 'function' && framePacer.getMode() === 'ACTIVE_INTERACTION';

    hudLiveBtn.classList.remove('is-catchup', 'is-buffering');

    if (isBuffering) {
      hudLiveBtn.classList.add('is-buffering');
      hudLiveDot.className = 'status-dot status-warning';
      const sec = (Math.max(100, totalBehindMs) / 1000).toFixed(1);
      hudLiveText.textContent = `⏳ 受信待機中 (-${sec}s)`;
      hudLiveBtn.title = 'パケット詰まり検知により安定受信まで一時待機中 (タップで即LIVEへジャンプ)';
    } else if (totalBehindMs >= 450 || serverMode === 'CATCHUP') {
      hudLiveBtn.classList.add('is-catchup');
      hudLiveDot.className = 'status-dot status-warning';
      const sec = (Math.max(500, totalBehindMs) / 1000).toFixed(1);
      hudLiveText.textContent = `⏪ 追っかけ -${sec}s · LIVEへ`;
      hudLiveBtn.title = `等倍(1x)追っかけ再生中 (遅延 ${sec}秒) — タップでバッファを破棄して最新LIVEへ戻る`;
    } else if (isInteractive) {
      hudLiveDot.className = 'status-dot status-online';
      hudLiveText.textContent = '⚡ 操作優先 LIVE';
      hudLiveBtn.title = '自動ハイブリッド: 画面操作中のためバッファゼロ・超低遅延モードで動作中';
    } else {
      hudLiveDot.className = 'status-dot status-online';
      const cushionMs = typeof framePacer.getAutoCushionMs === 'function' ? framePacer.getAutoCushionMs() : 0;
      hudLiveText.textContent = cushionMs > 50 ? `LIVE (+${Math.round(cushionMs)}ms)` : 'LIVE';
      hudLiveBtn.title = 'リアルタイム再生中 (タップで最新フレームへ同期)';
    }
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
    serverMode = 'LIVE';
    if (wsClient.isConnected()) {
      wsClient.send(ClientProtocol.packCommand({ type: 'JUMP_TO_LIVE' }));
    }
    updateHudLiveStatus();
    if (!silent) {
      showToast('未再生バッファを破棄し、最新LIVE映像へ同期しました', 'info');
    }
  };

  hudLiveBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    resetHudDimTimer();
    executeJumpToLive(false);
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
    metricsCollector.recordVideoPacket(msg.data.byteLength);
    jitterController.recordVideoArrival();
    decoder.handlePacket(msg.flags, msg.pts, msg.data);
    if (healthStream) {
      healthStream.innerHTML = `<span class="status-dot status-online"></span> 配信: 送信中`;
    }
  };

  const handleAudio = (msg: { flags: number; pts: bigint; data: Uint8Array }) => {
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
    showOverlay('省電力一時停止中 (CPU/GPU 0%)', 'ブラウザと配信は休止中です。再開ボタンまたは画面タップで即時復帰します。', false);
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
      <div class="card" style="max-width: 440px; width: 90%; max-height: 85vh; overflow-y: auto; position: relative;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <h3 style="margin: 0; font-size: 17px; display: flex; align-items: center; gap: 8px;">
            ${ICONS.power} 省電力 & リソース制御
          </h3>
          <button id="power-modal-close-btn" class="hud-btn" style="font-size: 18px; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center;">✕</button>
        </div>
        <p style="font-size: 13px; margin-bottom: 16px; color: var(--text-muted);">車を離れる際や一時停止時にCPU/GPU負荷を0%に凍結します。</p>
        <div style="display: flex; flex-direction: column; gap: 10px;">
          <button id="power-quick-stop-btn" class="btn btn-danger" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px; font-weight: 700;">
            ${ICONS.stop} ワンタップ停止
          </button>
          <div style="display: flex; gap: 10px; flex-wrap: wrap;">
            <button id="power-sleep-btn" class="btn btn-secondary" style="flex: 1; min-width: 140px; display: flex; align-items: center; justify-content: center; gap: 6px;">
              ${ICONS.pause} 一時停止 (CPU 0%)
            </button>
            <button id="power-resume-btn" class="btn btn-primary" style="flex: 1; min-width: 140px; display: flex; align-items: center; justify-content: center; gap: 6px;">
              ${ICONS.play} 再開 (Resume)
            </button>
            <button id="power-encoder-restart-btn" class="btn btn-secondary" style="flex: 1; min-width: 140px; display: flex; align-items: center; justify-content: center; gap: 6px;" title="通信瞬断等による映像ノイズを修復するために動画エンコーダを再起動します">
              ${ICONS.zap} 再エンコード
            </button>
            <button id="power-browser-restart-btn" class="btn btn-danger" style="flex: 1; min-width: 140px; display: flex; align-items: center; justify-content: center; gap: 6px;">
              ${ICONS.refresh} ブラウザ再起動
            </button>
          </div>
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

    const token = authToken || localStorage.getItem('tesroid_token') || sessionStorage.getItem('tesroid_token') || '';

    overlay.querySelector('#power-quick-stop-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      resetHudDimTimer();
      closePowerModal();
      triggerStop();
    });

    overlay.querySelector('#power-sleep-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      resetHudDimTimer();
      sleep(token);
    });

    overlay.querySelector('#power-resume-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      resetHudDimTimer();
      resume(token);
    });

    overlay.querySelector('#power-encoder-restart-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      resetHudDimTimer();
      encoderRestart(token);
    });

    overlay.querySelector('#power-browser-restart-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      resetHudDimTimer();
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

  const resetClientStreamPipeline = (reasonTitle = '配信プロセスを再起動中...', reasonDesc = 'クリーンな映像・音声ストリームを再構築しています...') => {
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
    if (msg.type === 'PONG') {
      const now = performance.now();
      currentRtt = Math.max(1, Math.round(now - msg.clientTime));
      metricsCollector.updateRtt(currentRtt);
      jitterController.updateRtt(currentRtt);
      if (typeof msg.catchupQueueMs === 'number') {
        serverCatchupQueueMs = msg.catchupQueueMs;
      }
      if (msg.serverMode === 'CATCHUP' || msg.serverMode === 'LIVE') {
        serverMode = msg.serverMode;
      }
      if (connText) connText.textContent = `${currentRtt}ms`;
      if (connDot) {
        connDot.className = currentRtt < 90 ? 'status-dot status-online' : 'status-dot status-warning';
      }
      updateHudLiveStatus();
    } else if (msg.type === 'STREAM_RESET') {
      resetClientStreamPipeline('配信プロセスを再起動中...', 'エンコーダとバッファをクリーンに再初期化しています...');
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

  const handleOpen = () => {
    decoder.reset();
    jitterController.reset();
    if (connText) connText.textContent = '接続中';
    if (connDot) connDot.className = 'status-dot status-online';
    if (browserPowerState === 'sleeping') {
      showSleepingScreen();
    } else {
      showOverlay('画面配信準備中...', '映像ストリームを待機しています...', true);
    }
    // 再接続時に手元の最新デコード済み PTS があれば直ちに ACK を送付
    if (lastDecodedPts > 0) {
      wsClient.send(ClientProtocol.packAck(lastDecodedPts));
      lastAckSentPts = lastDecodedPts;
    }
  };

  const handleClose = () => {
    decoder.reset();
    jitterController.reset();
    renderer.resetFirstFrame();
    framePacer.resetFirstFrame();
    avSync.reset();
    if (connText) connText.textContent = '切断';
    if (connDot) connDot.className = 'status-dot status-offline';
    showOverlay('サーバーと切断されました', '自動再接続を試行しています...', true);
  };

  wsClient.on('video', handleVideo);
  wsClient.on('audio', handleAudio);
  wsClient.on('control', handleControl);
  wsClient.on('open', handleOpen);
  wsClient.on('close', handleClose);

  // 6. Ping / Pong loop for RTT measurement
  const pingTimer = setInterval(() => {
    pingId++;
    wsClient.send(ClientProtocol.packPing(pingId));
  }, 2000);

  // 6.1. Periodic ACK loop (約2秒ごとにデコード済み video PTS を送信)
  const ackTimer = setInterval(() => {
    if (wsClient.isConnected() && lastDecodedPts > 0 && lastDecodedPts !== lastAckSentPts) {
      lastAckSentPts = lastDecodedPts;
      wsClient.send(ClientProtocol.packAck(lastDecodedPts));
    }
  }, 2000);

  // 7. HUD Status Loop
  const hudTimer = setInterval(() => {
    const fps = renderer.getFps();
    const lastRenderElapsed = performance.now() - renderer.getLastRenderTime();

    metricsCollector.updateDecodeQueueSize(decoder.getDecodeQueueSize());
    metricsCollector.updateAvDrift(avSync.getDriftMs());

    const jitterDelay = jitterController.getCurrentDelayMs();

    if (lastRenderElapsed > 1500) {
      fpsBadge.textContent = '静止中';
      fpsBadge.style.color = '#8e8e93';
      fpsBadge.title = '実測描画フレームレート';
    } else {
      fpsBadge.textContent = `${fps} FPS`;
      const healthyThreshold = Math.round(targetFps * 0.8);
      fpsBadge.style.color = fps >= healthyThreshold ? '#34c759' : '#ff9500';
      fpsBadge.title = jitterDelay > 0 ? `実測描画フレームレート (ジッタバッファ: +${jitterDelay}ms)` : '実測描画フレームレート';
    }

    updateHudLiveStatus();

    // Audio Autoplay & Unlock Guidance for Tesla Browser
    const audioStats = audioPlayer.getStats();
    if (audioStats.packetsReceived > 0 && audioStats.state === 'suspended') {
      if (hudMuteBtn) {
        hudMuteBtn.style.color = '#ff9500';
        hudMuteBtn.title = 'タップして音声を再生';
      }
      if (!hasPromptedAudioUnlock) {
        hasPromptedAudioUnlock = true;
        showToast('画面または音量アイコンをタップすると音声を再生します', 'info');
      }
    } else if (hudMuteBtn && audioStats.state === 'running') {
      hudMuteBtn.style.color = '';
      hudMuteBtn.title = audioStats.isMuted ? 'ミュート中 (タップで解除)' : '音声ミュート切替';
    }
  }, 1000);

  // 8. Navigation & Controls
  document.getElementById('hud-back-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    wsClient.send(ClientProtocol.packCommand({ type: 'NAVIGATE_BACK' }));
  });

  document.getElementById('hud-reload-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    wsClient.send(ClientProtocol.packCommand({ type: 'RELOAD' }));
  });

  document.getElementById('hud-home-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    wsClient.send(ClientProtocol.packCommand({ type: 'NAVIGATE', url: 'https://www.youtube.com' }));
  });

  document.getElementById('hud-cinema-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    wsClient.send(ClientProtocol.packCommand({ type: 'TOGGLE_CINEMA' }));
  });

  // Dynamic Resolution Fullscreen Sync
  const fitToggleBtn = document.getElementById('hud-fit-toggle') as HTMLButtonElement;
  const updateFullscreenBtnState = () => {
    if (document.fullscreenElement) {
      fitToggleBtn.innerHTML = ICONS.minimize;
      fitToggleBtn.title = '全画面解除';
    } else {
      fitToggleBtn.innerHTML = ICONS.fullscreen;
      fitToggleBtn.title = '画面最大化';
    }
  };

  const onFullscreenChange = () => {
    updateFullscreenBtnState();
    sendResize(true);
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);

  fitToggleBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      if (!document.fullscreenElement) {
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        }
      }
    } catch (err) {
      console.warn('Fullscreen toggle failed, falling back to immediate resize sync:', err);
    }
    setTimeout(() => sendResize(true), 150);
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
      wsClient.send(ClientProtocol.packCommand({
        type: 'NAVIGATE',
        url: searchUrl,
      }));
      searchInput.value = '';
      searchInput.blur();
      showToast(`YouTube検索へ移動中: "${text}"`, 'info');
    }
  });

  searchInput?.addEventListener('focus', () => {
    searchInput.style.width = '180px';
    searchInput.style.borderColor = '#3e6ae1';
  });
  searchInput?.addEventListener('blur', () => {
    searchInput.style.width = '115px';
    searchInput.style.borderColor = 'rgba(255, 255, 255, 0.2)';
  });

  // Tap-to-resume handlers
  let lastResumeTrigger = 0;
  const onOverlayTap = (e: Event) => {
    if ((e.target as HTMLElement).id === 'notice-action-btn' || (e.target as HTMLElement).id === 'notice-disconnect-btn') return;
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
    document.getElementById('power-menu-modal')?.remove();
    if (hudDimTimer) clearTimeout(hudDimTimer);
    window.removeEventListener('pointermove', resetHudDimTimer);
    window.removeEventListener('pointerdown', resetHudDimTimer);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
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
    metricsCollector.destroy();
    jitterController.destroy();
    framePacer.destroy();
    decoder.close();
    touchMapper.destroy();
  };
}
