(() => {
  if (window._tesroidExtensionLoaded) return;
  window._tesroidExtensionLoaded = true;

  try {
    // Set YouTube Dark Theme & Theater mode cookies
    document.cookie = "PREF=f6=400&wide=1; domain=.youtube.com; path=/; max-age=31536000";
  } catch (e) {}

  if (typeof window.__tesroidDisplayScale !== 'number') {
    window.__tesroidDisplayScale = 120;
  }

  window.tesroidSetZoom = (scalePercent) => {
    const num = Number(scalePercent);
    const clamped = !isNaN(num) && num >= 50 && num <= 250 ? num : 120;
    window.__tesroidDisplayScale = clamped;
    if (document.documentElement) {
      document.documentElement.style.setProperty('--tesroid-zoom', String(clamped / 100));
    }
    applyStyles();
    window.dispatchEvent(new Event('resize'));
  };

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
      el.textContent = `
        /* Car display readable zoom (default 120%), disabled during video fullscreen */
        html:not(.tesroid-web-fs-root) {
          zoom: var(--tesroid-zoom, 1.2) !important;
        }
        html.tesroid-web-fs-root {
          zoom: 1 !important;
        }

        /* Subtle minimalist scrollbar */
        ::-webkit-scrollbar { width: 4px !important; height: 4px !important; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2) !important; border-radius: 2px !important; }

        /* Web Fullscreen in Tesla window */
        body.tesroid-web-fs-active {
          overflow: hidden !important;
          background: #000 !important;
          zoom: 1 !important;
        }
        body.tesroid-web-fs-active ytd-masthead,
        body.tesroid-web-fs-active #masthead-container,
        body.tesroid-web-fs-active #guide-wrapper,
        body.tesroid-web-fs-active #secondary,
        body.tesroid-web-fs-active #below,
        body.tesroid-web-fs-active #comments {
          display: none !important;
        }
        body.tesroid-web-fs-active #movie_player,
        body.tesroid-web-fs-active .html5-video-player {
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          max-width: 100vw !important;
          max-height: 100vh !important;
          z-index: 2147483647 !important;
        }
        body.tesroid-web-fs-active #movie_player video,
        body.tesroid-web-fs-active .html5-video-player video {
          width: 100% !important;
          height: 100% !important;
          top: 0 !important;
          left: 0 !important;
          object-fit: contain !important;
        }
        body.tesroid-web-fs-active .tesroid-generic-fs-target {
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          z-index: 2147483647 !important;
          background: #000 !important;
          object-fit: contain !important;
        }
      `;
      root.appendChild(el);
    }
  };

  applyStyles();
  document.addEventListener('DOMContentLoaded', applyStyles);

  // Web Fullscreen Interceptor
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

    const player = document.getElementById('movie_player') || (activeFsEl?.closest?.('#movie_player'));
    if (player) {
      player.classList.add('ytp-fullscreen');
      try { player.setFauxFullscreen?.(true); } catch {}
    } else if (activeFsEl) {
      activeFsEl.classList.add('tesroid-generic-fs-target');
    }

    const fsEvent = new Event('fullscreenchange', { bubbles: true });
    document.dispatchEvent(fsEvent);
    activeFsEl?.dispatchEvent(fsEvent);
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

  // Override DOM Fullscreen APIs
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

  // Hook YouTube internal player toggle
  const patchYtPlayer = () => {
    const player = document.getElementById('movie_player');
    if (player) {
      try {
        if (typeof player.setPlaybackQualityRange === 'function') {
          player.setPlaybackQualityRange('large', 'hd720');
        }
      } catch (e) {}
      if (!player._tesroidFsHooked) {
        player._tesroidFsHooked = true;
        player.toggleFullscreen = function() {
          if (activeFsEl || document.body.classList.contains('tesroid-web-fs-active')) {
            window.tesroidExitFs();
          } else {
            window.tesroidEnterFs(player);
          }
        };
      }
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
})();
