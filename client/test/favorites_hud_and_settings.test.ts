import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FAVORITES, escapeHtml, type FavoriteItem } from '../src/views/icons.js';
import { openSettingsWithAuth } from '../src/views/settings-modal.js';
import { isYouTubeUrl, renderStreamingView } from '../src/views/streaming.js';

vi.mock('../src/core/canvas-renderer.js', () => {
  return {
    CanvasRenderer: function (this: any) {
      this.resetFirstFrame = vi.fn();
      this.getFps = vi.fn(() => 30);
      this.getLastRenderTime = vi.fn(() => performance.now());
    },
  };
});

vi.mock('../src/core/frame-pacer.js', () => {
  return {
    FramePacer: function (this: any) {
      this.setTargetFps = vi.fn();
      this.setMode = vi.fn();
      this.queueFrame = vi.fn();
      this.resetFirstFrame = vi.fn();
      this.destroy = vi.fn();
      this.getBufferedDurationMs = vi.fn(() => 0);
      this.getIsBuffering = vi.fn(() => false);
      this.getMode = vi.fn(() => 'PASSIVE_STREAMING');
      this.getAutoCushionMs = vi.fn(() => 0);
      this.jumpToLive = vi.fn();
    },
  };
});

vi.mock('../src/core/decoder.js', () => {
  return {
    VideoStreamDecoder: function (this: any) {
      this.reset = vi.fn();
      this.close = vi.fn();
      this.handlePacket = vi.fn();
      this.getPendingBufferedMs = vi.fn(() => 0);
      this.getDecodeQueueSize = vi.fn(() => 0);
      this.flushPendingForLiveJump = vi.fn();
      this.onDecoderError = null;
    },
  };
});

vi.mock('../src/input/touch-mapper.js', () => {
  return {
    TouchMapper: function (this: any) {
      this.destroy = vi.fn();
    },
  };
});

vi.mock('../src/core/metrics.js', () => {
  return {
    MetricsCollector: function (this: any) {
      this.onReport = null;
      this.updateRtt = vi.fn();
      this.recordFrameRendered = vi.fn();
      this.recordDecoderError = vi.fn();
      this.recordVideoPacket = vi.fn();
      this.recordAudioPacket = vi.fn();
      this.updateDecodeQueueSize = vi.fn();
      this.updateAvDrift = vi.fn();
      this.destroy = vi.fn();
    },
  };
});

vi.mock('../src/core/latency.js', () => {
  return {
    DynamicLatencyController: function (this: any) {
      this.getMode = vi.fn(() => 'PASSIVE_STREAMING');
      this.recordTouch = vi.fn();
    },
  };
});

function decodeSentCommand(callArgs: any[]): any | null {
  try {
    const packet = callArgs[0] as Uint8Array;
    if (!(packet instanceof Uint8Array) || packet[0] !== 0x13) return null;
    return JSON.parse(new TextDecoder().decode(packet.subarray(1)));
  } catch {
    return null;
  }
}

type MockListener = (...args: any[]) => void;

