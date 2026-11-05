import { type ChildProcess, spawn } from 'node:child_process';
import WebSocket from 'ws';

export interface TouchEventData {
  action: number; // 0: DOWN, 1: UP, 2: MOVE, 3: CANCEL
  pointerId: number;
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
}

interface CdpTouchState {
  x: number;
  y: number;
  id: number;
  startX: number;
  startY: number;
  startTime: number;
  lastTime: number;
  hasMoved: boolean;
}

/**
 * CDP Touch Bridge: Injects native touch gestures directly into Chrome's Blink input pipeline.
 * Enables true capacitive touch physics (momentum flick, tap-to-click, pinch zoom) with < 1ms latency.
 */
class CdpTouchBridge {
  private ws: WebSocket | null = null;
  private isConnecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private msgId = 1;
  private activeTouches: Map<number, CdpTouchState> = new Map();
  private debouncedPointers: Set<number> = new Set();
  private static readonly SLOP_THRESHOLD = 8; // 8px touch slop to prevent micro-move canceling clicks
  private static readonly TAP_DEBOUNCE_MS = 80; // 80ms touch chatter / bounce suppression
  private static readonly TAP_DEBOUNCE_DIST = 15; // 15px radius for bounce detection
  private static readonly STALE_TOUCH_TIMEOUT_MS = 2500; // Auto-expire stuck touches after 2.5s of inactivity
  private lastTapEndTime = 0;
  private lastTapX = 0;
  private lastTapY = 0;

