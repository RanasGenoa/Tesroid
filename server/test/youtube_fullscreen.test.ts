import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCarFullscreenScript } from '../src/browser/fullscreen-script.js';
import { X11InputManager } from '../src/input/xdotool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, '..');

const contentJs = fs.readFileSync(path.join(SERVER_ROOT, 'extension/content.js'), 'utf-8');
const managerTs = fs.readFileSync(path.join(SERVER_ROOT, 'src/browser/manager.ts'), 'utf-8');
const xdotoolTs = fs.readFileSync(path.join(SERVER_ROOT, 'src/input/xdotool.ts'), 'utf-8');

interface MockListener {
  fn: (e: any) => void;
  capture: boolean;
}

function createRichDomEnv(opts?: {
  withYouTube?: boolean;
  screenWidth?: number;
  screenHeight?: number;
  outerWidth?: number;
  outerHeight?: number;
  innerWidth?: number;
  innerHeight?: number;
}) {
  const withYouTube = opts?.withYouTube ?? true;
  const cssVars = new Map<string, string>();
  const elementsById = new Map<string, MockEl>();
  const intervals: Array<() => void> = [];

  class MockClassList {
    public set = new Set<string>();
    add(...tokens: string[]) {
      for (const t of tokens) this.set.add(t);
    }
    remove(...tokens: string[]) {
      for (const t of tokens) this.set.delete(t);
    }
    contains(token: string) {
      return this.set.has(token);
    }
  }

  class MockEvent {
    public type: string;
    public bubbles: boolean;
    public key?: string;
    public target: any = null;
    public currentTarget: any = null;
    public defaultPrevented = false;
    public propagationStopped = false;
    public immediatePropagationStopped = false;
    public _tesroidFsHandled?: boolean;

    constructor(type: string, init?: { bubbles?: boolean; key?: string }) {
      this.type = type;
      this.bubbles = !!init?.bubbles;
      if (init?.key !== undefined) this.key = init.key;
    }

    preventDefault() {
      this.defaultPrevented = true;
    }
    stopPropagation() {
      this.propagationStopped = true;
    }
    stopImmediatePropagation() {
      this.immediatePropagationStopped = true;
      this.propagationStopped = true;
    }
  }

  class MockEl {
    public tagName: string;
    public id = '';
    public classList = new MockClassList();
    public style: Record<string, any> = {
      setProperty: (k: string, v: string) => cssVars.set(k, v),
      getPropertyValue: (k: string) => cssVars.get(k) || '',
    };
    public attrs = new Map<string, string>();
    public children: MockEl[] = [];
    public parentNode: any = null;
    public textContent = '';
    public listeners = new Map<string, MockListener[]>();
    public isConnected = true;
    public setFauxFullscreen?: (v: boolean) => void;
    public setPlaybackQualityRange?: (min: string, max: string) => void;
    public toggleFullscreen?: () => void;

    constructor(tagName: string, id = '', classes: string[] = []) {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      for (const c of classes) this.classList.add(c);
      if (id) elementsById.set(id, this);
    }

    setAttribute(name: string, value: string) {
      this.attrs.set(name, value);
    }
    getAttribute(name: string) {
      return this.attrs.has(name) ? (this.attrs.get(name) ?? null) : null;
    }
    hasAttribute(name: string) {
      return this.attrs.has(name);
    }
    removeAttribute(name: string) {
      this.attrs.delete(name);
    }
    appendChild(child: MockEl) {
      if (child.id) elementsById.set(child.id, child);
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    closest(selector: string): MockEl | null {
      const cls = selector.startsWith('.') ? selector.slice(1) : null;
      const id = selector.startsWith('#') ? selector.slice(1) : null;
      let cur: any = this;
      while (cur && cur instanceof MockEl) {
        if (cls && cur.classList.contains(cls)) return cur;
        if (id && cur.id === id) return cur;
        cur = cur.parentNode;
      }
      return null;
    }
    addEventListener(type: string, fn: (e: any) => void, capture = false) {
      const list = this.listeners.get(type) || [];
      list.push({ fn, capture: !!capture });
      this.listeners.set(type, list);
    }
    dispatchEvent(event: MockEvent) {
      if (!event.target) event.target = this;
      const chain: any[] = [];
      let cur: any = this;
      while (cur) {
        chain.push(cur);
        cur = cur.parentNode;
      }
      // Capture phase: root -> target (excluding target itself for strict parent capture, then target)
      for (let i = chain.length - 1; i >= 1; i--) {
        const node = chain[i];
        const list = (node.listeners?.get(event.type) || []).filter((l: MockListener) => l.capture);
        for (const l of list) {
          if (event.immediatePropagationStopped) break;
          event.currentTarget = node;
          l.fn(event);
        }
        if (event.propagationStopped) return !event.defaultPrevented;
      }
      // Target phase: invoke all listeners on target in registration order
      const targetListeners = this.listeners.get(event.type) || [];
      for (const l of targetListeners) {
        if (event.immediatePropagationStopped) break;
        event.currentTarget = this;
        l.fn(event);
      }
      if (!event.bubbles || event.propagationStopped) return !event.defaultPrevented;
      // Bubble phase: parent -> root
      for (let i = 1; i < chain.length; i++) {
        const node = chain[i];
        const list = (node.listeners?.get(event.type) || []).filter(
          (l: MockListener) => !l.capture,
        );
        for (const l of list) {
          if (event.immediatePropagationStopped) break;
          event.currentTarget = node;
          l.fn(event);
        }
        if (event.propagationStopped) break;
      }
      return !event.defaultPrevented;
    }
    click() {
      const ev = new MockEvent('click', { bubbles: true });
      this.dispatchEvent(ev);
      return ev;
    }
  }

  class MockVideoEl extends MockEl {
    public muted = false;
    public volume = 1;
    constructor(id = '') {
      super('video', id);
    }
  }

  const docListeners = new Map<string, MockListener[]>();
  const winListeners = new Map<string, MockListener[]>();

  const htmlEl = new MockEl('html');
  const headEl = new MockEl('head');
  const bodyEl = new MockEl('body');
  htmlEl.appendChild(headEl);
  htmlEl.appendChild(bodyEl);

  let flexyEl: MockEl | null = null;
  let playerEl: MockEl | null = null;
  let fsBtnEl: MockEl | null = null;
  let fsSvgEl: MockEl | null = null;
  let videoEl: MockVideoEl | null = null;

  if (withYouTube) {
    flexyEl = new MockEl('ytd-watch-flexy');
    playerEl = new MockEl('movie_player', 'movie_player', ['html5-video-player']);
    playerEl.setFauxFullscreen = vi.fn();
    playerEl.setPlaybackQualityRange = vi.fn();
    const videoContainer = new MockEl('div', '', ['html5-video-container']);
    videoEl = new MockVideoEl();
    videoContainer.appendChild(videoEl);
    fsBtnEl = new MockEl('button', '', ['ytp-fullscreen-button', 'ytp-button']);
    fsSvgEl = new MockEl('svg');
    fsBtnEl.appendChild(fsSvgEl);
    playerEl.appendChild(videoContainer);
    playerEl.appendChild(fsBtnEl);
    flexyEl.appendChild(playerEl);
    bodyEl.appendChild(flexyEl);
  } else {
    videoEl = new MockVideoEl('generic-video');
    bodyEl.appendChild(videoEl);
  }

  const mockDoc: any = {
    cookie: '',
    documentElement: htmlEl,
    head: headEl,
    body: bodyEl,
    listeners: docListeners,
    getElementById: (id: string) => elementsById.get(id) || null,
    querySelector: (sel: string) => {
      if (sel === 'ytd-watch-flexy') return flexyEl;
      if (sel === 'video') return videoEl;
      if (sel === '.ytp-fullscreen-button') return fsBtnEl;
      if (sel === '#movie_player') return playerEl;
      return null;
    },
    querySelectorAll: (sel: string) => {
      if (sel === '.ytp-fullscreen-button') return fsBtnEl ? [fsBtnEl] : [];
      return [];
    },
    createElement: (tag: string) => new MockEl(tag),
    addEventListener: (type: string, fn: (e: any) => void, capture = false) => {
      const list = docListeners.get(type) || [];
      list.push({ fn, capture: !!capture });
      docListeners.set(type, list);
    },
    dispatchEvent: (ev: MockEvent) => {
      const list = docListeners.get(ev.type) || [];
      for (const l of list) {
        if (ev.immediatePropagationStopped) break;
        ev.currentTarget = mockDoc;
        l.fn(ev);
      }
      return !ev.defaultPrevented;
    },
  };

  htmlEl.parentNode = mockDoc;

  const mockScreen: any = {
    width: opts?.screenWidth ?? 1920,
    height: opts?.screenHeight ?? 1080,
    availWidth: opts?.screenWidth ?? 1920,
    availHeight: opts?.screenHeight ?? 1080,
  };

  const mockWin: any = {
    document: mockDoc,
    screen: mockScreen,
    outerWidth: opts?.outerWidth ?? 1256,
    outerHeight: opts?.outerHeight ?? 658,
    innerWidth: opts?.innerWidth ?? 1256,
    innerHeight: opts?.innerHeight ?? 626,
    Element: MockEl,
    HTMLVideoElement: MockVideoEl,
    Event: MockEvent,
    navigator: {
      credentials: {
        get: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(null),
      },
    },
    PublicKeyCredential: {
      isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockResolvedValue(true),
      isConditionalMediationAvailable: vi.fn().mockResolvedValue(true),
    },
    addEventListener: (type: string, fn: (e: any) => void, capture = false) => {
      const list = winListeners.get(type) || [];
      list.push({ fn, capture: !!capture });
      winListeners.set(type, list);
    },
    dispatchEvent: (ev: MockEvent) => {
      const list = winListeners.get(ev.type) || [];
      for (const l of list) {
        if (ev.immediatePropagationStopped) break;
        ev.currentTarget = mockWin;
        l.fn(ev);
      }
      return !ev.defaultPrevented;
    },
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return intervals.length;
    },
  };
  mockDoc.parentNode = mockWin;

  const ctx = vm.createContext({
    window: mockWin,
    document: mockDoc,
    navigator: mockWin.navigator,
    PublicKeyCredential: mockWin.PublicKeyCredential,
    Element: MockEl,
    HTMLVideoElement: MockVideoEl,
    Event: MockEvent,
    DOMException: globalThis.DOMException,
    setInterval: mockWin.setInterval,
    Promise,
    Object,
    Number,
    String,
    Math,
    isNaN,
  });

  const attachNewFsButton = () => {
    const newBtn = new MockEl('button', '', ['ytp-fullscreen-button', 'ytp-button']);
    const newSvg = new MockEl('svg');
    newBtn.appendChild(newSvg);
    playerEl?.appendChild(newBtn);
    fsBtnEl = newBtn;
    fsSvgEl = newSvg;
    return { newBtn, newSvg };
  };

  return {
    ctx,
    mockWin,
    mockDoc,
    mockScreen,
    cssVars,
    htmlEl,
    headEl,
    bodyEl,
    flexyEl,
    playerEl,
    get fsBtnEl() {
      return fsBtnEl;
    },
    get fsSvgEl() {
      return fsSvgEl;
    },
    videoEl,
    intervals,
    MockEl,
    MockVideoEl,
    MockEvent,
    attachNewFsButton,
  };
}

