(() => {
  if (window._tesroidExtensionLoaded) return;
  window._tesroidExtensionLoaded = true;

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

  try {
    // Set YouTube Dark Theme & Theater mode cookies
    document.cookie = 'PREF=f6=400&wide=1; domain=.youtube.com; path=/; max-age=31536000';
  } catch (e) {}

  if (typeof window.__tesroidDisplayScale !== 'number') {
    window.__tesroidDisplayScale = 120;
  }

  // Note: The section between TESROID_FULLSCREEN_CORE_START and TESROID_FULLSCREEN_CORE_END
  // is the single source of truth loaded directly by server/src/browser/fullscreen-script.ts
  // for BrowserManager and CdpTouchBridge.
  // === TESROID_FULLSCREEN_CORE_START ===
  if (!window._tesroidFullscreenInstalled) {
    window._tesroidFullscreenInstalled = true;
    window._tesroidBridgeActive = true;

    const clampScale = (scalePercent) => {
      const num = Number(scalePercent);
      return !isNaN(num) && num >= 50 && num <= 250 ? Math.round(num) : 120;
    };

    const applyStyles = () => {
      const root = document.head || document.documentElement || document.body;
      if (!root) return;
      const scale = clampScale(window.__tesroidDisplayScale);
      if (document.documentElement?.style && !document.documentElement.style.getPropertyValue('--tesroid-zoom')) {
        document.documentElement.style.setProperty('--tesroid-zoom', String(scale / 100));
      }
      let el = document.getElementById('tesroid-car-style');
      if (!el) {
        el = document.createElement('style');
        el.id = 'tesroid-car-style';
        el.textContent = [
          '/* Car display readable zoom (default 120%), disabled during video fullscreen */',
          'html:not(.tesroid-web-fs-root) { zoom: var(--tesroid-zoom, 1.2) !important; }',
          'html.tesroid-web-fs-root { zoom: 1 !important; }',
          '',
          '/* Subtle minimalist scrollbar */',
          '::-webkit-scrollbar { width: 4px !important; height: 4px !important; }',
          '::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2) !important; border-radius: 2px !important; }',
          '',
          '/* Web Fullscreen in Tesla window */',
          'html.tesroid-web-fs-root, body.tesroid-web-fs-active { overflow: hidden !important; background: #000 !important; zoom: 1 !important; }',
          'body.tesroid-web-fs-active ytd-masthead,',
          'body.tesroid-web-fs-active #masthead-container,',
          'body.tesroid-web-fs-active #guide-wrapper,',
          'body.tesroid-web-fs-active #secondary,',
          'body.tesroid-web-fs-active #below,',
          'body.tesroid-web-fs-active #comments,',
          'body.tesroid-web-fs-active #cinematics,',
          'body.tesroid-web-fs-active ytd-watch-flexy #cinematics,',
          'body.tesroid-web-fs-active .player-container-background,',
          'body.tesroid-web-fs-active .player-container-background-image { display: none !important; }',
          'body.tesroid-web-fs-active #movie_player,',
          'body.tesroid-web-fs-active .html5-video-player { position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; max-width: 100vw !important; max-height: 100vh !important; margin: 0 !important; background: #000 !important; z-index: 2147483647 !important; }',
          'body.tesroid-web-fs-active #movie_player .html5-video-container,',
          'body.tesroid-web-fs-active .html5-video-player .html5-video-container { position: relative !important; width: 100% !important; height: 100% !important; top: 0 !important; left: 0 !important; }',
          'body.tesroid-web-fs-active #movie_player video,',
          'body.tesroid-web-fs-active .html5-video-player video { position: absolute !important; width: 100% !important; height: 100% !important; max-width: 100% !important; max-height: 100% !important; top: 0 !important; left: 0 !important; object-fit: contain !important; }',
          'body.tesroid-web-fs-active .tesroid-generic-fs-target { position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; max-width: 100vw !important; max-height: 100vh !important; margin: 0 !important; z-index: 2147483647 !important; background: #000 !important; object-fit: contain !important; }',
          'body.tesroid-web-fs-active .tesroid-generic-fs-target video { width: 100% !important; height: 100% !important; max-width: 100% !important; max-height: 100% !important; object-fit: contain !important; }',
        ].join('\n');
        root.appendChild(el);
      }
    };

    window.tesroidSetZoom = (scalePercent) => {
      const clamped = clampScale(scalePercent);
      window.__tesroidDisplayScale = clamped;
      if (document.documentElement?.style) {
        document.documentElement.style.setProperty('--tesroid-zoom', String(clamped / 100));
      }
      applyStyles();
      window.dispatchEvent(new Event('resize'));
    };

    applyStyles();
    document.addEventListener?.('DOMContentLoaded', applyStyles);

    // Web Fullscreen Interceptor
    let activeFsEl = null;

    const isFsActive = () =>
      !!(
        activeFsEl ||
        document.body?.classList?.contains('tesroid-web-fs-active') ||
        document.documentElement?.classList?.contains('tesroid-web-fs-root')
      );

    // Prevent YouTube's 2s fullscreen screen-size check (window.screen * 0.9 vs window.outerWidth/Height)
    // from disabling .ytp-fullscreen-button and showing "Fullscreen is unavailable" on 1920x1080 Xvfb
    // when Chrome's viewport window is smaller (e.g. 1256x658 or 1160x830).
    try {
      const scr = typeof window !== 'undefined' ? window.screen : null;
      if (scr) {
        const proto = typeof Screen !== 'undefined' ? Screen.prototype : null;
        const readOrig = (prop, fallback) => {
          const desc = proto ? Object.getOwnPropertyDescriptor(proto, prop) : null;
          if (desc && typeof desc.get === 'function') {
            try {
              return desc.get.call(scr);
            } catch {}
          }
          return fallback;
        };
        const origW = typeof scr.width === 'number' ? scr.width : 1920;
        const origH = typeof scr.height === 'number' ? scr.height : 1080;
        const origAW = typeof scr.availWidth === 'number' ? scr.availWidth : origW;
        const origAH = typeof scr.availHeight === 'number' ? scr.availHeight : origH;

        const getWinW = () =>
          Math.max(
            typeof window.outerWidth === 'number' ? window.outerWidth : 0,
            typeof window.innerWidth === 'number' ? window.innerWidth : 0,
          );
        const getWinH = () =>
          Math.max(
            typeof window.outerHeight === 'number' ? window.outerHeight : 0,
            typeof window.innerHeight === 'number' ? window.innerHeight : 0,
          );

        const defineScreenProp = (prop, getWinDim, origFallback) => {
          try {
            Object.defineProperty(scr, prop, {
              get: () => {
                if (isFsActive()) {
                  const dim = getWinDim();
                  if (dim > 0) return dim;
                }
                return readOrig(prop, origFallback);
              },
              configurable: true,
            });
          } catch {}
        };

        defineScreenProp('width', getWinW, origW);
        defineScreenProp('availWidth', getWinW, origAW);
        defineScreenProp('height', getWinH, origH);
        defineScreenProp('availHeight', getWinH, origAH);
      }
    } catch {}

    const dispatchFsEvents = (target) => {
      for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
        if (target && typeof target.dispatchEvent === 'function') {
          target.dispatchEvent(new Event(type, { bubbles: true }));
        }
        if (!target || !target.isConnected) {
          document.dispatchEvent(new Event(type, { bubbles: true }));
        }
      }
    };

    const ensureFsButtonReady = () => {
      const btns =
        typeof document.querySelectorAll === 'function'
          ? document.querySelectorAll('.ytp-fullscreen-button')
          : (() => {
              const single = document.querySelector?.('.ytp-fullscreen-button');
              return single ? [single] : [];
            })();

      for (let i = 0; i < btns.length; i++) {
        const btn = btns[i];
        if (!btn) continue;
        if (!btn.hasAttribute || btn.hasAttribute('aria-disabled')) {
          btn.removeAttribute?.('aria-disabled');
        }
        if (!btn.hasAttribute || btn.hasAttribute('disabled')) {
          btn.removeAttribute?.('disabled');
        }
        if (btn.style) {
          if (btn.style.pointerEvents !== 'auto') btn.style.pointerEvents = 'auto';
          if (btn.style.opacity !== '1') btn.style.opacity = '1';
        }
        if (!btn._tesroidHooked && typeof btn.addEventListener === 'function') {
          btn._tesroidHooked = true;
          btn.addEventListener('click', (e) => {
            if (e?._tesroidFsHandled) return;
            if (e) e._tesroidFsHandled = true;
            e?.preventDefault?.();
            e?.stopPropagation?.();
            e?.stopImmediatePropagation?.();
            window.tesroidToggleFs();
          }, true);
        }
      }
    };

    window.tesroidEnterFs = (el) => {
      const nextEl = el || document.getElementById('movie_player') || document.querySelector('video');
      if (activeFsEl && activeFsEl !== nextEl) {
        activeFsEl.classList?.remove?.('tesroid-generic-fs-target');
      }
      activeFsEl = nextEl;
      applyStyles();
      document.documentElement?.classList?.add('tesroid-web-fs-root');
      document.body?.classList?.add('tesroid-web-fs-active');

      const flexy = document.querySelector('ytd-watch-flexy');
      if (flexy) {
        flexy.removeAttribute('fullscreen');
      }

      const player = document.getElementById('movie_player') || activeFsEl?.closest?.('#movie_player');
      if (player) {
        player.classList.add('ytp-fullscreen');
        try { player.setFauxFullscreen?.(true); } catch {}
      } else if (activeFsEl) {
        activeFsEl.classList?.add?.('tesroid-generic-fs-target');
      }

      ensureFsButtonReady();
      dispatchFsEvents(activeFsEl);
      window.dispatchEvent(new Event('resize'));
    };

    window.tesroidExitFs = () => {
      if (!isFsActive()) {
        return;
      }
      const prevEl = activeFsEl;
      activeFsEl = null;
      document.documentElement?.classList?.remove('tesroid-web-fs-root');
      document.body?.classList?.remove('tesroid-web-fs-active');

      const flexy = document.querySelector('ytd-watch-flexy');
      if (flexy) {
        flexy.removeAttribute('fullscreen');
      }

      const player = document.getElementById('movie_player');
      if (player) {
        player.classList.remove('ytp-fullscreen');
        try { player.setFauxFullscreen?.(false); } catch {}
      }

      if (prevEl) {
        prevEl.classList?.remove?.('tesroid-generic-fs-target');
      }

      ensureFsButtonReady();
      dispatchFsEvents(prevEl || player);
      window.dispatchEvent(new Event('resize'));
    };

    window.tesroidToggleFs = () => {
      if (isFsActive()) {
        window.tesroidExitFs();
      } else {
        window.tesroidEnterFs();
      }
    };

    // Override DOM Fullscreen APIs
    Element.prototype.requestFullscreen = function() {
      window.tesroidEnterFs(this);
      return Promise.resolve();
    };
    Element.prototype.webkitRequestFullscreen = function() {
      window.tesroidEnterFs(this);
      return Promise.resolve();
    };
    Element.prototype.webkitRequestFullScreen = function() {
      window.tesroidEnterFs(this);
      return Promise.resolve();
    };

    if (typeof HTMLVideoElement !== 'undefined' && HTMLVideoElement.prototype) {
      HTMLVideoElement.prototype.webkitEnterFullscreen = function() {
        window.tesroidEnterFs(this);
      };
      HTMLVideoElement.prototype.webkitEnterFullScreen = function() {
        window.tesroidEnterFs(this);
      };
      HTMLVideoElement.prototype.webkitExitFullscreen = function() {
        window.tesroidExitFs();
      };
      HTMLVideoElement.prototype.webkitExitFullScreen = function() {
        window.tesroidExitFs();
      };
    }

    document.exitFullscreen = function() {
      window.tesroidExitFs();
      return Promise.resolve();
    };
    document.webkitExitFullscreen = function() {
      window.tesroidExitFs();
      return Promise.resolve();
    };
    document.webkitCancelFullScreen = function() {
      window.tesroidExitFs();
      return Promise.resolve();
    };

    const defineDocProp = (name, getter) => {
      try {
        Object.defineProperty(document, name, {
          get: getter,
          configurable: true,
        });
      } catch {}
    };
    defineDocProp('fullscreenEnabled', () => true);
    defineDocProp('webkitFullscreenEnabled', () => true);
    defineDocProp('fullscreenElement', () => activeFsEl);
    defineDocProp('webkitFullscreenElement', () => activeFsEl);
    defineDocProp('webkitCurrentFullScreenElement', () => activeFsEl);
    defineDocProp('fullscreen', () => !!activeFsEl);
    defineDocProp('webkitIsFullScreen', () => !!activeFsEl);

    // Intercept .ytp-fullscreen-button clicks at document capture phase (zero polling race, blocks YouTube handler)
    const handleFsBtnClick = (e) => {
      const target = e?.target;
      let btn = target && typeof target.closest === 'function' ? target.closest('.ytp-fullscreen-button') : null;
      if (!btn && typeof e?.composedPath === 'function') {
        const path = e.composedPath();
        for (let i = 0; i < path.length; i++) {
          const node = path[i];
          if (node?.classList?.contains?.('ytp-fullscreen-button')) {
            btn = node;
            break;
          }
        }
      }
      if (!btn) return;
      if (e._tesroidFsHandled) return;
      e._tesroidFsHandled = true;
      e.preventDefault?.();
      e.stopPropagation?.();
      e.stopImmediatePropagation?.();
      window.tesroidToggleFs();
    };
    document.addEventListener?.('click', handleFsBtnClick, true);

    // Escape key exits fullscreen
    window.addEventListener('keydown', (e) => {
      if (e?.key === 'Escape' && isFsActive()) {
        e.preventDefault?.();
        e.stopPropagation?.();
        e.stopImmediatePropagation?.();
        window.tesroidExitFs();
      }
    }, true);

    // Reset on YouTube SPA navigation
    const onYtNavigateStart = () => {
      if (isFsActive()) {
        window.tesroidExitFs();
      }
    };
    window.addEventListener('yt-navigate-start', onYtNavigateStart);
    document.addEventListener?.('yt-navigate-start', onYtNavigateStart);

    // Hook YouTube internal player toggle & keep fullscreen button enabled
    const patchYtPlayer = () => {
      const player = document.getElementById('movie_player');
      if (player && !player._tesroidFsHooked) {
        player._tesroidFsHooked = true;
        try {
          if (typeof player.setPlaybackQualityRange === 'function') {
            player.setPlaybackQualityRange('large', 'hd720');
          }
        } catch (e) {}
        player.toggleFullscreen = function() {
          window.tesroidToggleFs();
        };
      }
      ensureFsButtonReady();
    };
    patchYtPlayer();
    if (typeof setInterval === 'function') {
      setInterval(patchYtPlayer, 1000);
    }
  }
  // === TESROID_FULLSCREEN_CORE_END ===
})();