  constructor() {
    this.connect();
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public async connect(): Promise<boolean> {
    if (this.isConnecting || this.isConnected()) return this.isConnected();
    this.isConnecting = true;

    try {
      const res = await fetch('http://127.0.0.1:9222/json/list', {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = (await res.json()) as any[];
      const page = list.find((t: any) => t.type === 'page');

      if (!page || !page.webSocketDebuggerUrl) {
        this.isConnecting = false;
        this.scheduleReconnect();
        return false;
      }

      const socket = new WebSocket(page.webSocketDebuggerUrl);

      await new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => {
          socket.close();
          reject(new Error('CDP connect timeout'));
        }, 3000);

        socket.on('open', () => {
          clearTimeout(to);
          this.ws = socket;
          this.activeTouches.clear();
          this.debouncedPointers.clear();
          console.log('[CdpTouchBridge] Connected to Chrome DevTools Protocol for native touch.');
          this.setupCarOptimizations();
          resolve();
        });

        socket.on('error', (err) => {
          clearTimeout(to);
          reject(err);
        });
      });

      this.ws?.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.error) {
            // If Chrome reports a touch state error (e.g., "Must send a TouchStart first"), reset state immediately
            this.activeTouches.clear();
            this.debouncedPointers.clear();
          }
        } catch {}
      });

      this.ws?.on('close', () => {
        console.log('[CdpTouchBridge] CDP connection closed. Scheduling reconnect...');
        this.ws = null;
        this.activeTouches.clear();
        this.debouncedPointers.clear();
        this.scheduleReconnect();
      });

      this.ws?.on('error', () => {
        this.ws = null;
        this.activeTouches.clear();
        this.debouncedPointers.clear();
        this.scheduleReconnect();
      });

      this.isConnecting = false;
      return true;
    } catch (err) {
      this.isConnecting = false;
      this.scheduleReconnect();
      return false;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {});
    }, 2000);
  }

  public send(method: string, params: Record<string, any> = {}): void {
    if (!this.isConnected()) {
      this.connect().catch(() => {});
      return;
    }
    const id = this.msgId++;
    try {
      this.ws!.send(JSON.stringify({ id, method, params }));
    } catch {
      this.ws = null;
      this.activeTouches.clear();
      this.debouncedPointers.clear();
      this.scheduleReconnect();
    }
  }

  private pruneStaleTouches(now: number): void {
    if (this.activeTouches.size === 0) return;
    let pruned = false;
    for (const [id, touch] of this.activeTouches.entries()) {
      if (now - touch.lastTime > CdpTouchBridge.STALE_TOUCH_TIMEOUT_MS) {
        this.activeTouches.delete(id);
        pruned = true;
      }
    }
    if (pruned && this.activeTouches.size === 0) {
      this.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    }
  }

  public handleTouch(action: number, pointerId: number, x: number, y: number): boolean {
    if (!this.isConnected()) return false;

    const now = performance.now();
    this.pruneStaleTouches(now);

    // DOWN or POINTER_DOWN (action 0 or 5)
    if (action === 0 || action === 5) {
      // If primary single-finger DOWN (action 0) arrives while previous touches were left dangling,
      // force-reset Chrome's internal touch state machine before starting the new touch.
      if (action === 0 && this.activeTouches.size > 0) {
        this.activeTouches.clear();
        this.debouncedPointers.clear();
        this.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      }

      // Debounce hardware contact bounce / rapid duplicate touchstart
      if (
        action === 0 &&
        now - this.lastTapEndTime < CdpTouchBridge.TAP_DEBOUNCE_MS &&
        Math.hypot(x - this.lastTapX, y - this.lastTapY) < CdpTouchBridge.TAP_DEBOUNCE_DIST
      ) {
        this.debouncedPointers.add(pointerId);
        return true; // Filter out chatter DOWN
      }

      this.debouncedPointers.delete(pointerId);
      this.activeTouches.set(pointerId, {
        x,
        y,
        id: pointerId,
        startX: x,
        startY: y,
        startTime: now,
        lastTime: now,
        hasMoved: false,
      });

      const touchPoints = Array.from(this.activeTouches.values()).map((t) => ({
        x: t.x,
        y: t.y,
        id: t.id,
      }));
      this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
      return true;
    }

    // MOVE (action 2)
    if (action === 2) {
      let state = this.activeTouches.get(pointerId);
      if (!state) {
        // If this pointer was debounced on DOWN but the user is actually dragging/scrolling,
        // promote it by dispatching touchStart first so Chrome accepts the touchMove sequence.
        if (this.debouncedPointers.has(pointerId)) {
          const distFromTap = Math.hypot(x - this.lastTapX, y - this.lastTapY);
          if (distFromTap < CdpTouchBridge.SLOP_THRESHOLD) {
            return true;
          }
          this.debouncedPointers.delete(pointerId);
          state = {
            x,
            y,
            id: pointerId,
            startX: this.lastTapX,
            startY: this.lastTapY,
            startTime: now,
            lastTime: now,
            hasMoved: true,
          };
          this.activeTouches.set(pointerId, state);
          const startPoints = Array.from(this.activeTouches.values()).map((t) => ({
            x: t.startX,
            y: t.startY,
            id: t.id,
          }));
          this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: startPoints });
        } else {
          // CRITICAL: Ignore unpaired/hover MOVE events so activeTouches is never poisoned!
          return true;
        }
      } else {
        state.x = x;
        state.y = y;
        state.lastTime = now;

        // Check if movement exceeds touch slop threshold
        if (!state.hasMoved) {
          const dist = Math.hypot(x - state.startX, y - state.startY);
          if (dist < CdpTouchBridge.SLOP_THRESHOLD) {
            // Suppress micro-movement jitter so Blink won't cancel synthetic clicks
            return true;
          }
          state.hasMoved = true;
        }
      }

      const touchPoints = Array.from(this.activeTouches.values()).map((t) => ({
        x: t.x,
        y: t.y,
        id: t.id,
      }));
      this.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints });
      return true;
    }

    // UP or CANCEL or POINTER_UP (action 1, 3, or 6)
    if (action === 1 || action === 3 || action === 6) {
      if (this.debouncedPointers.delete(pointerId) && !this.activeTouches.has(pointerId)) {
        return true;
      }

      const state = this.activeTouches.get(pointerId);
      if (!state && this.activeTouches.size === 0) {
        return true;
      }

      const tapX = state ? state.startX : x;
      const tapY = state ? state.startY : y;

      this.lastTapEndTime = now;
      this.lastTapX = tapX;
      this.lastTapY = tapY;

      // For primary UP (1) or CANCEL (3), all fingers are lifted: unconditionally clear activeTouches
      // so a single missed multi-touch release can never prevent touchEnd from firing.
      if (action === 1 || action === 3) {
        this.activeTouches.clear();
        this.debouncedPointers.clear();
        this.send('Input.dispatchTouchEvent', {
          type: action === 3 ? 'touchCancel' : 'touchEnd',
          touchPoints: [],
        });
        return true;
      }

      // Secondary finger lifted (POINTER_UP = 6)
      this.activeTouches.delete(pointerId);

      const touchPoints = Array.from(this.activeTouches.values()).map((t) => ({
        x: t.x,
        y: t.y,
        id: t.id,
      }));

      this.send('Input.dispatchTouchEvent', {
        type: touchPoints.length > 0 ? 'touchMove' : 'touchEnd',
        touchPoints,
      });

      return true;
    }

    return false;
  }

  public reload(): boolean {
    if (!this.isConnected()) return false;
    this.send('Page.reload');
    return true;
  }

  public navigateHistory(direction: 'back' | 'forward'): boolean {
    if (!this.isConnected()) return false;
    const expr = direction === 'back' ? 'window.history.back()' : 'window.history.forward()';
    this.send('Runtime.evaluate', { expression: expr });
    return true;
  }

  public toggleVideoFullscreen(): boolean {
    if (!this.isConnected()) return false;
    const expr = `
      (() => {
        if (typeof window.tesroidToggleFs === 'function') {
          window.tesroidToggleFs();
          return true;
        }
        const fsBtn = document.querySelector('.ytp-fullscreen-button');
        if (fsBtn) {
          fsBtn.click();
          return true;
        }
        const video = document.querySelector('video');
        if (video && video.requestFullscreen) {
          video.requestFullscreen();
          return true;
        }
        return false;
      })()
    `;
    this.send('Runtime.evaluate', { expression: expr });
    return true;
  }

  private setupCarOptimizations(): void {
    if (!this.isConnected()) return;

    const script = `
      (() => {
        // WebAuthn / Passkey Dialog Suppressor (Issue #35)
        // Docker/Xvfb環境には物理・プラットフォームFIDO2認証器が存在せず、ChromeネイティブのWebAuthn
        // バブルダイアログ（"No passkeys available"）が表示されると車載タッチ操作（DOM注入）では
        // 閉じられず操作不能になるため、WebAuthn API呼び出しをインターセプトして安全に拒否・無効化する。
        try {
          if (typeof window.PublicKeyCredential !== 'undefined') {
            try {
              window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
            } catch {
              Object.defineProperty(window.PublicKeyCredential, 'isUserVerifyingPlatformAuthenticatorAvailable', {
                value: () => Promise.resolve(false),
                configurable: true,
                writable: true,
              });
            }
            if (typeof window.PublicKeyCredential.isConditionalMediationAvailable === 'function') {
              try {
                window.PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
              } catch {
                Object.defineProperty(window.PublicKeyCredential, 'isConditionalMediationAvailable', {
                  value: () => Promise.resolve(false),
                  configurable: true,
                  writable: true,
                });
              }
            }
          }
        } catch (e) {}

        try {
          if (typeof navigator !== 'undefined' && navigator.credentials && !navigator.credentials._tesroidWebAuthnHooked) {
            navigator.credentials._tesroidWebAuthnHooked = true;

            const createNotAllowedError = (msg) => {
              if (typeof DOMException !== 'undefined') {
                return new DOMException(msg, 'NotAllowedError');
              }
              const err = new Error(msg);
              err.name = 'NotAllowedError';
              return err;
            };

            if (typeof navigator.credentials.get === 'function') {
              const origGet = navigator.credentials.get.bind(navigator.credentials);
              navigator.credentials.get = async function(options) {
                if (options && options.publicKey) {
                  throw createNotAllowedError('Passkeys are not supported in this environment.');
                }
                return origGet(options);
              };
            }

            if (typeof navigator.credentials.create === 'function') {
              const origCreate = navigator.credentials.create.bind(navigator.credentials);
              navigator.credentials.create = async function(options) {
                if (options && options.publicKey) {
                  throw createNotAllowedError('Passkeys are not supported in this environment.');
                }
                return origCreate(options);
              };
            }
          }
        } catch (e) {}

        if (window._tesroidBridgeActive) return;
        window._tesroidBridgeActive = true;

        const applyStyles = () => {
          const root = document.head || document.documentElement || document.body;
          if (!root) return;
          if (document.documentElement && !document.documentElement.style.getPropertyValue('--tesroid-zoom')) {
            const scale = typeof window.__tesroidDisplayScale === 'number' ? window.__tesroidDisplayScale : 120;
            document.documentElement.style.setProperty('--tesroid-zoom', String(scale / 100));
          }
          let el = document.getElementById('tesroid-car-style');
          if (!el) {
            el = document.createElement('style');
            el.id = 'tesroid-car-style';
            el.textContent = [
              'html:not(.tesroid-web-fs-root) { zoom: var(--tesroid-zoom, 1.2) !important; }',
              'html.tesroid-web-fs-root { zoom: 1 !important; }',
              '::-webkit-scrollbar { width: 4px !important; height: 4px !important; }',
              '::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2) !important; border-radius: 2px !important; }',
              'body.tesroid-web-fs-active { overflow: hidden !important; background: #000 !important; zoom: 1 !important; }',
              'body.tesroid-web-fs-active ytd-masthead, body.tesroid-web-fs-active #masthead-container, body.tesroid-web-fs-active #guide-wrapper, body.tesroid-web-fs-active #secondary, body.tesroid-web-fs-active #below, body.tesroid-web-fs-active #comments { display: none !important; }',
              'body.tesroid-web-fs-active #movie_player, body.tesroid-web-fs-active .html5-video-player { position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; max-width: 100vw !important; max-height: 100vh !important; z-index: 2147483647 !important; }',
              'body.tesroid-web-fs-active #movie_player video, body.tesroid-web-fs-active .html5-video-player video { width: 100% !important; height: 100% !important; top: 0 !important; left: 0 !important; object-fit: contain !important; }',
              'body.tesroid-web-fs-active .tesroid-generic-fs-target { position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2147483647 !important; background: #000 !important; object-fit: contain !important; }'
            ].join('\\n');
            root.appendChild(el);
          }
        };

        applyStyles();
        document.addEventListener('DOMContentLoaded', applyStyles);

        let activeFsEl = null;

        window.tesroidEnterFs = (el) => {
          activeFsEl = el || document.getElementById('movie_player') || document.querySelector('video');
          applyStyles();
          document.documentElement?.classList.add('tesroid-web-fs-root');
          document.body.classList.add('tesroid-web-fs-active');

          const flexy = document.querySelector('ytd-watch-flexy');
          if (flexy) {
            flexy.removeAttribute('fullscreen');
          }

          const player = document.getElementById('movie_player') || (activeFsEl && activeFsEl.closest ? activeFsEl.closest('#movie_player') : null);
          if (player) {
            player.classList.add('ytp-fullscreen');
            try { player.setFauxFullscreen?.(true); } catch {}
          } else if (activeFsEl) {
            activeFsEl.classList.add('tesroid-generic-fs-target');
          }

          const fsEvent = new Event('fullscreenchange', { bubbles: true });
          document.dispatchEvent(fsEvent);
          activeFsEl?.dispatchEvent?.(fsEvent);
          window.dispatchEvent(new Event('resize'));
        };

        window.tesroidExitFs = () => {
          document.documentElement?.classList.remove('tesroid-web-fs-root');
          document.body.classList.remove('tesroid-web-fs-active');

          const flexy = document.querySelector('ytd-watch-flexy');
          if (flexy) {
            flexy.removeAttribute('fullscreen');
          }

          const player = document.getElementById('movie_player');
          if (player) {
            player.classList.remove('ytp-fullscreen');
            try { player.setFauxFullscreen?.(false); } catch {}
          }

          if (activeFsEl) {
            activeFsEl.classList.remove('tesroid-generic-fs-target');
            activeFsEl = null;
          }

          const fsEvent = new Event('fullscreenchange', { bubbles: true });
          document.dispatchEvent(fsEvent);
          window.dispatchEvent(new Event('resize'));
        };

        window.tesroidToggleFs = () => {
          if (activeFsEl || document.body.classList.contains('tesroid-web-fs-active')) {
            window.tesroidExitFs();
          } else {
            window.tesroidEnterFs();
          }
        };

        // DOM Fullscreen API overrides
        Element.prototype.requestFullscreen = function() {
          window.tesroidEnterFs(this);
          return Promise.resolve();
        };
        Element.prototype.webkitRequestFullscreen = function() {
          window.tesroidEnterFs(this);
        };
        Element.prototype.webkitRequestFullScreen = function() {
          window.tesroidEnterFs(this);
        };

        document.exitFullscreen = function() {
          window.tesroidExitFs();
          return Promise.resolve();
        };
        document.webkitExitFullscreen = function() {
          window.tesroidExitFs();
        };

        Object.defineProperty(document, 'fullscreenElement', {
          get: () => activeFsEl,
          configurable: true,
        });
        Object.defineProperty(document, 'webkitFullscreenElement', {
          get: () => activeFsEl,
          configurable: true,
        });
        Object.defineProperty(document, 'fullscreen', {
          get: () => !!activeFsEl,
          configurable: true,
        });
        Object.defineProperty(document, 'webkitIsFullScreen', {
          get: () => !!activeFsEl,
          configurable: true,
        });

        // Escape key exits fullscreen
        window.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && (activeFsEl || document.body.classList.contains('tesroid-web-fs-active'))) {
            e.preventDefault();
            e.stopPropagation();
            window.tesroidExitFs();
          }
        }, true);

        // Reset on YouTube SPA navigation
        window.addEventListener('yt-navigate-start', () => {
          if (document.body.classList.contains('tesroid-web-fs-active')) {
            window.tesroidExitFs();
          }
        });

        // Hook YouTube player toggle
        const patchYtPlayer = () => {
          const player = document.getElementById('movie_player');
          if (player && !player._tesroidFsHooked) {
            player._tesroidFsHooked = true;
            player.toggleFullscreen = function() {
              if (activeFsEl || document.body.classList.contains('tesroid-web-fs-active')) {
                window.tesroidExitFs();
              } else {
                window.tesroidEnterFs(player);
              }
            };
          }
        };
        patchYtPlayer();
        setInterval(patchYtPlayer, 1000);

        // Hook YouTube native fullscreen button directly
        const hookFsButton = () => {
          const btn = document.querySelector('.ytp-fullscreen-button');
          if (btn && !btn._tesroidHooked) {
            btn._tesroidHooked = true;
            btn.removeAttribute('aria-disabled');
            btn.removeAttribute('disabled');
            btn.style.pointerEvents = 'auto';
            btn.style.opacity = '1';
            btn.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              window.tesroidToggleFs();
            }, true);
          }
        };
        hookFsButton();
        setInterval(hookFsButton, 1000);
      })()
    `;

    this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    this.send('Page.enable');
    this.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
    this.send('Runtime.evaluate', { expression: script });
  }

  public close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}