function captureCdpTouchBridgeScript(): string {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn().mockRejectedValue(new Error('CDP offline in test')) as any;
  const inputManager = new X11InputManager(':99', 1280, 720);
  try {
    const bridge = (inputManager as any).cdpBridge;
    const sent: Array<{ method: string; params: any }> = [];
    bridge.isConnected = () => true;
    bridge.send = (method: string, params: any) => {
      sent.push({ method, params });
    };
    bridge.setupCarOptimizations();
    const evalCmd = sent.find((s) => s.method === 'Page.addScriptToEvaluateOnNewDocument');
    expect(evalCmd?.params?.source).toBeTruthy();
    return evalCmd?.params.source as string;
  } finally {
    inputManager.close();
    globalThis.fetch = originalFetch;
  }
}

describe('YouTube Web Fullscreen & Car Optimization Scripts (Issue #67)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps all 3 injection points synchronized on unified guard, CSS fixes, and WebAuthn preservation', () => {
    const sharedScript = buildCarFullscreenScript(130);
    const bridgeScript = captureCdpTouchBridgeScript();

    for (const src of [contentJs, sharedScript, bridgeScript]) {
      expect(src).toContain('_tesroidFullscreenInstalled');
      expect(src).toContain('.html5-video-container');
      expect(src).toContain('height: 100% !important');
      expect(src).toContain('background: #000 !important');
      expect(src).toContain('#cinematics');
      expect(src).toContain('player-container-background-image');
      expect(src).toContain('stopImmediatePropagation');
      expect(src).toContain('fullscreenEnabled');
      expect(src).toContain('webkitFullscreenEnabled');
      expect(src).toContain('webkitfullscreenchange');
      expect(src).toContain('yt-navigate-start');
      expect(src).not.toContain("setAttribute('fullscreen'");
    }

    // manager.ts & xdotool.ts both delegate to buildCarFullscreenScript and preserve WebAuthn
    expect(managerTs).toContain('buildCarFullscreenScript(this.displayScale)');
    expect(managerTs).toContain('_tesroidAudioUnmuteInstalled');
    expect(xdotoolTs).toContain('buildCarFullscreenScript()');
  });

  it('remains strictly idempotent across triple-injection in any order without breaking active fullscreen or zoom', () => {
    const env1 = createRichDomEnv();
    const managerScript = `(() => { ${buildCarFullscreenScript(140)} })()`;
    const bridgeScript = captureCdpTouchBridgeScript();

    // Order A: content.js -> manager(140) -> xdotool
    vm.runInContext(contentJs, env1.ctx);
    const enterFnAfterFirst = env1.mockWin.tesroidEnterFs;
    const reqFsAfterFirst = env1.MockEl.prototype.requestFullscreen;

    // Enter fullscreen before manager & xdotool run to verify active state survives late injections
    env1.mockWin.tesroidEnterFs();
    expect(env1.mockDoc.fullscreenElement).toBe(env1.playerEl);

    vm.runInContext(managerScript, env1.ctx);
    vm.runInContext(bridgeScript, env1.ctx);

    expect(env1.mockWin.tesroidEnterFs).toBe(enterFnAfterFirst);
    expect(env1.MockEl.prototype.requestFullscreen).toBe(reqFsAfterFirst);
    expect(env1.mockWin.__tesroidDisplayScale).toBe(140);
    expect(env1.cssVars.get('--tesroid-zoom')).toBe('1.4');
    expect(env1.mockDoc.fullscreenElement).toBe(env1.playerEl);
    expect(env1.headEl.children.filter((c) => c.id === 'tesroid-car-style')).toHaveLength(1);

    // Order B: manager(135) -> xdotool -> content.js
    const env2 = createRichDomEnv();
    const managerScript135 = `(() => { ${buildCarFullscreenScript(135)} })()`;
    vm.runInContext(managerScript135, env2.ctx);
    const enterFnOrderB = env2.mockWin.tesroidEnterFs;
    vm.runInContext(bridgeScript, env2.ctx);
    vm.runInContext(contentJs, env2.ctx);

    expect(env2.mockWin.tesroidEnterFs).toBe(enterFnOrderB);
    expect(env2.mockWin.__tesroidDisplayScale).toBe(135);
    expect(env2.cssVars.get('--tesroid-zoom')).toBe('1.35');
    expect(env2.headEl.children.filter((c) => c.id === 'tesroid-car-style')).toHaveLength(1);
  });

  it('intercepts .ytp-fullscreen-button clicks cleanly in capture phase without double-toggle or firing YouTube click listener', () => {
    const env = createRichDomEnv();
    vm.runInContext(contentJs, env.ctx);

    const fsBtn = env.fsBtnEl;
    const fsSvg = env.fsSvgEl;
    const player = env.playerEl;
    if (!fsBtn || !fsSvg || !player) throw new Error('Expected YouTube mock DOM elements');

    const ytClickSpy = vi.fn();
    const playerClickSpy = vi.fn();
    fsBtn.addEventListener('click', ytClickSpy, false);
    player.addEventListener('click', playerClickSpy, false);

    // Even if YouTube marked button disabled before click, clicking child SVG enters once
    fsBtn.setAttribute('aria-disabled', 'true');
    fsBtn.setAttribute('disabled', '');
    fsBtn.style.pointerEvents = 'none';
    fsBtn.style.opacity = '0.4';

    const clickEv = fsSvg.click();
    expect(clickEv.defaultPrevented).toBe(true);
    expect(clickEv.immediatePropagationStopped).toBe(true);
    expect(ytClickSpy).not.toHaveBeenCalled();
    expect(playerClickSpy).not.toHaveBeenCalled();
    expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(true);
    expect(player.classList.contains('ytp-fullscreen')).toBe(true);
    expect(fsBtn.hasAttribute('aria-disabled')).toBe(false);
    expect(fsBtn.hasAttribute('disabled')).toBe(false);
    expect(fsBtn.style.pointerEvents).toBe('auto');
    expect(fsBtn.style.opacity).toBe('1');

    // Second click on button itself exits cleanly without double-toggle
    const exitEv = fsBtn.click();
    expect(exitEv.immediatePropagationStopped).toBe(true);
    expect(ytClickSpy).not.toHaveBeenCalled();
    expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(false);
    expect(env.mockDoc.fullscreenElement).toBeNull();

    // Newly replaced .ytp-fullscreen-button (before 1000ms interval ticks) is ALSO intercepted immediately!
    const { newBtn, newSvg } = env.attachNewFsButton();
    const ytNewListener = vi.fn();
    newBtn.addEventListener('click', ytNewListener, false);
    newBtn.addEventListener('click', ytNewListener, true);
    newSvg.click();
    expect(ytNewListener).not.toHaveBeenCalled();
    expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(true);
  });

  it('exposes complete Fullscreen API surface, dispatches fullscreenchange/webkitfullscreenchange, and handles all enter/exit paths', async () => {
    const env = createRichDomEnv();
    vm.runInContext(contentJs, env.ctx);

    expect(env.mockDoc.fullscreenEnabled).toBe(true);
    expect(env.mockDoc.webkitFullscreenEnabled).toBe(true);

    const docFsChanges: string[] = [];
    const winResizes: number[] = [];
    env.mockDoc.addEventListener('fullscreenchange', () => docFsChanges.push('fullscreenchange'));
    env.mockDoc.addEventListener('webkitfullscreenchange', () =>
      docFsChanges.push('webkitfullscreenchange'),
    );
    env.mockWin.addEventListener('resize', () => winResizes.push(1));

    // 1. Enter via webkitRequestFullscreen (must return Promise)
    await (env.playerEl as any).webkitRequestFullscreen();
    expect(env.htmlEl.classList.contains('tesroid-web-fs-root')).toBe(true);
    expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(true);
    expect(env.flexyEl?.hasAttribute('fullscreen')).toBe(false);
    expect(env.playerEl?.setFauxFullscreen).toHaveBeenCalledWith(true);
    expect(env.mockDoc.fullscreen).toBe(true);
    expect(env.mockDoc.webkitIsFullScreen).toBe(true);
    expect(env.mockDoc.fullscreenElement).toBe(env.playerEl);
    expect(env.mockDoc.webkitFullscreenElement).toBe(env.playerEl);
    expect(env.mockDoc.webkitCurrentFullScreenElement).toBe(env.playerEl);
    expect(docFsChanges).toEqual(['fullscreenchange', 'webkitfullscreenchange']);
    expect(winResizes.length).toBe(1);

    // 2. Exit via Escape key
    const escEv = new env.MockEvent('keydown', { key: 'Escape' });
    env.mockWin.dispatchEvent(escEv);
    expect(escEv.defaultPrevented).toBe(true);
    expect(escEv.immediatePropagationStopped).toBe(true);
    expect(env.htmlEl.classList.contains('tesroid-web-fs-root')).toBe(false);
    expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(false);
    expect(env.playerEl?.classList.contains('ytp-fullscreen')).toBe(false);
    expect(env.playerEl?.setFauxFullscreen).toHaveBeenCalledWith(false);
    expect(env.mockDoc.fullscreenElement).toBeNull();
    expect(docFsChanges).toEqual([
      'fullscreenchange',
      'webkitfullscreenchange',
      'fullscreenchange',
      'webkitfullscreenchange',
    ]);

    // 3. Enter via player.toggleFullscreen() & exit via yt-navigate-start
    env.playerEl?.toggleFullscreen?.();
    expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(true);
    env.mockWin.dispatchEvent(new env.MockEvent('yt-navigate-start'));
    expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(false);

    // 4. Enter via HTMLVideoElement.prototype.webkitEnterFullscreen & exit via webkitExitFullscreen
    (env.videoEl as any).webkitEnterFullscreen();
    expect(env.mockDoc.fullscreenElement).toBe(env.videoEl);
    await env.mockDoc.webkitExitFullscreen();
    expect(env.mockDoc.fullscreenElement).toBeNull();
  });

  it('adapts window.screen dimensions during fullscreen so YouTube 2s screen-size check never marks fullscreen unavailable', () => {
    const env = createRichDomEnv({
      screenWidth: 1920,
      screenHeight: 1080,
      outerWidth: 1256,
      outerHeight: 658,
      innerWidth: 1256,
      innerHeight: 626,
    });
    vm.runInContext(contentJs, env.ctx);

    // Before fullscreen: native Xvfb screen size preserved
    expect(env.mockScreen.width).toBe(1920);
    expect(env.mockScreen.height).toBe(1080);

    // Enter fullscreen: screen dimensions reflect Chrome window so screen*0.9 <= outerWidth/Height
    env.mockWin.tesroidEnterFs();
    expect(env.mockScreen.width).toBe(1256);
    expect(env.mockScreen.height).toBe(658);
    expect(env.mockScreen.width * 0.9 > env.mockWin.outerWidth).toBe(false);
    expect(env.mockScreen.height * 0.9 > env.mockWin.outerHeight).toBe(false);

    // After exit: native Xvfb screen size restored
    env.mockWin.tesroidExitFs();
    expect(env.mockScreen.width).toBe(1920);
    expect(env.mockScreen.height).toBe(1080);
  });

  it('supports non-YouTube generic video and container fullscreen cleanly', () => {
    const env = createRichDomEnv({ withYouTube: false });
    vm.runInContext(`(() => { ${buildCarFullscreenScript()} })()`, env.ctx);

    const wrapper = new env.MockEl('div', 'custom-player');
    const video2 = new env.MockVideoEl('second-video');
    env.bodyEl.appendChild(wrapper);
    env.bodyEl.appendChild(video2);

    (wrapper as any).requestFullscreen();
    expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(true);
    expect(wrapper.classList.contains('tesroid-generic-fs-target')).toBe(true);
    expect(env.mockDoc.fullscreenElement).toBe(wrapper);

    // Switching directly to another target clears class from previous element
    (video2 as any).requestFullscreen();
    expect(wrapper.classList.contains('tesroid-generic-fs-target')).toBe(false);
    expect(video2.classList.contains('tesroid-generic-fs-target')).toBe(true);
    expect(env.mockDoc.fullscreenElement).toBe(video2);

    env.mockDoc.exitFullscreen();
    expect(video2.classList.contains('tesroid-generic-fs-target')).toBe(false);
    expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(false);
    expect(env.mockDoc.fullscreenElement).toBeNull();
  });
});