describe('Issue #49: HUD Favorites, Home Setting, and YouTube Search Visibility', () => {
  let elementRegistry: Map<string, any>;
  let mockContainer: any;
  let mockWsClient: any;
  let mockAudioPlayer: any;
  let mockAvSync: any;
  let onOpenSettings: any;
  let wsEventListeners: Record<string, MockListener[]>;
  let windowEventListeners: Record<string, MockListener[]>;
  const testToken = 'tesroid-issue49-token';
  let cleanupFns: Array<() => void>;

  const origDocument = (globalThis as any).document;
  const origWindow = (globalThis as any).window;
  const origLocalStorage = (globalThis as any).localStorage;
  const origSessionStorage = (globalThis as any).sessionStorage;
  const origFetch = (globalThis as any).fetch;
  const origRaf = (globalThis as any).requestAnimationFrame;
  const origCancelRaf = (globalThis as any).cancelAnimationFrame;

  function createMockElement(id?: string, tagName = 'div'): any {
    const listeners: Record<string, MockListener[]> = {};
    const classes = new Set<string>();
    const el: any = {
      id: id || '',
      tagName,
      className: '',
      classList: {
        toggle: vi.fn((c: string, force?: boolean) => {
          if (force === undefined) {
            if (classes.has(c)) classes.delete(c);
            else classes.add(c);
          } else if (force) {
            classes.add(c);
          } else {
            classes.delete(c);
          }
        }),
        remove: vi.fn((...cs: string[]) => cs.forEach((c) => classes.delete(c))),
        add: vi.fn((...cs: string[]) => cs.forEach((c) => classes.add(c))),
        contains: vi.fn((c: string) => classes.has(c)),
      },
      style: {},
      children: [] as any[],
      listeners,
      title: '',
      textContent: '',
      value: '',
      focus: vi.fn(),
      blur: vi.fn(),
      addEventListener: vi.fn((event: string, fn: MockListener) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
      }),
      removeEventListener: vi.fn((event: string, fn: MockListener) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter((l) => l !== fn);
        }
      }),
      dispatchEvent: vi.fn((event: any) => {
        const fns = listeners[event.type] || [];
        fns.forEach((f) => f(event));
      }),
      click: () => {
        el.dispatchEvent({
          type: 'click',
          target: el,
          stopPropagation: vi.fn(),
          preventDefault: vi.fn(),
        });
      },
      appendChild: vi.fn((child: any) => {
        el.children.push(child);
        if (child.id) elementRegistry.set(child.id, child);
        return child;
      }),
      remove: vi.fn(() => {
        if (el.id) elementRegistry.delete(el.id);
        for (const child of el.children) {
          child.remove?.();
        }
        el.children = [];
      }),
      querySelector: vi.fn((sel: string) => {
        if (sel.startsWith('#')) {
          return elementRegistry.get(sel.slice(1)) || null;
        }
        return null;
      }),
      querySelectorAll: vi.fn((sel: string) => {
        if (sel.startsWith('.')) {
          const cls = sel.slice(1);
          const matches: any[] = [];
          for (const candidate of elementRegistry.values()) {
            if (candidate.className?.split(/\s+/).includes(cls)) {
              matches.push(candidate);
            }
          }
          return matches;
        }
        return [];
      }),
    };

    let innerHtmlVal = '';
    Object.defineProperty(el, 'innerHTML', {
      get: () => innerHtmlVal,
      set: (html: string) => {
        innerHtmlVal = html;
        const idMatches = html.matchAll(/id=["']([^"']+)["']/g);
        for (const m of idMatches) {
          const childId = m[1];
          if (!elementRegistry.has(childId)) {
            const child = createMockElement(childId);
            elementRegistry.set(childId, child);
            el.children.push(child);
          }
        }
        const styleMatches = html.matchAll(/id=["']([^"']+)["'][^>]*style=["']([^"']+)["']/g);
        for (const sm of styleMatches) {
          const child = elementRegistry.get(sm[1]);
          if (child && sm[2].includes('display: none')) {
            child.style.display = 'none';
          }
        }
      },
    });

    if (id) {
      elementRegistry.set(id, el);
    }
    return el;
  }

  beforeEach(() => {
    elementRegistry = new Map<string, any>();
    wsEventListeners = {};
    windowEventListeners = {};
    cleanupFns = [];

    const mockDocument: any = {
      getElementById: vi.fn((id: string) => elementRegistry.get(id) || null),
      createElement: vi.fn((tag: string) => createMockElement(undefined, tag)),
      body: createMockElement('body', 'body'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const localStore: Record<string, string> = {};
    const sessionStore: Record<string, string> = { tesroid_token: testToken };
    const mockWindow: any = {
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1,
      addEventListener: vi.fn((type: string, fn: MockListener) => {
        if (!windowEventListeners[type]) windowEventListeners[type] = [];
        windowEventListeners[type].push(fn);
      }),
      removeEventListener: vi.fn((type: string, fn: MockListener) => {
        if (windowEventListeners[type]) {
          windowEventListeners[type] = windowEventListeners[type].filter((f) => f !== fn);
        }
      }),
      dispatchEvent: vi.fn((ev: any) => {
        const fns = windowEventListeners[ev.type] || [];
        fns.forEach((f) => f(ev));
        return true;
      }),
      location: { reload: vi.fn(), search: '' },
      localStorage: {
        getItem: vi.fn((k: string) => localStore[k] ?? null),
        setItem: vi.fn((k: string, v: string) => {
          localStore[k] = String(v);
        }),
        removeItem: vi.fn((k: string) => {
          delete localStore[k];
        }),
      },
      sessionStorage: {
        getItem: vi.fn((k: string) => sessionStore[k] ?? null),
        setItem: vi.fn((k: string, v: string) => {
          sessionStore[k] = String(v);
        }),
        removeItem: vi.fn((k: string) => {
          delete sessionStore[k];
        }),
      },
    };

    (globalThis as any).document = mockDocument;
    (globalThis as any).window = mockWindow;
    (globalThis as any).localStorage = mockWindow.localStorage;
    (globalThis as any).sessionStorage = mockWindow.sessionStorage;
    (globalThis as any).requestAnimationFrame = vi.fn((cb: any) => setTimeout(cb, 0));
    (globalThis as any).cancelAnimationFrame = vi.fn();
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    mockContainer = createMockElement('app');
    mockWsClient = {
      send: vi.fn(),
      on: vi.fn((event: string, handler: MockListener) => {
        if (!wsEventListeners[event]) wsEventListeners[event] = [];
        wsEventListeners[event].push(handler);
      }),
      off: vi.fn((event: string, handler: MockListener) => {
        if (wsEventListeners[event]) {
          wsEventListeners[event] = wsEventListeners[event].filter((h) => h !== handler);
        }
      }),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    mockAudioPlayer = {
      resetJitterBuffer: vi.fn(),
      jumpToLive: vi.fn(),
      setAdditionalDelay: vi.fn(),
      unlock: vi.fn().mockResolvedValue(undefined),
      toggleMute: vi.fn(() => false),
      getStats: vi.fn(() => ({
        packetsReceived: 0,
        state: 'running',
        isMuted: false,
        isUnlocked: true,
      })),
      handleAudioPacket: vi.fn(),
    };
    mockAvSync = {
      reset: vi.fn(),
      updateVideoPts: vi.fn(),
      getDriftMs: vi.fn(() => 0),
    };
    onOpenSettings = vi.fn();
  });

  afterEach(() => {
    for (const fn of cleanupFns) {
      fn();
    }
    (globalThis as any).document = origDocument;
    (globalThis as any).window = origWindow;
    (globalThis as any).localStorage = origLocalStorage;
    (globalThis as any).sessionStorage = origSessionStorage;
    (globalThis as any).fetch = origFetch;
    (globalThis as any).requestAnimationFrame = origRaf;
    (globalThis as any).cancelAnimationFrame = origCancelRaf;
  });

  describe('isYouTubeUrl & escapeHtml helpers', () => {
    it('recognizes YouTube domains and subdomains strictly and rejects spoofing/non-YouTube URLs', () => {
      expect(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
      expect(isYouTubeUrl('http://youtube.com')).toBe(true);
      expect(isYouTubeUrl('https://m.youtube.com/results?search_query=tesla')).toBe(true);
      expect(isYouTubeUrl('https://music.youtube.com/')).toBe(true);
      expect(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);

      expect(isYouTubeUrl('https://tver.jp')).toBe(false);
      expect(isYouTubeUrl('https://www.netflix.com/browse')).toBe(false);
      expect(isYouTubeUrl('https://evil-youtube.com/watch')).toBe(false);
      expect(isYouTubeUrl('https://youtube.com.attacker.example/')).toBe(false);
      expect(isYouTubeUrl('https://example.com/?next=youtube.com')).toBe(false);
      expect(isYouTubeUrl('https://example.com/youtube.com')).toBe(false);
      expect(isYouTubeUrl('javascript:alert(1)')).toBe(false);
      expect(isYouTubeUrl('ftp://www.youtube.com')).toBe(false);
      expect(isYouTubeUrl('')).toBe(false);
      expect(isYouTubeUrl(null)).toBe(false);
      expect(isYouTubeUrl(undefined)).toBe(false);
      expect(isYouTubeUrl('not a valid url')).toBe(false);
    });

    it('escapes &, <, >, ", and single quotes in escapeHtml', () => {
      expect(escapeHtml('<script>alert("xss" & \'test\')</script>')).toBe(
        '&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;test&#39;)&lt;/script&gt;',
      );
    });
  });

  describe('HUD Favorites Drawer, Home Button, and Search Bar Visibility', () => {
    it('preserves Tesla constraints (no <video>, keeps <canvas> & keyboard input) and renders #hud-favorites-btn', () => {
      const cleanup = renderStreamingView(
        mockContainer,
        mockWsClient,
        mockAudioPlayer,
        mockAvSync,
        onOpenSettings,
        testToken,
      );
      cleanupFns.push(cleanup);

      expect(mockContainer.innerHTML).not.toContain('<video');
      expect(elementRegistry.get('stream-canvas')).toBeDefined();
      expect(elementRegistry.get('hud-keyboard-drawer')).toBeDefined();
      expect(elementRegistry.get('hud-keyboard-input')).toBeDefined();
      expect(elementRegistry.get('hud-favorites-btn')).toBeDefined();
      expect(elementRegistry.get('hud-favorites-drawer')).toBeDefined();
      expect(elementRegistry.get('hud-favorites-drawer').style.display).toBe('none');
    });

    it('toggles #hud-favorites-drawer and maintains mutual exclusion with #hud-keyboard-drawer', () => {
      const cleanup = renderStreamingView(
        mockContainer,
        mockWsClient,
        mockAudioPlayer,
        mockAvSync,
        onOpenSettings,
        testToken,
      );
      cleanupFns.push(cleanup);

      const favBtn = elementRegistry.get('hud-favorites-btn');
      const favDrawer = elementRegistry.get('hud-favorites-drawer');
      const kbdBtn = elementRegistry.get('hud-keyboard-btn');
      const kbdDrawer = elementRegistry.get('hud-keyboard-drawer');

      // Open keyboard drawer first
      kbdBtn.click();
      expect(kbdDrawer.style.display).toBe('flex');
      expect(kbdBtn.classList.contains('is-active')).toBe(true);

      // Opening favorites drawer must close keyboard drawer
      favBtn.click();
      expect(favDrawer.style.display).toBe('flex');
      expect(favBtn.classList.contains('is-active')).toBe(true);
      expect(kbdDrawer.style.display).toBe('none');
      expect(kbdBtn.classList.contains('is-active')).toBe(false);

      // Opening keyboard drawer must close favorites drawer
      kbdBtn.click();
      expect(kbdDrawer.style.display).toBe('flex');
      expect(favDrawer.style.display).toBe('none');
      expect(favBtn.classList.contains('is-active')).toBe(false);
    });

    it('navigates in 1-tap from favorites drawer, updates search bar, and auto-closes drawer', () => {
      const cleanup = renderStreamingView(
        mockContainer,
        mockWsClient,
        mockAudioPlayer,
        mockAvSync,
        onOpenSettings,
        testToken,
      );
      cleanupFns.push(cleanup);

      const favBtn = elementRegistry.get('hud-favorites-btn');
      const favDrawer = elementRegistry.get('hud-favorites-drawer');
      const searchForm = elementRegistry.get('hud-search-form');
      const searchDivider = elementRegistry.get('hud-search-divider');

      favBtn.click();
      expect(favDrawer.style.display).toBe('flex');

      const tverBtn = elementRegistry.get('hud-fav-item-tver');
      expect(tverBtn).toBeDefined();
      tverBtn.click();

      const navCommands = mockWsClient.send.mock.calls
        .map((c: any[]) => decodeSentCommand(c))
        .filter((cmd: any) => cmd?.type === 'NAVIGATE');
      expect(navCommands).toContainEqual({ type: 'NAVIGATE', url: 'https://tver.jp' });
      expect(favDrawer.style.display).toBe('none');
      expect(searchForm.style.display).toBe('none');
      expect(searchDivider.style.display).toBe('none');
    });

    it('dynamically resolves custom home favorite from GET /api/settings and updates #hud-home-btn', async () => {
      const customFavorites: FavoriteItem[] = [
        ...DEFAULT_FAVORITES.slice(0, 4),
        { id: 'custom-news', title: 'Tesla News', url: 'https://www.tesla.com' },
      ];
      (globalThis as any).fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          favorites: customFavorites,
          homeFavoriteId: 'netflix',
          homeUrl: 'https://www.netflix.com',
          browserUrl: 'https://www.netflix.com/browse',
          browserTitle: 'Netflix',
        }),
      });

      const cleanup = renderStreamingView(
        mockContainer,
        mockWsClient,
        mockAudioPlayer,
        mockAvSync,
        onOpenSettings,
        testToken,
      );
      cleanupFns.push(cleanup);

      await new Promise((r) => setTimeout(r, 15));

      const homeBtn = elementRegistry.get('hud-home-btn');
      const searchForm = elementRegistry.get('hud-search-form');
      expect(homeBtn.title).toBe('ホームへ移動 (Netflix)');
      expect(searchForm.style.display).toBe('none');

      // Open drawer then tap home -> closes drawer and navigates to custom home URL
      elementRegistry.get('hud-favorites-btn').click();
      expect(elementRegistry.get('hud-favorites-drawer').style.display).toBe('flex');

      homeBtn.click();
      const navCommands = mockWsClient.send.mock.calls
        .map((c: any[]) => decodeSentCommand(c))
        .filter((cmd: any) => cmd?.type === 'NAVIGATE');
      expect(navCommands).toContainEqual({ type: 'NAVIGATE', url: 'https://www.netflix.com' });
      expect(elementRegistry.get('hud-favorites-drawer').style.display).toBe('none');
    });

    it('toggles #hud-search-form dynamically on BROWSER_STATUS URL changes', () => {
      const cleanup = renderStreamingView(
        mockContainer,
        mockWsClient,
        mockAudioPlayer,
        mockAvSync,
        onOpenSettings,
        testToken,
      );
      cleanupFns.push(cleanup);

      const controlHandler = wsEventListeners.control?.[0];
      const searchForm = elementRegistry.get('hud-search-form');
      const searchDivider = elementRegistry.get('hud-search-divider');

      controlHandler({
        type: 'BROWSER_STATUS',
        state: 'running',
        url: 'https://tver.jp/series/123',
        title: 'TVer',
      });
      expect(searchForm.style.display).toBe('none');
      expect(searchDivider.style.display).toBe('none');

      controlHandler({
        type: 'BROWSER_STATUS',
        state: 'running',
        url: 'https://m.youtube.com/watch?v=xyz',
        title: 'YouTube Video',
      });
      expect(searchForm.style.display).toBe('flex');
      expect(searchDivider.style.display).toBe('');
    });

    it('adds current page via #hud-fav-add-current-btn and opens settings via #hud-fav-edit-btn', async () => {
      let putPayload: any = null;
      (globalThis as any).fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
        if (url === '/api/settings' && (!opts || opts.method === 'GET' || !opts.method)) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              favorites: DEFAULT_FAVORITES,
              homeFavoriteId: 'youtube',
              browserUrl: 'https://www.youtube.com',
              browserTitle: 'YouTube',
            }),
          });
        }
        if (url === '/api/settings' && opts?.method === 'PUT') {
          putPayload = JSON.parse(opts.body);
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              settings: { favorites: putPayload.favorites, homeFavoriteId: 'youtube' },
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });

      const cleanup = renderStreamingView(
        mockContainer,
        mockWsClient,
        mockAudioPlayer,
        mockAvSync,
        onOpenSettings,
        testToken,
      );
      cleanupFns.push(cleanup);
      await new Promise((r) => setTimeout(r, 15));

      const controlHandler = wsEventListeners.control?.[0];
      controlHandler({
        type: 'BROWSER_STATUS',
        state: 'running',
        url: 'https://abema.tv/now-on-air/abema-news',
        title: 'ABEMA News',
      });

      elementRegistry.get('hud-favorites-btn').click();
      elementRegistry.get('hud-fav-add-current-btn').click();
      await new Promise((r) => setTimeout(r, 15));

      expect(putPayload).toBeTruthy();
      expect(putPayload.favorites[0]).toMatchObject({
        url: 'https://abema.tv/now-on-air/abema-news',
        title: 'ABEMA News',
      });
      expect(putPayload.favorites.slice(1).map((f: FavoriteItem) => f.id)).toEqual(
        DEFAULT_FAVORITES.map((f) => f.id),
      );
      expect(globalThis.window.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tesroid:settings-updated' }),
      );

      // #hud-fav-edit-btn closes drawer and triggers onOpenSettings
      elementRegistry.get('hud-fav-edit-btn').click();
      expect(elementRegistry.get('hud-favorites-drawer').style.display).toBe('none');
      expect(onOpenSettings).toHaveBeenCalledTimes(1);
    });

    it('escapes malicious HTML/script payloads in HUD favorites list (XSS prevention)', async () => {
      const xssFavorites: FavoriteItem[] = [
        {
          id: 'xss-1',
          title: '<img src=x onerror="alert(1)"> & <script>evil()</script>',
          url: 'https://example.com/?q="><script>alert(1)</script>',
        },
      ];
      (globalThis as any).fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          favorites: xssFavorites,
          homeFavoriteId: 'xss-1',
          browserUrl: 'https://www.youtube.com',
        }),
      });

      const cleanup = renderStreamingView(
        mockContainer,
        mockWsClient,
        mockAudioPlayer,
        mockAvSync,
        onOpenSettings,
        testToken,
      );
      cleanupFns.push(cleanup);
      await new Promise((r) => setTimeout(r, 15));

      elementRegistry.get('hud-favorites-btn').click();
      const favList = elementRegistry.get('hud-favorites-list');
      expect(favList.innerHTML).not.toContain('<script>');
      expect(favList.innerHTML).not.toContain('<img src=x');
      expect(favList.innerHTML).toContain('&lt;script&gt;evil()&lt;/script&gt;');
      expect(favList.innerHTML).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    });
  });

  describe('Settings Modal Favorites Management UI', () => {
    function setupSettingsApiMock(initialFavorites: FavoriteItem[], initialHomeId = 'youtube') {
      let currentFavs = initialFavorites.map((f) => ({ ...f }));
      let currentHomeId = initialHomeId;
      const putPayloads: any[] = [];

      (globalThis as any).fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
        if (url === '/api/settings' && (!opts || opts.method === 'GET' || !opts.method)) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              favorites: currentFavs,
              homeFavoriteId: currentHomeId,
              browserUrl: 'https://www.twitch.tv/directory',
              browserTitle: 'Twitch Browse',
            }),
          });
        }
        if (url === '/api/settings' && opts?.method === 'PUT') {
          const payload = JSON.parse(opts.body);
          putPayloads.push(payload);
          if (payload.resetFavorites) {
            currentFavs = DEFAULT_FAVORITES.map((f) => ({ ...f }));
            currentHomeId = 'youtube';
          } else {
            if (Array.isArray(payload.favorites)) {
              currentFavs = payload.favorites.map((f: FavoriteItem) => ({ ...f }));
            }
            if (typeof payload.homeFavoriteId === 'string') {
              currentHomeId = payload.homeFavoriteId;
            }
            if (currentFavs.length > 0 && !currentFavs.some((f) => f.id === currentHomeId)) {
              currentHomeId = currentFavs[0].id;
            }
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              settings: { favorites: currentFavs, homeFavoriteId: currentHomeId },
            }),
          });
        }
        if (url === '/api/browser/navigate' && opts?.method === 'POST') {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      });

      return { putPayloads, getState: () => ({ currentFavs, currentHomeId }) };
    }

    it('removes hardcoded .quick-url-btn and renders favorites from GET /api/settings with XSS escaping', async () => {
      const initial: FavoriteItem[] = [
        { id: 'youtube', title: 'YouTube', url: 'https://www.youtube.com' },
        { id: 'xss', title: '<script>alert(1)</script>', url: 'https://example.com/?a="x"' },
      ];
      setupSettingsApiMock(initial, 'youtube');

      openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());
      await new Promise((r) => setTimeout(r, 15));

      expect(mockContainer.children[0].innerHTML).not.toContain('quick-url-btn');
      expect(elementRegistry.get('browser-url-input')).toBeDefined();
      expect(elementRegistry.get('browser-url-btn')).toBeDefined();

      const manageList = elementRegistry.get('favorites-manage-list');
      expect(manageList.innerHTML).not.toContain('<script>');
      expect(manageList.innerHTML).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(elementRegistry.get('fav-launch-youtube')).toBeDefined();
      expect(elementRegistry.get('fav-launch-xss')).toBeDefined();
    });

    it('rejects invalid URLs and supports add, edit, reorder, set home, delete, and reset to presets', async () => {
      const initial: FavoriteItem[] = [
        { id: 'youtube', title: 'YouTube', url: 'https://www.youtube.com' },
        { id: 'tver', title: 'TVer', url: 'https://tver.jp' },
      ];
      const { putPayloads, getState } = setupSettingsApiMock(initial, 'youtube');

      openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());
      await new Promise((r) => setTimeout(r, 15));

      const titleInput = elementRegistry.get('fav-title-input');
      const urlInput = elementRegistry.get('fav-url-input');
      const addBtn = elementRegistry.get('fav-add-btn');

      // 1. Reject invalid / javascript: URL
      titleInput.value = 'Bad';
      urlInput.value = 'javascript:alert(1)';
      addBtn.click();
      await new Promise((r) => setTimeout(r, 10));
      expect(putPayloads.length).toBe(0);

      // 2. Add valid favorite (inserted at head / index 0)
      titleInput.value = 'Netflix';
      urlInput.value = 'https://www.netflix.com';
      addBtn.click();
      await new Promise((r) => setTimeout(r, 15));
      expect(putPayloads.length).toBe(1);
      expect(getState().currentFavs.map((f) => f.title)).toEqual(['Netflix', 'YouTube', 'TVer']);
      expect(globalThis.window.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tesroid:settings-updated' }),
      );

      // 3. Edit TVer title
      elementRegistry.get('fav-edit-tver').click();
      expect(titleInput.value).toBe('TVer');
      expect(urlInput.value).toBe('https://tver.jp');
      expect(elementRegistry.get('fav-cancel-edit-btn').style.display).toBe('inline-flex');

      titleInput.value = 'TVer 公式';
      addBtn.click();
      await new Promise((r) => setTimeout(r, 15));
      expect(getState().currentFavs.find((f) => f.id === 'tver')?.title).toBe('TVer 公式');
      expect(elementRegistry.get('fav-cancel-edit-btn').style.display).toBe('none');

      // 4. Reorder: move TVer up before YouTube
      const netflixId = getState().currentFavs[0].id;
      elementRegistry.get('fav-up-tver').click();
      await new Promise((r) => setTimeout(r, 15));
      expect(getState().currentFavs.map((f) => f.id)).toEqual([netflixId, 'tver', 'youtube']);

      // 5. Move Netflix down
      elementRegistry.get(`fav-down-${netflixId}`).click();
      await new Promise((r) => setTimeout(r, 15));
      expect(getState().currentFavs.map((f) => f.id)).toEqual(['tver', netflixId, 'youtube']);

      // 6. Set TVer as home
      elementRegistry.get('fav-home-tver').click();
      await new Promise((r) => setTimeout(r, 15));
      expect(getState().currentHomeId).toBe('tver');

      // 7. Delete active home favorite (TVer) -> home auto-falls back to first remaining item
      elementRegistry.get('fav-delete-tver').click();
      await new Promise((r) => setTimeout(r, 15));
      expect(getState().currentFavs.some((f) => f.id === 'tver')).toBe(false);
      expect(getState().currentHomeId).toBe(netflixId);

      // 8. Reset to presets requires 2-tap confirmation
      const resetBtn = elementRegistry.get('fav-reset-btn');
      const countBeforeReset = putPayloads.length;
      resetBtn.click();
      await new Promise((r) => setTimeout(r, 10));
      expect(putPayloads.length).toBe(countBeforeReset);

      resetBtn.click();
      await new Promise((r) => setTimeout(r, 15));
      expect(putPayloads[putPayloads.length - 1]).toEqual({ resetFavorites: true });
      expect(getState().currentFavs).toHaveLength(11);
      expect(getState().currentHomeId).toBe('youtube');
    });

    it('syncs settings-modal updates to an active HUD view via tesroid:settings-updated', async () => {
      const initial: FavoriteItem[] = [
        { id: 'youtube', title: 'YouTube', url: 'https://www.youtube.com' },
        { id: 'dazn', title: 'DAZN', url: 'https://www.dazn.com' },
      ];
      setupSettingsApiMock(initial, 'youtube');

      const cleanup = renderStreamingView(
        mockContainer,
        mockWsClient,
        mockAudioPlayer,
        mockAvSync,
        onOpenSettings,
        testToken,
      );
      cleanupFns.push(cleanup);
      await new Promise((r) => setTimeout(r, 15));

      const settingsContainer = createMockElement('settings-container');
      openSettingsWithAuth(settingsContainer, testToken, vi.fn(), vi.fn());
      await new Promise((r) => setTimeout(r, 15));

      elementRegistry.get('fav-home-dazn').click();
      await new Promise((r) => setTimeout(r, 15));

      expect(elementRegistry.get('hud-home-btn').title).toBe('ホームへ移動 (DAZN)');
    });

    it('inserts current page at index 0 when added via #fav-add-current-modal-btn', async () => {
      const initial: FavoriteItem[] = [
        { id: 'youtube', title: 'YouTube', url: 'https://www.youtube.com' },
        { id: 'tver', title: 'TVer', url: 'https://tver.jp' },
      ];
      const { putPayloads, getState } = setupSettingsApiMock(initial, 'youtube');

      openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());
      await new Promise((r) => setTimeout(r, 15));

      elementRegistry.get('fav-add-current-modal-btn').click();
      await new Promise((r) => setTimeout(r, 15));

      expect(putPayloads.length).toBe(1);
      expect(getState().currentFavs[0]).toMatchObject({
        title: 'Twitch Browse',
        url: 'https://www.twitch.tv/directory',
      });
      expect(
        getState()
          .currentFavs.slice(1)
          .map((f) => f.id),
      ).toEqual(['youtube', 'tver']);
    });

    it('places TVer and Prime Video at the front of client DEFAULT_FAVORITES without unavailable labels', () => {
      expect(DEFAULT_FAVORITES[0]).toEqual({
        id: 'tver',
        title: 'TVer',
        url: 'https://tver.jp',
      });
      expect(DEFAULT_FAVORITES[1]).toEqual({
        id: 'primevideo',
        title: 'Prime Video',
        url: 'https://www.amazon.co.jp/primevideo',
      });
      expect(DEFAULT_FAVORITES.some((f) => f.title.includes('動作不可'))).toBe(false);
    });
  });
});