export class X11InputManager {
  private displayNum: string;
  private displayWidth: number;
  private displayHeight: number;

  private cdpBridge: CdpTouchBridge;
  private xdotoolProcess: ChildProcess | null = null;
  private isMouseDown = false;
  private isScrolling = false;

  // Touch tracking for xdotool fallback
  private touchStartX = 0;
  private touchStartY = 0;
  private lastTouchY = 0;
  private totalMoveDistance = 0;
  private touchStartTime = 0;
  private scrollAccumulator = 0;
  private inertiaTimer: NodeJS.Timeout | null = null;

  constructor(displayNum = ':99', displayWidth = 1280, displayHeight = 720) {
    this.displayNum = displayNum;
    this.displayWidth = displayWidth;
    this.displayHeight = displayHeight;
    this.cdpBridge = new CdpTouchBridge();
  }

  public updateDimensions(width: number, height: number): void {
    this.displayWidth = width;
    this.displayHeight = height;
  }

  private initProcess(): void {
    try {
      this.xdotoolProcess = spawn('xdotool', ['-'], {
        env: { ...process.env, DISPLAY: this.displayNum },
        stdio: ['pipe', 'ignore', 'ignore'],
      });

      this.xdotoolProcess.on('exit', () => {
        this.xdotoolProcess = null;
      });
    } catch (err) {
      console.warn('[X11InputManager] Failed to spawn xdotool:', err);
    }
  }

