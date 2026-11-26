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
import {
  clearElementChildren,
  DEFAULT_FAVORITES,
  DEFAULT_HOME_FAVORITE_ID,
  escapeHtml,
  type FavoriteItem,
  ICONS,
  insertFavoritePreservingHome,
  isSafeHttpUrl,
  resolveHomeFavorite,
  sanitizeFavorites,
  showToast,
} from './icons.js';
import { browserRestart, encoderRestart } from './power-actions.js';

export type { FavoriteItem } from './icons.js';

const PACKET_STALL_WARN_THRESHOLD_MS = 400;
const PACKET_LOSS_TIMEOUT_MS = 1200;
const RTT_WARN_THRESHOLD_MS = 90;
const ENCODER_RESTART_COOLDOWN_MS = 1000;
const RTT_HISTORY_WINDOW_SIZE = 8;

/**
 * Checks whether a URL belongs to YouTube (youtube.com, subdomains, or youtu.be).
 */
export function isYouTubeUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
  } catch {
    return false;
  }
}

export function renderStreamingView(
  container: HTMLElement,
  wsClient: WsClient,
  audioPlayer: AudioPlayer,
  avSync: AvSyncController,
  onOpenSettings: () => void,
  authToken?: string | null,
  sessionRole: 'primary' | 'secondary' = 'primary',
  options?: { initialPrimaryActive?: boolean },
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
            <button id="hud-fps-toggle" class="hud-pill-btn" title="フレームレート切替 (タップで選択可能なFPS段階を循環)">
              ${ICONS.zap} <span id="hud-fps-val" class="telemetry-value">30</span>
            </button>
            <button id="hud-bitrate-toggle" class="hud-pill-btn" title="ビットレート切替 (タップで 0.25M 〜 2.0M の 6 段階循環)">
              ${ICONS.signal} <span id="hud-bitrate-val" class="telemetry-value">1.0M</span>
            </button>
          </div>
        </div>

        <!-- Right Group: Navigation, Search, Settings -->
        <div class="hud-right-group">
          <div class="hud-nav-group">
            <!-- Virtual Keyboard Drawer Toggle -->
            <button id="hud-keyboard-btn" class="hud-btn" title="文字入力バーを展開 (車載キーボード入力)">
              ${ICONS.keyboard}
            </button>

            <!-- Browser Navigation Controls -->
            <button id="hud-back-btn" class="hud-btn" title="戻る (Back)">${ICONS.back}</button>
            <button id="hud-home-btn" class="hud-btn" title="ホームへ移動 (YouTube)">${ICONS.home}</button>
            <button id="hud-favorites-btn" class="hud-btn" title="お気に入り一覧">${ICONS.star}</button>
          </div>

          <div class="hud-utility-group">
            <div id="hud-search-divider" class="hud-divider"></div>

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

      <!-- Favorites Drawer (Expands below Top HUD) -->
      <div id="hud-favorites-drawer" class="hud-favorites-drawer" style="display: none;">
        <div class="hud-favorites-header">
          <div class="hud-favorites-title">
            ${ICONS.star}
            <span>お気に入り</span>
          </div>
          <div class="hud-favorites-actions">
            <button id="hud-fav-add-current-btn" type="button" class="hud-kbd-btn hud-fav-action-btn" title="現在開いているページをお気に入りに追加">
              ${ICONS.plus} 現在のページを追加
            </button>
            <button id="hud-fav-edit-btn" type="button" class="hud-kbd-btn hud-fav-action-btn" title="お気に入りの編集・並び替え・ホーム設定">
              ${ICONS.edit} 編集 / 管理
            </button>
            <button id="hud-fav-close-btn" type="button" class="hud-kbd-close-btn" title="閉じる">
              ${ICONS.close}
            </button>
          </div>
        </div>
        <div id="hud-favorites-list" class="hud-favorites-list"></div>
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
  const isSecondarySession = sessionRole === 'secondary';
  let isPrimarySessionActive = !isSecondarySession || (options?.initialPrimaryActive ?? true);
  let isActingPrimary = false;
  const isEffectivelyPrimary = () => !isSecondarySession || isActingPrimary;

  let instantRtt = 0;
  let minRtt = Number.POSITIVE_INFINITY;
  let rttHistory: number[] = [];
  let lastPacketReceivedTime = performance.now();
  let pingId = 0;
  // Issue #105: RTT サンプルの鮮度管理。CATCHUP バーストやリンク輻輳で PONG が長時間届かない場合、
  // 最後の instantRtt をリアルタイム計測値として表示・報告し続ける（凍結）のを防ぐ。
  let lastPongAtMs = 0;
  // 鮮度切れで破棄した後、汚染 PONG だけの状態で minRtt から自動的に復活させないためのフラグ
  // （Issue #24 の CATCHUP 初期化分岐が古い凍結値を再導入するのを防ぎ、真に有効なサンプルが
  // 届いた時点でのみ RTT 表示を再開する）
  let rttStaleCleared = false;
  const RTT_STALE_MS = 5000;

  /**
   * Issue #105: RTT 鮮度切れ判定。PONG の鮮度タイムスタンプが閾値超過なら最後の計測値を
   * 破棄し、HUD・メトリクスとも未計測として扱う（HUD 表示は呼び出し側の updateHudConnStatus で更新）。
   * PONG ハンドラと定期更新（updateHudConnStatus）の両方から呼ぶことで、汚染 PONG が
   * 届き続ける状態でも古い値の余分な報告・凍結表示を発生させない。
   */
  function clearStaleRttIfExpired(now: number): void {
    if (instantRtt > 0 && now - lastPongAtMs > RTT_STALE_MS) {
      instantRtt = 0;
      rttStaleCleared = true;
      metricsCollector.updateRtt(0);
    }
  }
  // Issue #103: PONG ペイロードのサーバー最新 PTS（LIVE ジャンプ時の暫定音声バリア外挿用）
  let lastKnownServerLatestPtsUs = 0;
  let lastKnownServerLatestAtMs = 0;
  let targetFps = 30;
  let currentFps = 30;
  let currentBitrate = 1000000;

  // Issue #11: 標準の既定 FPS 選択肢。サーバーの clientProfile 実効値 (fpsOptions) で実行時に更新される
  let fpsOptions = [24, 30, 60];
  // 500k は lightweight プロファイルの bitrateDefault と一致させる (HUD 循環で段階飛ばし防止)
  const bitrateOptions = [250000, 500000, 750000, 1000000, 1500000, 2000000];

  const applyFpsOptionsFromServer = (raw: unknown): void => {
    if (!Array.isArray(raw)) return;
    const opts = raw.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 24 && n <= 60); // 許容範囲: 24〜60 FPS
    if (opts.length > 0) {
      fpsOptions = [...new Set(opts)].sort((a, b) => a - b);
    }
  };

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
    if (bps === 250000) return '0.25M';
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
  let activeDecoder: VideoStreamDecoder | null = null;
  const applyTargetFps = (fps: number) => {
    currentFps = fps;
    targetFps = fps;
    framePacer.setTargetFps(fps);
    if (activeDecoder && typeof activeDecoder.setTargetFps === 'function') {
      activeDecoder.setTargetFps(fps);
    }
  };

  // 1.1. Adaptive Jitter Buffer Controller for LTE Jitter & Spikes
  const jitterController = new AdaptiveJitterController({
    onDelayChanged: (delayMs: number) => {
      framePacer.setAdditionalDelay(delayMs);
      audioPlayer.setAdditionalDelay(delayMs);
    },
  });

  // Favorites, Home, and Current Browser URL State
  let favorites: FavoriteItem[] = DEFAULT_FAVORITES.map((f) => ({ ...f }));
  let homeFavoriteId = DEFAULT_HOME_FAVORITE_ID;
  let currentBrowserUrl = 'https://www.youtube.com';
  let currentBrowserTitle = '';
  let hasLiveBrowserStatus = false;

  const hudHomeBtn = document.getElementById('hud-home-btn') as HTMLButtonElement | null;
  const searchForm = document.getElementById('hud-search-form') as HTMLFormElement | null;
  const searchDivider = document.getElementById('hud-search-divider') as HTMLElement | null;
  const searchInput = document.getElementById('hud-search-input') as HTMLInputElement | null;
  const favBtn = document.getElementById('hud-favorites-btn') as HTMLButtonElement | null;
  const favDrawer = document.getElementById('hud-favorites-drawer') as HTMLElement | null;
  const favList = document.getElementById('hud-favorites-list') as HTMLElement | null;
  const favAddCurrentBtn = document.getElementById(
    'hud-fav-add-current-btn',
  ) as HTMLButtonElement | null;
  const favEditBtn = document.getElementById('hud-fav-edit-btn') as HTMLButtonElement | null;
  const favCloseBtn = document.getElementById('hud-fav-close-btn') as HTMLButtonElement | null;
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

  const updateSearchBarVisibility = () => {
    const showSearch = isYouTubeUrl(currentBrowserUrl);
    if (searchForm) {
      searchForm.style.display = showSearch ? 'flex' : 'none';
    }
    if (searchDivider) {
      searchDivider.style.display = showSearch ? '' : 'none';
    }
  };

  const updateHomeButtonTitle = () => {
    if (!hudHomeBtn) return;
    const homeFav = resolveHomeFavorite(favorites, homeFavoriteId);
    const nextTitle = `ホームへ移動 (${homeFav.title})`;
    if (hudHomeBtn.title !== nextTitle) {
      hudHomeBtn.title = nextTitle;
    }
  };

  const closeKeyboardDrawerOnly = () => {
    if (!kbdDrawer || !kbdBtn) return;
    kbdDrawer.style.display = 'none';
    kbdBtn.classList.remove('is-active');
    kbdInput?.blur?.();
  };

  const closeFavoritesDrawerOnly = () => {
    if (!favDrawer || !favBtn) return;
    favDrawer.style.display = 'none';
    favBtn.classList.remove('is-active');
  };

  const navigateFromHud = (url: string) => {
    if (!isSafeHttpUrl(url)) return;
    wsClient.send(ClientProtocol.packCommand({ type: 'NAVIGATE', url }));
    currentBrowserUrl = url;
    updateSearchBarVisibility();
    closeFavoritesDrawerOnly();
    closeKeyboardDrawerOnly();
  };

  const renderFavoritesList = () => {
    if (!favList) return;
    clearElementChildren(favList);
    if (favorites.length === 0) {
      favList.innerHTML =
        '<div class="hud-favorites-empty">お気に入りが登録されていません。「編集 / 管理」または「現在のページを追加」から追加できます。</div>';
      return;
    }
    const resolvedHome = resolveHomeFavorite(favorites, homeFavoriteId);
    favList.innerHTML = favorites
      .map((item) => {
        const isHome = item.id === resolvedHome.id;
        const safeId = escapeHtml(item.id);
        const safeTitle = escapeHtml(item.title);
        const safeUrl = escapeHtml(item.url);
        let host = item.url;
        try {
          host = new URL(item.url).hostname;
        } catch {}
        const safeHost = escapeHtml(host);
        return `
          <button
            id="hud-fav-item-${safeId}"
            type="button"
            class="hud-favorite-item${isHome ? ' is-home' : ''}"
            data-favorite-id="${safeId}"
            data-url="${safeUrl}"
            title="${safeTitle} (${safeUrl})"
          >
            <span class="hud-favorite-item-main">
              ${isHome ? `<span class="hud-favorite-home-badge" title="ホームに設定中">${ICONS.home}</span>` : ''}
              <span class="hud-favorite-title">${safeTitle}</span>
            </span>
            <span class="hud-favorite-host">${safeHost}</span>
          </button>
        `;
      })
      .join('');

    for (const item of favorites) {
      const safeId = escapeHtml(item.id);
      const itemBtn =
        document.getElementById(`hud-fav-item-${item.id}`) ||
        document.getElementById(`hud-fav-item-${safeId}`);
      itemBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        resetHudDimTimer();
        navigateFromHud(item.url);
        showToast(`${item.title} を開いています`, 'info', 1800);
      });
    }
  };

  const toggleFavoritesDrawer = (show?: boolean) => {
    if (!favDrawer || !favBtn) return;
    const isCurrentlyOpen = favDrawer.style.display !== 'none';
    const nextState = show !== undefined ? show : !isCurrentlyOpen;

    if (nextState) {
      closeKeyboardDrawerOnly();
      renderFavoritesList();
      favDrawer.style.display = 'flex';
      favBtn.classList.add('is-active');
    } else {
      closeFavoritesDrawerOnly();
    }
  };

  const toggleKeyboardDrawer = (show?: boolean) => {
    if (!kbdDrawer || !kbdBtn) return;
    const isCurrentlyOpen = kbdDrawer.style.display !== 'none';
    const nextState = show !== undefined ? show : !isCurrentlyOpen;

    if (nextState) {
      closeFavoritesDrawerOnly();
      kbdDrawer.style.display = 'flex';
      kbdBtn.classList.add('is-active');
      // Synchronous focus preserves user gesture context for Tesla OSK popup
      kbdInput?.focus?.();
    } else {
      closeKeyboardDrawerOnly();
    }
  };

  updateHomeButtonTitle();
  updateSearchBarVisibility();
  renderFavoritesList();

  // Sync settings on startup
  const effectiveToken =
    authToken || localStorage.getItem('tesroid_token') || sessionStorage.getItem('tesroid_token');
  if (effectiveToken) {
    fetch('/api/settings', {
      headers: { Authorization: `Bearer ${effectiveToken}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        // Issue #11: HUD の FPS 選択肢をクライアント負荷プロファイルの実効値へ同期
        applyFpsOptionsFromServer(data?.clientProfileResolved?.fpsOptions);
        if (data?.stream?.maxFps) {
          applyTargetFps(Number(data.stream.maxFps));
        }
        if (data?.stream?.bitrate) {
          currentBitrate = Number(data.stream.bitrate);
        }
        updateToggleButtons();

        const fetchedFavorites = sanitizeFavorites(data.favorites);
        if (fetchedFavorites !== null) {
          favorites = fetchedFavorites;
        }
        if (typeof data.homeFavoriteId === 'string' && data.homeFavoriteId.trim()) {
          homeFavoriteId = data.homeFavoriteId.trim();
        }
        if (!hasLiveBrowserStatus) {
          if (typeof data.browserUrl === 'string' && isSafeHttpUrl(data.browserUrl)) {
            currentBrowserUrl = data.browserUrl;
          } else if (typeof data.homeUrl === 'string' && isSafeHttpUrl(data.homeUrl)) {
            currentBrowserUrl = data.homeUrl;
          }
          if (typeof data.browserTitle === 'string') {
            currentBrowserTitle = data.browserTitle;
          }
        }
        updateHomeButtonTitle();
        updateSearchBarVisibility();
        renderFavoritesList();
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
    applyTargetFps(fpsOptions[nextIdx]);
    updateToggleButtons();
    triggerSaveSettings();
  });

  bitrateToggleBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    let idx = bitrateOptions.indexOf(currentBitrate);
    if (idx === -1) idx = bitrateOptions.indexOf(1_000_000); // 保存値が候補外なら 1.0M を起点に次段階 (1.5M) へ循環
    const nextIdx = (idx + 1) % bitrateOptions.length;
    currentBitrate = bitrateOptions[nextIdx];
    updateToggleButtons();
    triggerSaveSettings();
  });

  const onSettingsUpdated = (e: any) => {
    let changed = false;
    let favoritesChanged = false;
    if (e.detail?.stream?.maxFps) {
      applyTargetFps(Number(e.detail.stream.maxFps));
      changed = true;
    }
    if (e.detail?.stream?.bitrate) {
      currentBitrate = Number(e.detail.stream.bitrate);
      changed = true;
    }
    if (e.detail?.bufferDepth !== undefined) {
      targetBufferMs = clampBufferDepthMs(Number(e.detail.bufferDepth));
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
    const updatedFavorites = sanitizeFavorites(e.detail?.favorites);
    if (updatedFavorites !== null) {
      favorites = updatedFavorites;
      favoritesChanged = true;
    }
    if (typeof e.detail?.homeFavoriteId === 'string' && e.detail.homeFavoriteId.trim()) {
      homeFavoriteId = e.detail.homeFavoriteId.trim();
      favoritesChanged = true;
    }
    if (changed) {
      updateToggleButtons();
    }
    if (favoritesChanged) {
      updateHomeButtonTitle();
      renderFavoritesList();
    }
  };
  window.addEventListener('tesroid:settings-updated', onSettingsUpdated);

  const MAX_BUFFER_DEPTH_MS = 30000;
  const clampBufferDepthMs = (ms: number): number =>
    Number.isFinite(ms) ? Math.max(0, Math.min(MAX_BUFFER_DEPTH_MS, Math.round(ms))) : 10000;

  // Initialize configurable buffer depth (e.g. ?buffer=2s for Intel MCU2, ?buffer=10s default, up to 30s for Ryzen MCU3)
  const getInitialBufferDepthMs = (): number => {
    try {
      const params = new URLSearchParams(window.location.search);
      const bufParam = params.get('buffer');
      if (bufParam) {
        const parsed = bufParam.endsWith('s')
          ? parseFloat(bufParam) * 1000
          : parseInt(bufParam, 10);
        if (!isNaN(parsed)) return clampBufferDepthMs(parsed);
      }
      const saved = localStorage.getItem('tesroid_prefetch_buffer_ms');
      if (saved !== null) {
        const val = parseInt(saved, 10);
        if (!isNaN(val)) return clampBufferDepthMs(val);
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
  // Issue #111 Buffer-Hold Pause: サーバーが自動一時停止中の状態 (PONG/BUFFER_HOLD で同期)
  let serverHoldPaused = false;

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
  activeDecoder = decoder;

  if (typeof decoder.setBufferDepth === 'function') {
    decoder.setBufferDepth({ targetDurationMs: targetBufferMs });
  }
  applyTargetFps(targetFps);

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

  // Issue #11: クライアント処理負荷計測用（描画所要時間 p50/p95）
  framePacer.onFrameRenderTimed = (durationMs: number) => {
    metricsCollector.recordFrameProcessed(durationMs);
  };

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

  // Issue #106: 映像経路のバッファ残量を集計する共通関数。
  // HUD 表示 (updateHudLiveStatus)、遅延判定 (getTotalBufferedBehindMs)、
  // BUFFER_FEEDBACK 報告 (sendBufferFeedback)、再接続/切断処理 (handleOpen / handleClose) で定義を統一する。
  const getVideoPathBufferedMs = (): number => {
    const pendingBufferedMs =
      typeof decoder.getPendingBufferedMs === 'function' ? decoder.getPendingBufferedMs() : 0;
    const pacerBufferedMs =
      typeof framePacer.getBufferedDurationMs === 'function'
        ? framePacer.getBufferedDurationMs()
        : 0;
    return pendingBufferedMs + pacerBufferedMs;
  };

  const getAudioPathBufferedMs = (): number =>
    typeof audioPlayer.getBufferedAudioMs === 'function' ? audioPlayer.getBufferedAudioMs() : 0;

  const getTotalBufferedBehindMs = () => {
    const videoBufferedMs = getVideoPathBufferedMs();
    const audioBufferedMs = getAudioPathBufferedMs();
    // Notice: Do NOT use raw `(serverLatestPts - lastDecodedPts)` as "buffered behind" because on a static screen
    // FFmpeg does not emit new frames while server wall-clock advances, which previously caused false 2-3s catch-up display!
    const clientBufferedMs = Math.max(videoBufferedMs, Math.max(0, audioBufferedMs - 160));
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
      // Issue #105: PONG が閾値を超えて届かない場合、最後の RTT 値は鮮度切れとして破棄する
      // （CATCHUP バースト中のソケット滞留で汚染された値が凍結表示される問題の防止）
      clearStaleRttIfExpired(performance.now());
      const elapsed = performance.now() - lastPacketReceivedTime;

      if (elapsed > PACKET_LOSS_TIMEOUT_MS) {
        // 1.2秒以上パケットが途絶えている（パケロス・電波瞬断）
        targetClass = 'status-dot status-offline';
        signalLevelClass = 'signal-meter signal-level-0';
        targetText = '瞬断中';
        targetTitle =
          instantRtt > 0
            ? `通信断 / パケット未着: ${(elapsed / 1000).toFixed(1)}秒 (瞬間RTT: ${instantRtt}ms)`
            : `通信断 / パケット未着: ${(elapsed / 1000).toFixed(1)}秒 (RTT計測待機)`;
      } else if (elapsed > PACKET_STALL_WARN_THRESHOLD_MS || instantRtt >= RTT_WARN_THRESHOLD_MS) {
        // パケット到着間隔の拡大、または回線RTTが警告レベル
        targetClass = 'status-dot status-warning';
        signalLevelClass =
          instantRtt >= 130 ? 'signal-meter signal-level-1' : 'signal-meter signal-level-2';
        targetText = instantRtt > 0 ? `${instantRtt}ms` : '接続中';
        targetTitle =
          instantRtt > 0
            ? `通信不安定 (瞬間RTT: ${instantRtt}ms, 受信間隔: ${Math.round(elapsed)}ms)`
            : `通信不安定 (RTT計測待機, 受信間隔: ${Math.round(elapsed)}ms)`;
      } else {
        // パケットが円滑に届いており回線も良好
        targetClass = 'status-dot status-online';
        signalLevelClass =
          instantRtt >= 60 ? 'signal-meter signal-level-3' : 'signal-meter signal-level-4';
        targetText = instantRtt > 0 ? `${instantRtt}ms` : '接続中';
        targetTitle =
          instantRtt > 0 ? `通信良好 (瞬間RTT: ${instantRtt}ms)` : '接続状態: 接続中 (RTT計測待機)';
      }
    }

    setClassIfChanged(connDot, targetClass);
    setClassIfChanged(hudSignal, signalLevelClass);
    setTextIfChanged(connText, targetText);
    setTitleIfChanged(hudConn, targetTitle);
  };

  let lastHudLiveState: 'interactive' | 'buffering' | 'catchup' | 'hold' | 'live' | '' = '';

  const updateHudLiveStatus = () => {
    if (!hudLiveBtn || !hudLiveText || !hudLiveDot) return;

    const isBuffering =
      typeof framePacer.getIsBuffering === 'function' ? framePacer.getIsBuffering() : false;
    const isInteractive =
      typeof framePacer.getMode === 'function' && framePacer.getMode() === 'ACTIVE_INTERACTION';

    const localMs = getVideoPathBufferedMs();
    const serverMs = Math.max(serverCatchupQueueMs, serverBufferMs);

    const localSec = (localMs / 1000).toFixed(1);
    const serverSec = (serverMs / 1000).toFixed(1);

    // Issue #111: サーバーが Buffer-Hold Pause 中は最優先で HOLD を表示（タップで即 LIVE 同期）
    const currentState = serverHoldPaused
      ? 'hold'
      : isInteractive
        ? 'interactive'
        : isBuffering
          ? 'buffering'
          : localMs >= 800 || serverMs >= 600
            ? 'catchup'
            : 'live';

    if (currentState !== lastHudLiveState) {
      lastHudLiveState = currentState;
      hudLiveBtn.classList.remove('is-catchup', 'is-buffering', 'is-hold');
      if (currentState === 'buffering') {
        hudLiveBtn.classList.add('is-buffering');
      } else if (currentState === 'catchup' || currentState === 'hold') {
        hudLiveBtn.classList.add(currentState === 'hold' ? 'is-hold' : 'is-catchup');
      }

      const targetDotClass =
        currentState === 'buffering' ? 'status-dot status-warning' : 'status-dot status-online';
      setClassIfChanged(hudLiveDot, targetDotClass);
    }

    let targetText = 'LIVE';
    let targetTitle = 'リアルタイム再生中 (タップで最新LIVE同期・再エンコード)';

    if (currentState === 'hold') {
      // Issue #111: サーバー自動一時停止中。生成を止め、クライアント側の再生消費による追い上げを待っている状態
      targetText = `HOLD L:${localSec}s S:${serverSec}s`;
      targetTitle = `サーバーが回線途絶・輻輳で生成を一時停止中 (ローカル: ${localSec}秒, サーバー残余: ${serverSec}秒) — 再生の追い上げで自動再開、タップで最新LIVE同期`;
    } else if (currentState === 'interactive') {
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

  let primaryAnchorPtsUs = 0;
  let primaryAnchorLocalMs = 0;

  if (isSecondarySession && typeof avSync.setExternalMasterPtsProvider === 'function') {
    avSync.setExternalMasterPtsProvider(() => {
      if (isEffectivelyPrimary()) return null;
      if (primaryAnchorPtsUs <= 0 || primaryAnchorLocalMs <= 0) return null;
      const elapsedMs = performance.now() - primaryAnchorLocalMs;
      if (elapsedMs < -1000 || elapsedMs > 5000) return null;
      return Math.round(primaryAnchorPtsUs + elapsedMs * 1000);
    });
  }

  const executeJumpToLive = (silent = false, notifyServer = true) => {
    // Issue #103: jumpToLive()/resetJitterBuffer() が lastChunkPtsUs を 0 へクリアするため、
    // フォールバック用の最終受信音声 PTS はフラッシュ前に退避しておく
    const prevAudioPtsUs =
      typeof audioPlayer.getLastKnownPtsUs === 'function' ? audioPlayer.getLastKnownPtsUs() : 0;
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
    // Issue #103: ローカルキューを空にしても、ジャンプ前にサーバーが送信済みで経路上に残っている
    // 古い音声（straggler）が到着して ~2 秒分の固定 A/V オフセットを作る。ライブエッジ基準の
    // 暫定バリアを設定し、LIVE_JUMPED の dropAudioBeforePts でサーバー基準値へ更新する。
    if (typeof audioPlayer.setLiveEdgeBarrier === 'function') {
      const nowMs = performance.now();
      let barrierUs = 0;
      if (lastKnownServerLatestPtsUs > 0 && nowMs - lastKnownServerLatestAtMs < 3000) {
        // メディア PTS は実時間単調なので、PONG 時点の最新 PTS から経過時間分を外挿する
        barrierUs =
          lastKnownServerLatestPtsUs + Math.round((nowMs - lastKnownServerLatestAtMs) * 1000);
      } else {
        barrierUs = Math.max(lastDecodedPts, prevAudioPtsUs);
      }
      if (barrierUs > 0) {
        audioPlayer.setLiveEdgeBarrier(barrierUs);
      }
    }
    jitterController.reset();
    primaryAnchorPtsUs = 0;
    primaryAnchorLocalMs = 0;
    serverCatchupQueueMs = 0;
    serverBufferMs = 0;
    serverMode = 'LIVE';
    serverHoldPaused = false;
    lastHudLiveState = '';
    if (notifyServer && wsClient.isConnected()) {
      wsClient.send(ClientProtocol.packCommand({ type: 'JUMP_TO_LIVE' }));
    }
    updateHudLiveStatus();
    if (!silent) {
      showToast('未再生バッファを破棄し、最新LIVE映像へ同期しました', 'info');
    }
  };

  // Issue #112: サーバー起因の LIVE 復帰 (LIVE_JUMPED / CATCHUP→LIVE) で音声側のみ PTS バリアにより
  // 古いパケットを破棄すると、映像側 (decoder pendingPackets + framePacer queue) に古いフレームが残り
  // 音声先行の A/V ズレが固定化する。executeJumpToLive と同様に映像側もライブエッジへ早送りする。
  // サーバー起因のため自動適応クッションは維持 (preserveCushion=true) し、直後の不要な WAIT 遷移を防ぐ。
  const fastForwardVideoToLiveEdge = () => {
    if (typeof decoder.flushPendingForLiveJump === 'function') {
      decoder.flushPendingForLiveJump();
    }
    if (typeof framePacer.jumpToLive === 'function') {
      framePacer.jumpToLive(true);
    }
  };

  let isRestartingEncoder = false;
  let encoderRestartTimer: ReturnType<typeof setTimeout> | null = null;

  hudLiveBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    resetHudDimTimer();

    if (isSecondarySession && !isPrimarySessionActive) {
      showToast('前席モニターからの接続・配信開始を待機しています', 'info');
      return;
    }

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

  // Auto-unlock AudioContext on any user touch/click anywhere on screen (disabled while acting as passive secondary)
  const autoUnlockAudio = () => {
    if (!isEffectivelyPrimary()) return;
    const stats = audioPlayer.getStats();
    if (!stats.isUnlocked || stats.state === 'suspended') {
      audioPlayer.unlock();
    }
  };
  canvas.addEventListener('pointerdown', autoUnlockAudio);
  window.addEventListener('pointerdown', autoUnlockAudio, { capture: true });

  // 4. Dynamic Resolution Fit (Zero-Black-Bar, dedicated viewport below top HUD)
  let resizeTimer: any = null;
  const sendResize = (immediate: boolean = false) => {
    if (!isEffectivelyPrimary()) return;
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
  if (!isSecondarySession) {
    sendResize(false);
  }

  // 5. Connect WebSocket streams
  const handleVideo = (msg: { flags: number; pts: bigint; data: Uint8Array }) => {
    lastPacketReceivedTime = performance.now();
    if (isSecondarySession && !isPrimarySessionActive) return;
    metricsCollector.recordVideoPacket(msg.data.byteLength);
    jitterController.recordVideoArrival();
    decoder.handlePacket(msg.flags, msg.pts, msg.data);
    if (healthStream) {
      healthStream.innerHTML = `<span class="status-dot status-online"></span> 配信: 送信中`;
    }
  };

  const handleAudio = (msg: { flags: number; pts: bigint; data: Uint8Array }) => {
    lastPacketReceivedTime = performance.now();
    if (!isEffectivelyPrimary() || !isPrimarySessionActive) return;
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
    if (noticeActionBtn) noticeActionBtn.style.display = '';
  };

  const showRearStandbyScreen = () => {
    showOverlay(
      '後席モニター待ち受け中',
      '前席モニターからの接続・配信開始を待機しています...',
      true,
    );
    if (noticeActionBox && noticeActionBtn) {
      noticeActionBtn.style.display = 'none';
      noticeActionBox.style.display = 'flex';
    }
    if (healthBrowser) {
      healthBrowser.innerHTML = `<span class="status-dot status-idle"></span> 前席: 待機中`;
    }
    if (healthStream) {
      healthStream.innerHTML = `<span class="status-dot status-idle"></span> 配信: 待機中`;
    }
  };

  const showSleepingScreen = () => {
    browserPowerState = 'sleeping';
    showOverlay(
      '省電力一時停止中 (CPU/GPU 0%)',
      'ブラウザと配信は休止中です。再開ボタンまたは画面タップで即時復帰します。',
      false,
    );
    if (noticeActionBox && noticeActionBtn) {
      noticeActionBtn.style.display = '';
      noticeActionBtn.textContent = '再開する (タップで復帰)';
      noticeActionBox.style.display = 'flex';
    }
    if (healthBrowser) {
      healthBrowser.innerHTML = `<span class="status-dot status-idle"></span> Browser: 一時停止`;
    }
  };

  if (isSecondarySession && !isPrimarySessionActive) {
    showRearStandbyScreen();
  }

  const triggerResume = () => {
    browserPowerState = 'waking';
    showOverlay('復帰処理中...', 'ブラウザとハードウェアエンコーダを再開しています...', true);
    if (noticeActionBox) noticeActionBox.style.display = 'none';
    wsClient.send(ClientProtocol.packCommand({ type: 'RESUME_BROWSER' }));
  };

  // Intentional Session Disconnect helper
  let isDisconnecting = false;
  let disconnectReloadTimer: ReturnType<typeof setTimeout> | null = null;
  const performIntentionalDisconnect = () => {
    if (isDisconnecting) return;
    isDisconnecting = true;
    if (wsClient.isConnected()) {
      wsClient.send(ClientProtocol.packCommand({ type: 'DISCONNECT_SESSION' }));
    }
    try {
      sessionStorage.removeItem('tesroid_token');
      sessionStorage.removeItem('tesroid_role');
    } catch {}
    wsClient.close(1000, 'User requested disconnect');
    disconnectReloadTimer = setTimeout(() => {
      disconnectReloadTimer = null;
      window.location.reload();
    }, 50);
  };

  // Immediate Stop Action
  const triggerStop = () => {
    wsClient.send(ClientProtocol.packCommand({ type: 'PAUSE_BROWSER' }));
    audioPlayer.resetJitterBuffer();
    if (typeof audioPlayer.clearLiveEdgeBarrier === 'function') {
      audioPlayer.clearLiveEdgeBarrier();
    }
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

    const isRearStandby = isSecondarySession && !isPrimarySessionActive;
    const standbyActionStyle = isRearStandby ? 'opacity: 0.45; cursor: not-allowed;' : '';

    overlay.innerHTML = `
      <div class="card" style="max-width: 440px; width: 90%; max-height: 85vh; overflow-y: auto; position: relative; border-radius: 4px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <h3 style="margin: 0; font-size: 17px; display: flex; align-items: center; gap: 8px;">
            ${ICONS.power} 省電力 & リソース制御
          </h3>
          <button id="power-modal-close-btn" class="hud-btn" style="font-size: 18px; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; border-radius: 3px;">✕</button>
        </div>
        <p style="font-size: 13px; margin-bottom: 16px; color: var(--text-muted);">${
          isRearStandby
            ? '後席モニター待ち受け中のため、停止・再起動は前席接続後に利用できます。'
            : '車を離れる際や一時停止時にCPU/GPU負荷を0%に凍結します。'
        }</p>
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <button id="power-quick-stop-btn" class="btn btn-danger" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 14px; font-weight: 700; border-radius: 4px; ${standbyActionStyle}" ${isRearStandby ? 'disabled' : ''}>
            ${ICONS.stop} ワンタップ停止 (省電力スタンバイ)
          </button>
          <button id="power-browser-restart-btn" class="btn btn-secondary" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 14px; font-weight: 600; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.18); ${standbyActionStyle}" ${isRearStandby ? 'disabled' : ''}>
            ${ICONS.refresh} ブラウザ＆配信再起動
          </button>
          <button id="power-disconnect-btn" class="btn btn-secondary" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 14px; font-weight: 600; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.18);">
            ${ICONS.close} セッション切断 (待機画面へ戻る)
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
      if (isSecondarySession && !isPrimarySessionActive) {
        showToast('前席モニターからの接続・配信開始を待機しています', 'info');
        return;
      }
      closePowerModal();
      triggerStop();
    });

    overlay.querySelector('#power-browser-restart-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      resetHudDimTimer();
      if (isSecondarySession && !isPrimarySessionActive) {
        showToast('前席モニターからの接続・配信開始を待機しています', 'info');
        return;
      }
      closePowerModal();
      browserRestart(token);
    });

    overlay.querySelector('#power-disconnect-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      resetHudDimTimer();
      closePowerModal();
      performIntentionalDisconnect();
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
    if (typeof audioPlayer.clearLiveEdgeBarrier === 'function') {
      // Issue #103: ストリーム再構築では PTS が再基準化されるため、旧ストリーム基準のバリアは無効化する
      audioPlayer.clearLiveEdgeBarrier();
    }
    lastKnownServerLatestPtsUs = 0;
    lastPongAtMs = 0;
    rttStaleCleared = false;
    jitterController.reset();
    renderer.resetFirstFrame();
    avSync.reset();
    lastDecodedPts = 0;
    lastAckSentPts = -1;
    serverCatchupQueueMs = 0;
    serverBufferMs = 0;
    serverMode = 'LIVE';
    serverHoldPaused = false;
    updateHudLiveStatus();
    if (isSecondarySession && !isPrimarySessionActive) {
      showRearStandbyScreen();
    } else if (browserPowerState !== 'sleeping') {
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
      // Issue #105: 鮮度切れ判定を測定の前に行う（汚染 PONG のみ継続到着時に、
      // クリア前の古い instantRtt が metrics へ余分に報告される境界タイミングの排除）
      clearStaleRttIfExpired(now);
      if (
        typeof msg.latestPts === 'number' &&
        Number.isFinite(msg.latestPts) &&
        msg.latestPts > 0
      ) {
        // Issue #103: サーバー最新 PTS を到着時刻付きで追跡（ジャンプ時の暫定バリア基準）
        lastKnownServerLatestPtsUs = msg.latestPts;
        lastKnownServerLatestAtMs = now;
      }
      const rawRtt = Math.max(1, Math.round(now - msg.clientTime));

      if (typeof msg.catchupQueueMs === 'number') {
        serverCatchupQueueMs = Math.max(0, msg.catchupQueueMs);
      }
      if (typeof msg.serverBufferMs === 'number') {
        serverBufferMs = Math.max(0, msg.serverBufferMs);
      }
      if (msg.serverMode === 'CATCHUP' || msg.serverMode === 'LIVE') {
        const prevServerMode = serverMode;
        serverMode = msg.serverMode;
        // Issue #112: サーバー起因の CATCHUP→LIVE 完了時は映像側も同一境界へ早送りし、
        // 古い映像キューの残存による音声先行ドリフトを防ぐ
        if (prevServerMode === 'CATCHUP' && serverMode === 'LIVE') {
          fastForwardVideoToLiveEdge();
        }
      }
      // Issue #111: Buffer-Hold Pause 中フラグを PONG 毎に同期（旧サーバーでは未定義=false）
      if (typeof msg.holdPaused === 'boolean') {
        serverHoldPaused = msg.holdPaused;
      }

      // 瞬間ネットワーク往復時間（Instantaneous RTT）の測定と表示 (Issue 24):
      // バッファ蓄積中（CATCHUP中やサーバー送出キュー滞留時）は、単一WebSocket内のパケット待ち行列遅延によって
      // rawRtt が肥大化するため、キュー滞留時間と回線自体の遅延（物理RTT）を明確に分離する。
      const hasQueueDelay = serverMode === 'CATCHUP' || serverCatchupQueueMs > 0;
      if (!hasQueueDelay) {
        // Issue #105: 実際に有効な RTT サンプルを採用した時点のみ鮮度タイムスタンプを更新する。
        // 汚染ガードでスキップされ続ける状態（PONG は届くが採用されない）も 5 秒で鮮度切れになり、
        // CATCHUP 突入前の古い instantRtt の凍結表示・再報告を防止する。
        lastPongAtMs = now;
        rttStaleCleared = false; // 有効なサンプルが採用されたので鮮度管理を再開する
        rttHistory.push(rawRtt);
        if (rttHistory.length > RTT_HISTORY_WINDOW_SIZE) rttHistory.shift();
        minRtt = rttHistory.length > 0 ? Math.min(...rttHistory) : rawRtt;
        instantRtt = instantRtt === 0 ? rawRtt : Math.round(instantRtt * 0.7 + rawRtt * 0.3);
        jitterController.updateRtt(instantRtt);
      } else {
        // CATCHUP中は直近の有効な物理RTTまたは安定値を維持し、回線状態指標の肥大化を防ぐ。
        // 接続直後・再接続直後でまだ一度も健全な LIVE RTT（minRtt）を計測できていない場合は
        // 汚染された rawRtt を採用せず 0（'接続中'）のまま維持する（Issue #105）。
        if (instantRtt === 0 && !rttStaleCleared && Number.isFinite(minRtt)) {
          instantRtt = minRtt;
          lastPongAtMs = now; // 初期基準を確定させた時点も鮮度タイムスタンプとして記録
        }
      }
      metricsCollector.updateRtt(instantRtt);

      if (isSecondarySession && !isActingPrimary) {
        if (
          typeof msg.primaryTargetBufferMs === 'number' &&
          Number.isFinite(msg.primaryTargetBufferMs)
        ) {
          const syncedTargetMs = clampBufferDepthMs(msg.primaryTargetBufferMs);
          if (Math.abs(syncedTargetMs - targetBufferMs) >= 500) {
            targetBufferMs = syncedTargetMs;
            if (typeof decoder.setBufferDepth === 'function') {
              decoder.setBufferDepth({ targetDurationMs: targetBufferMs });
            }
          }
        }
        if (
          typeof msg.primaryRenderedPts === 'number' &&
          msg.primaryRenderedPts > 0 &&
          typeof msg.primaryFeedbackAgeMs === 'number' &&
          msg.primaryFeedbackAgeMs < 5000
        ) {
          primaryAnchorPtsUs = msg.primaryRenderedPts;
          primaryAnchorLocalMs = now - msg.primaryFeedbackAgeMs - Math.round(rawRtt / 2);
        } else if (msg.primaryRenderedPts == null) {
          primaryAnchorPtsUs = 0;
          primaryAnchorLocalMs = 0;
        }
      }

      updateHudConnStatus();
      updateHudLiveStatus();
    } else if (msg.type === 'PRIMARY_JUMP_TO_LIVE') {
      executeJumpToLive(true, false);
      // Issue #103: セカンダリ側も、サーバーが送る基準 PTS で暫定バリアを上書きする
      if (
        typeof msg.dropAudioBeforePts === 'number' &&
        Number.isFinite(msg.dropAudioBeforePts) &&
        typeof audioPlayer.setLiveEdgeBarrier === 'function'
      ) {
        audioPlayer.setLiveEdgeBarrier(msg.dropAudioBeforePts);
      }
    } else if (msg.type === 'STREAM_SETTINGS_UPDATED') {
      // Issue #11: プロファイル変更時に HUD の FPS 選択肢をライブ更新
      applyFpsOptionsFromServer(msg.stream?.fpsOptions);
      let streamSettingsChanged = false;
      if (typeof msg.stream?.maxFps === 'number' && Number.isFinite(msg.stream.maxFps)) {
        const nextFps = Number(msg.stream.maxFps);
        if (nextFps !== currentFps) {
          applyTargetFps(nextFps);
          streamSettingsChanged = true;
        }
      }
      if (typeof msg.stream?.bitrate === 'number' && Number.isFinite(msg.stream.bitrate)) {
        const nextBitrate = Number(msg.stream.bitrate);
        if (nextBitrate !== currentBitrate) {
          currentBitrate = nextBitrate;
          streamSettingsChanged = true;
        }
      }
      if (streamSettingsChanged) {
        updateToggleButtons();
      }
    } else if (msg.type === 'AUTH_SUCCESS') {
      sendBufferFeedback(true);
    } else if (msg.type === 'LIVE_JUMPED') {
      serverCatchupQueueMs = 0;
      serverBufferMs = 0;
      serverMode = 'LIVE';
      // Issue #111: LIVE ジャンプでサーバー Hold も解除されるためバッジを即時戻す
      serverHoldPaused = false;
      // Issue #103: サーバーから受け取ったライブエッジ PTS を音声 straggler バリアとして適用する
      if (
        typeof msg.dropAudioBeforePts === 'number' &&
        Number.isFinite(msg.dropAudioBeforePts) &&
        typeof audioPlayer.setLiveEdgeBarrier === 'function'
      ) {
        audioPlayer.setLiveEdgeBarrier(msg.dropAudioBeforePts);
      } else if (typeof audioPlayer.jumpToLive === 'function') {
        // Issue #111: dropAudioBeforePts が無い場合（旧サーバー・例外経路）は音声側を強制再同期し、
        // 映像ジャンプ後に旧再生位置が残って固定の A/V オフセットが生じるのを防ぐ
        audioPlayer.jumpToLive();
      }
      // Issue #112: 音声バリアと同一境界で映像側 (decoder pending + pacer queue) も早送りし、
      // 破棄済み音声に対する古い映像再生による音声先行ドリフトを防ぐ
      fastForwardVideoToLiveEdge();
      updateHudLiveStatus();
    } else if (msg.type === 'SESSION_ROLE_CHANGED') {
      if (!isSecondarySession) return;
      if (msg.effectiveRole === 'acting_primary') {
        isActingPrimary = true;
        isPrimarySessionActive = true;
        hasPromptedAudioUnlock = false;
        primaryAnchorPtsUs = 0;
        primaryAnchorLocalMs = 0;
        if (noticeActionBox) noticeActionBox.style.display = 'none';
        if (noticeActionBtn) noticeActionBtn.style.display = '';
        sendResize(true);
        if (typeof audioPlayer.unlock === 'function') {
          void audioPlayer.unlock();
        }
        showToast('メインセッション切断により、後席をメイン代理モードに切り替えました', 'info');
      } else if (msg.effectiveRole === 'secondary') {
        const wasActingPrimary = isActingPrimary;
        isActingPrimary = false;
        if (resizeTimer) {
          clearTimeout(resizeTimer);
          resizeTimer = null;
        }
        audioPlayer.resetJitterBuffer();
        if (typeof audioPlayer.clearLiveEdgeBarrier === 'function') {
          audioPlayer.clearLiveEdgeBarrier();
        }
        if (wasActingPrimary) {
          showToast('メインセッションが復帰したため、セカンドディスプレイ表示に戻りました', 'info');
        }
      }
    } else if (msg.type === 'PRIMARY_SESSION_STATUS') {
      if (!isSecondarySession) return;
      const wasPrimaryActive = isPrimarySessionActive;
      const nextActive = Boolean(msg.active);
      isPrimarySessionActive = nextActive;
      if (!nextActive) {
        decoder.reset();
        if (typeof framePacer.reset === 'function') {
          framePacer.reset();
        } else {
          framePacer.resetFirstFrame();
        }
        jitterController.reset();
        renderer.resetFirstFrame();
        avSync.reset();
        audioPlayer.resetJitterBuffer();
        if (typeof audioPlayer.clearLiveEdgeBarrier === 'function') {
          audioPlayer.clearLiveEdgeBarrier();
        }
        lastDecodedPts = 0;
        lastAckSentPts = -1;
        primaryAnchorPtsUs = 0;
        primaryAnchorLocalMs = 0;
        serverCatchupQueueMs = 0;
        serverBufferMs = 0;
        serverMode = 'LIVE';
        updateHudLiveStatus();
        showRearStandbyScreen();
      } else if (!wasPrimaryActive) {
        if (noticeActionBox) noticeActionBox.style.display = 'none';
        if (noticeActionBtn) noticeActionBtn.style.display = '';
        if (healthBrowser) {
          healthBrowser.innerHTML = `<span class="status-dot status-warning"></span> Browser: 準備中...`;
        }
        showOverlay(
          '画面配信準備中...',
          '前席の配信開始を受信しました。映像を待機しています...',
          true,
        );
      }
    } else if (msg.type === 'STREAM_RESET') {
      resetClientStreamPipeline(
        '配信プロセスを再起動中...',
        'エンコーダとバッファをクリーンに再初期化しています...',
      );
    } else if (msg.type === 'BUFFER_HOLD') {
      // Issue #111: Hold 発動/解除の即時通知（PONG 同期の主経路に加え UX 応答を速める）
      serverHoldPaused = msg.paused === true;
      updateHudLiveStatus();
    } else if (msg.type === 'BROWSER_STATUS') {
      if (isSecondarySession && !isPrimarySessionActive) {
        if (msg.state === 'running') {
          browserPowerState = 'active';
        }
      } else if (healthBrowser) {
        if (msg.state === 'paused') {
          healthBrowser.innerHTML = `<span class="status-dot status-idle"></span> Browser: 一時停止`;
          showSleepingScreen();
        } else if (msg.state === 'running') {
          healthBrowser.innerHTML = `<span class="status-dot status-online"></span> Browser: 稼働中`;
          browserPowerState = 'active';
        } else {
          healthBrowser.innerHTML = `<span class="status-dot status-idle"></span> Browser: ${escapeHtml(String(msg.state ?? ''))}`;
        }
      }
      if (typeof msg.url === 'string' && isSafeHttpUrl(msg.url)) {
        hasLiveBrowserStatus = true;
        currentBrowserUrl = msg.url;
        updateSearchBarVisibility();
      }
      if (typeof msg.title === 'string') {
        currentBrowserTitle = msg.title;
      }
    } else if (msg.type === 'SERVER_METRICS') {
      if (msg.browserState === 'paused' && !(isSecondarySession && !isPrimarySessionActive)) {
        showSleepingScreen();
      }
    } else if (msg.type === 'RESOLUTION_CHANGED') {
      console.log(`[StreamingView] Server resolution updated to ${msg.width}x${msg.height}`);
      // Reset A/V sync baseline and buffers so encoder restart does not leave persistent drift
      avSync.reset();
      framePacer.reset();
      audioPlayer.resetJitterBuffer();
      decoder.clearPendingPackets();
    }
  };

  let disconnectSurvivalTimer: any = null;
  let lastReportedBufferedMs = -1;
  let lastReportedAudioBufferedMs = -1; // Issue #106

  const sendBufferFeedback = (force = false) => {
    if (!wsClient.isConnected()) return;

    const totalBufferedMs = getVideoPathBufferedMs(); // Issue #106: HUD と同じ共通集計関数を使用
    // Issue #106: 音声キュー滞留を別フィールドで報告する。サーバー側のスライディングウィンドウ
    // (getClientInFlightBufferMs) が映像経路だけを見て実滞留を過小評価する問題の解消。
    const audioBufferedMs = getAudioPathBufferedMs();
    const isInteractive = latencyController.getMode() === 'ACTIVE_INTERACTION';

    const actualRenderedPts =
      typeof framePacer.getLastRenderedPtsUs === 'function' ? framePacer.getLastRenderedPtsUs() : 0;
    const reportedPts =
      actualRenderedPts > 0 ? actualRenderedPts : lastDecodedPts > 0 ? lastDecodedPts : undefined;

    const ptsChanged = reportedPts !== undefined && reportedPts !== lastAckSentPts;
    const bufferDelta = Math.abs(totalBufferedMs - lastReportedBufferedMs);
    const audioDelta = Math.abs(audioBufferedMs - lastReportedAudioBufferedMs);

    if (!force && !ptsChanged && bufferDelta < 250 && audioDelta < 250) return;

    wsClient.send(
      ClientProtocol.packBufferFeedback({
        bufferedMs: totalBufferedMs,
        audioBufferedMs,
        targetBufferMs: clampBufferDepthMs(targetBufferMs),
        lastRenderedPts: reportedPts,
        isInteractive,
      }),
    );
    if (reportedPts !== undefined) {
      lastAckSentPts = reportedPts;
    }
    lastReportedBufferedMs = totalBufferedMs;
    lastReportedAudioBufferedMs = audioBufferedMs;
  };

  const handleOpen = () => {
    if (disconnectSurvivalTimer) {
      clearTimeout(disconnectSurvivalTimer);
      disconnectSurvivalTimer = null;
    }

    const totalBufferedMs = getVideoPathBufferedMs(); // Issue #106: 共通集計関数へ統一

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
    lastPongAtMs = 0;
    rttStaleCleared = false;

    if (connText) connText.textContent = '接続中';
    if (connDot) connDot.className = 'status-dot status-online';
    if (hudConn) hudConn.title = '接続状態: 接続中 (RTT計測待機)';
    if (isSecondarySession && !isPrimarySessionActive) {
      showRearStandbyScreen();
    } else if (browserPowerState === 'sleeping') {
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

    const totalBufferedMs = getVideoPathBufferedMs(); // Issue #106: 共通集計関数へ統一

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
    if (isEffectivelyPrimary()) {
      const audioStats = audioPlayer.getStats();
      if (audioStats.packetsReceived > 0 && audioStats.state === 'suspended') {
        if (!hasPromptedAudioUnlock) {
          hasPromptedAudioUnlock = true;
          showToast('画面をタップすると音声を再生します', 'info');
        }
      }
    }
  }, 1000);

  // 8. Navigation & Controls
  document.getElementById('hud-back-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    resetHudDimTimer();
    wsClient.send(ClientProtocol.packCommand({ type: 'NAVIGATE_BACK' }));
  });

  hudHomeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    resetHudDimTimer();
    const homeFav = resolveHomeFavorite(favorites, homeFavoriteId);
    navigateFromHud(homeFav.url);
  });

  favBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    resetHudDimTimer();
    toggleFavoritesDrawer();
  });

  favCloseBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavoritesDrawer(false);
  });

  favEditBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavoritesDrawer(false);
    onOpenSettings();
  });

  let isAddingCurrentFavorite = false;
  favAddCurrentBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    resetHudDimTimer();
    if (isAddingCurrentFavorite) return;
    if (!isSafeHttpUrl(currentBrowserUrl)) {
      showToast('現在のページURLはお気に入りに追加できません', 'error');
      return;
    }
    if (favorites.some((f) => f.url === currentBrowserUrl)) {
      showToast('このページは既にお気に入りに登録されています', 'info');
      return;
    }
    if (favorites.length >= 100) {
      showToast('お気に入りは最大100件まで登録できます', 'error');
      return;
    }
    const token =
      authToken || localStorage.getItem('tesroid_token') || sessionStorage.getItem('tesroid_token');
    if (!token) {
      showToast('認証トークンがないため保存できません', 'error');
      return;
    }

    let hostname = currentBrowserUrl;
    try {
      hostname = new URL(currentBrowserUrl).hostname;
    } catch {}
    let newId = `fav-${Date.now()}`;
    let suffix = 1;
    while (favorites.some((f) => f.id === newId)) {
      newId = `fav-${Date.now()}-${suffix++}`;
    }
    const newFav: FavoriteItem = {
      id: newId,
      title: currentBrowserTitle.trim() || hostname,
      url: currentBrowserUrl,
    };
    const nextFavorites = insertFavoritePreservingHome(favorites, newFav, homeFavoriteId);

    isAddingCurrentFavorite = true;
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ favorites: nextFavorites }),
      });
      if (!res.ok) {
        showToast(`お気に入りの追加に失敗しました (HTTP ${res.status})`, 'error');
        return;
      }
      const data = await res.json().catch(() => null);
      const savedFavorites = sanitizeFavorites(data?.settings?.favorites);
      favorites = savedFavorites ?? nextFavorites;
      if (
        typeof data?.settings?.homeFavoriteId === 'string' &&
        data.settings.homeFavoriteId.trim()
      ) {
        homeFavoriteId = data.settings.homeFavoriteId.trim();
      }
      updateHomeButtonTitle();
      renderFavoritesList();
      window.dispatchEvent(
        new CustomEvent('tesroid:settings-updated', {
          detail: { favorites: favorites.map((f) => ({ ...f })), homeFavoriteId },
        }),
      );
      showToast(`お気に入りに追加しました: ${newFav.title}`, 'success');
    } catch {
      showToast('お気に入りの追加に失敗しました', 'error');
    } finally {
      isAddingCurrentFavorite = false;
    }
  });

  // Search / Text Input Bar Handlers (Direct YouTube Search Navigation)
  searchForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = searchInput?.value?.trim() || '';
    if (text) {
      const searchUrl = /^https?:\/\//i.test(text)
        ? text
        : `https://www.youtube.com/results?search_query=${encodeURIComponent(text)}`;
      navigateFromHud(searchUrl);
      if (searchInput) {
        searchInput.value = '';
        searchInput.blur?.();
      }
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
  kbdBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    resetHudDimTimer();
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
    if (isSecondarySession && !isPrimarySessionActive) return;
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
    performIntentionalDisconnect();
  });

  // Settings
  document.getElementById('hud-settings-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    onOpenSettings();
  });

  // Cleanup function when navigating away
  return () => {
    if (disconnectReloadTimer) clearTimeout(disconnectReloadTimer);
    disconnectReloadTimer = null;
    isDisconnecting = false;
    if (disconnectSurvivalTimer) clearTimeout(disconnectSurvivalTimer);
    if (encoderRestartTimer) clearTimeout(encoderRestartTimer);
    if (resizeTimer) clearTimeout(resizeTimer);
    isRestartingEncoder = false;
    document.getElementById('power-menu-modal')?.remove();
    if (hudDimTimer) clearTimeout(hudDimTimer);
    window.removeEventListener('pointermove', resetHudDimTimer);
    window.removeEventListener('pointerdown', resetHudDimTimer);
    window.removeEventListener('resize', onResize);
    if (typeof avSync.setExternalMasterPtsProvider === 'function') {
      avSync.setExternalMasterPtsProvider(undefined);
    }
    canvas.removeEventListener('pointerdown', autoUnlockAudio);
    window.removeEventListener('pointerdown', autoUnlockAudio, { capture: true });
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