  private sendCommand(cmd: string): void {
    if (!this.xdotoolProcess || !this.xdotoolProcess.stdin || !this.xdotoolProcess.stdin.writable) {
      this.initProcess();
    }
    if (this.xdotoolProcess?.stdin?.writable) {
      this.xdotoolProcess.stdin.write(`${cmd}\n`);
    }
  }

  private triggerInertia(button: number, clicks: number): void {
    if (this.inertiaTimer) clearInterval(this.inertiaTimer);
    let remaining = clicks;
    this.inertiaTimer = setInterval(() => {
      if (remaining <= 0) {
        if (this.inertiaTimer) clearInterval(this.inertiaTimer);
        this.inertiaTimer = null;
        return;
      }
      this.sendCommand(`click ${button}`);
      remaining--;
    }, 45);
  }

  /**
   * Handle touch events from Tesla browser
   * Prioritizes CDP native touch injection, falls back to xdotool if CDP is disconnected.
   */
  public handleTouchEvent(e: TouchEventData): void {
    if (!e.screenWidth || !e.screenHeight) return;

    // Scale client coordinate to X11 display resolution (CSS pixels)
    const targetX = Math.max(
      0,
      Math.min(this.displayWidth - 1, Math.round((e.x / e.screenWidth) * this.displayWidth)),
    );
    const targetY = Math.max(
      0,
      Math.min(this.displayHeight - 1, Math.round((e.y / e.screenHeight) * this.displayHeight)),
    );

    // Try native CDP touch injection first (flawless native mobile/tablet touch)
    if (this.cdpBridge.handleTouch(e.action, e.pointerId, targetX, targetY)) {
      return;
    }

    // Fallback: X11 / xdotool emulation
    const now = Date.now();

    switch (e.action) {
      case 0: // DOWN
        if (this.inertiaTimer) {
          clearInterval(this.inertiaTimer);
          this.inertiaTimer = null;
        }
        this.touchStartX = targetX;
        this.touchStartY = targetY;
        this.lastTouchY = targetY;
        this.totalMoveDistance = 0;
        this.touchStartTime = now;
        this.scrollAccumulator = 0;
        this.isScrolling = false;
        this.isMouseDown = true;
        this.sendCommand(`mousemove ${targetX} ${targetY}`);
        this.sendCommand(`mousedown 1`);
        break;

      case 2: // MOVE
        if (this.isMouseDown || this.isScrolling) {
          const deltaY = targetY - this.lastTouchY;
          const dist = Math.hypot(targetX - this.touchStartX, targetY - this.touchStartY);
          this.totalMoveDistance = Math.max(this.totalMoveDistance, dist);
          this.lastTouchY = targetY;

          // Vertical scrolling detected (threshold: 8px)
          if (this.isScrolling || Math.abs(deltaY) > 8) {
            if (!this.isScrolling) {
              if (this.isMouseDown) {
                this.sendCommand(`mouseup 1`);
                this.isMouseDown = false;
              }
              this.isScrolling = true;
            }

            this.scrollAccumulator += deltaY;
            const threshold = 10;
            while (Math.abs(this.scrollAccumulator) >= threshold) {
              const scrollButton = this.scrollAccumulator < 0 ? 5 : 4;
              this.sendCommand(`click ${scrollButton}`);
              if (this.scrollAccumulator < 0) {
                this.scrollAccumulator += threshold;
              } else {
                this.scrollAccumulator -= threshold;
              }
            }
          } else if (this.isMouseDown) {
            this.sendCommand(`mousemove ${targetX} ${targetY}`);
          }
        }
        break;

      case 1: // UP
      case 3: // CANCEL
        if (this.isScrolling) {
          this.isScrolling = false;
          this.isMouseDown = false;
          this.scrollAccumulator = 0;

          const duration = now - this.touchStartTime;
          const totalDeltaY = targetY - this.touchStartY;
          const velocity = totalDeltaY / Math.max(1, duration);
          if (Math.abs(velocity) > 0.4) {
            const flickButton = velocity < 0 ? 5 : 4;
            const flickCount = Math.min(8, Math.round(Math.abs(velocity) * 5));
            this.triggerInertia(flickButton, flickCount);
          }
        } else if (this.isMouseDown) {
          this.isMouseDown = false;
          this.sendCommand(`mousemove ${targetX} ${targetY}`);
          this.sendCommand(`mouseup 1`);
        }
        break;

      default:
        break;
    }
  }

  public sendKey(key: string): void {
    this.sendCommand(`key ${key}`);
  }

  public navigateBack(): void {
    if (!this.cdpBridge.navigateHistory('back')) {
      this.sendCommand('key alt+Left');
    }
  }

  public navigateForward(): void {
    if (!this.cdpBridge.navigateHistory('forward')) {
      this.sendCommand('key alt+Right');
    }
  }

  public reloadPage(): void {
    if (!this.cdpBridge.reload()) {
      this.sendCommand('key ctrl+r');
    }
  }

  public toggleFullscreen(): void {
    this.sendCommand('key f');
  }

  public toggleVideoFullscreen(): void {
    if (!this.cdpBridge.toggleVideoFullscreen()) {
      this.sendCommand('key f');
    }
  }

  public close(): void {
    this.cdpBridge.close();
    if (this.inertiaTimer) {
      clearInterval(this.inertiaTimer);
      this.inertiaTimer = null;
    }
    if (this.xdotoolProcess) {
      try {
        this.xdotoolProcess.stdin?.end();
        this.xdotoolProcess.kill();
      } catch {}
      this.xdotoolProcess = null;
    }
  }
}
