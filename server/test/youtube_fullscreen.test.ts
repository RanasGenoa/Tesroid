import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  buildCarFullscreenScript,
  clampDisplayScale,
  FULLSCREEN_CORE_END_MARKER,
  FULLSCREEN_CORE_START_MARKER,
  loadFullscreenCoreScript,
} from '../src/browser/fullscreen-script.js';
import { X11InputManager } from '../src/input/xdotool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, '..');

const contentJs = fs.readFileSync(path.join(SERVER_ROOT, 'extension/content.js'), 'utf-8');
const fullscreenScriptTs = fs.readFileSync(
  path.join(SERVER_ROOT, 'src/browser/fullscreen-script.ts'),
  'utf-8',
);
const managerTs = fs.readFileSync(path.join(SERVER_ROOT, 'src/browser/manager.ts'), 'utf-8');
const xdotoolTs = fs.readFileSync(path.join(SERVER_ROOT, 'src/input/xdotool.ts'), 'utf-8');

type MockEventHandler = (e: MockEvent) => void;

interface MockListener {
  fn: MockEventHandler;
  capture: boolean;
}

interface MockEventTarget {
  parentNode: MockEventTarget | null;
  listeners: Map<string, MockListener[]>;
  closest?: (selector: string) => MockEl | null;
  classList?: MockClassList;
}

interface MockStyle {
  pointerEvents?: string;
  opacity?: string;
  setProperty: (key: string, value: string) => void;
  getPropertyValue: (key: string) => string;
}

class MockClassList {
  public set = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) {
      this.set.add(token);
    }
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) {
      this.set.delete(token);
    }
  }

  contains(token: string): boolean {
    return this.set.has(token);
  }
}

class MockEvent {
  public type: string;
  public bubbles: boolean;
  public key?: string;
  public target: MockEventTarget | null = null;
  public currentTarget: MockEventTarget | null = null;
  public defaultPrevented = false;
  public propagationStopped = false;
  public immediatePropagationStopped = false;
  public _tesroidFsHandled?: boolean;
  public composedPath?: () => MockEventTarget[];

  constructor(
    type: string,
    init?: {
      bubbles?: boolean;
      key?: string;
      target?: MockEventTarget | null;
      composedPath?: () => MockEventTarget[];
    },
  ) {
    this.type = type;
    this.bubbles = Boolean(init?.bubbles);
    if (init?.key !== undefined) this.key = init.key;
    if (init?.target !== undefined) this.target = init.target;
    if (init?.composedPath !== undefined) this.composedPath = init.composedPath;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  stopImmediatePropagation(): void {
    this.immediatePropagationStopped = true;
    this.propagationStopped = true;
  }
}

class MockEl implements MockEventTarget {
  public tagName: string;
  public id = '';
  public classList = new MockClassList();
  public style: MockStyle;
  public attrs = new Map<string, string>();
  public children: MockEl[] = [];
  public parentNode: MockEventTarget | null = null;
  public textContent = '';
  public listeners = new Map<string, MockListener[]>();
  public isConnected = true;
  public setFauxFullscreen?: Mock<(enabled: boolean) => void>;
  public setPlaybackQualityRange?: Mock<(min: string, max: string) => void>;
  public toggleFullscreen?: () => void;
  public _tesroidFsHooked?: boolean;
  declare requestFullscreen?: () => Promise<void>;
  declare webkitRequestFullscreen?: () => Promise<void>;
  declare webkitRequestFullScreen?: () => Promise<void>;

  constructor(
    tagName: string,
    id = '',
    classes: string[] = [],
    cssVars: Map<string, string> = new Map(),
    elementsById: Map<string, MockEl> = new Map(),
  ) {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.style = {
      setProperty: (k: string, v: string) => {
        cssVars.set(k, v);
      },
      getPropertyValue: (k: string) => cssVars.get(k) || '',
    };
    for (const c of classes) {
      this.classList.add(c);
    }
    if (id) {
      elementsById.set(id, this);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? (this.attrs.get(name) ?? null) : null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  appendChild(child: MockEl): MockEl {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  closest(selector: string): MockEl | null {
    const cls = selector.startsWith('.') ? selector.slice(1) : null;
    const id = selector.startsWith('#') ? selector.slice(1) : null;
    let cur: MockEventTarget | null = this;
    while (cur && cur instanceof MockEl) {
      if (cls && cur.classList.contains(cls)) return cur;
      if (id && cur.id === id) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  addEventListener(type: string, fn: MockEventHandler, capture = false): void {
    const list = this.listeners.get(type) || [];
    list.push({ fn, capture: Boolean(capture) });
    this.listeners.set(type, list);
  }

  dispatchEvent(event: MockEvent): boolean {
    if (!event.target) event.target = this;
    const chain: MockEventTarget[] = [];
    let cur: MockEventTarget | null = this;
    while (cur) {
      chain.push(cur);
      cur = cur.parentNode;
    }
    // Capture phase: root -> parent
    for (let i = chain.length - 1; i >= 1; i--) {
      const node = chain[i];
      const list = (node.listeners.get(event.type) || []).filter((l) => l.capture);
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
      const list = (node.listeners.get(event.type) || []).filter((l) => !l.capture);
      for (const l of list) {
        if (event.immediatePropagationStopped) break;
        event.currentTarget = node;
        l.fn(event);
      }
      if (event.propagationStopped) break;
    }
    return !event.defaultPrevented;
  }

  click(): MockEvent {
    const ev = new MockEvent('click', { bubbles: true });
    this.dispatchEvent(ev);
    return ev;
  }
}

class MockVideoEl extends MockEl {
  public muted = false;
  public volume = 1;
  declare webkitEnterFullscreen?: () => void;
  declare webkitEnterFullScreen?: () => void;
  declare webkitExitFullscreen?: () => Promise<void>;
  declare webkitExitFullScreen?: () => Promise<void>;

  constructor(
    id = '',
    cssVars: Map<string, string> = new Map(),
    elementsById: Map<string, MockEl> = new Map(),
  ) {
    super('video', id, [], cssVars, elementsById);
  }
}

interface MockDocument extends MockEventTarget {
  cookie: string;
  documentElement: MockEl;
  head: MockEl;
  body: MockEl;
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  fullscreenElement?: MockEl | null;
  webkitFullscreenElement?: MockEl | null;
  webkitCurrentFullScreenElement?: MockEl | null;
  fullscreen?: boolean;
  webkitIsFullScreen?: boolean;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => Promise<void>;
  webkitCancelFullScreen?: () => Promise<void>;
  getElementById: (id: string) => MockEl | null;
  querySelector: (selector: string) => MockEl | null;
  querySelectorAll: (selector: string) => MockEl[];
  createElement: (tag: string) => MockEl;
  addEventListener: (type: string, fn: MockEventHandler, capture?: boolean) => void;
  dispatchEvent: (ev: MockEvent) => boolean;
}

interface MockScreen {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
}

interface MockWindow extends MockEventTarget {
  document: MockDocument;
  screen: MockScreen;
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
  Element: typeof MockEl;
  HTMLVideoElement: typeof MockVideoEl;
  Event: typeof MockEvent;
  navigator: {
    credentials: {
      get: Mock;
      create: Mock;
    };
  };
  PublicKeyCredential: {
    isUserVerifyingPlatformAuthenticatorAvailable: Mock;
    isConditionalMediationAvailable: Mock;
  };
  __tesroidDisplayScale?: number;
  _tesroidExtensionLoaded?: boolean;
  _tesroidFullscreenInstalled?: boolean;
  _tesroidBridgeActive?: boolean;
  tesroidSetZoom?: (scalePercent: number) => void;
  tesroidEnterFs?: (el?: MockEl) => void;
  tesroidExitFs?: () => void;
  tesroidToggleFs?: () => void;
  addEventListener: (type: string, fn: MockEventHandler, capture?: boolean) => void;
  dispatchEvent: (ev: MockEvent) => boolean;
  setInterval: (fn: () => void, ms?: number) => number;
}

interface CdpCommand {
  method: string;
  params: {
    source?: string;
    [key: string]: unknown;
  };
}

interface CdpBridgeLike {
  isConnected: () => boolean;
  send: (method: string, params: { source?: string; [key: string]: unknown }) => void;
  setupCarOptimizations: () => void;
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

function createRichDomEnv(opts?: {
  withYouTube?: boolean;
  withVideo?: boolean;
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

  const createEl = (tagName: string, id = '', classes: string[] = []): MockEl =>
    new MockEl(tagName, id, classes, cssVars, elementsById);

  const createVideoEl = (id = ''): MockVideoEl => new MockVideoEl(id, cssVars, elementsById);

  const docListeners = new Map<string, MockListener[]>();
  const winListeners = new Map<string, MockListener[]>();

  const htmlEl = createEl('html');
  const headEl = createEl('head');
  const bodyEl = createEl('body');
  htmlEl.appendChild(headEl);
  htmlEl.appendChild(bodyEl);

  const appendTrackedChild = (parent: MockEl, child: MockEl): MockEl => {
    if (child.id) elementsById.set(child.id, child);
    return parent.appendChild(child);
  };

  // Override head.appendChild so dynamically created <style id="tesroid-car-style"> registers in elementsById
  const origHeadAppend = headEl.appendChild.bind(headEl);
  headEl.appendChild = (child: MockEl): MockEl => {
    if (child.id) elementsById.set(child.id, child);
    return origHeadAppend(child);
  };

  let flexyEl: MockEl | null = null;
  let playerEl: MockEl | null = null;
  let fsBtnEl: MockEl | null = null;
  let fsSvgEl: MockEl | null = null;
  let videoEl: MockVideoEl | null = null;

  if (withYouTube) {
    flexyEl = createEl('ytd-watch-flexy');
    playerEl = createEl('movie_player', 'movie_player', ['html5-video-player']);
    playerEl.setFauxFullscreen = vi.fn<(enabled: boolean) => void>();
    playerEl.setPlaybackQualityRange = vi.fn<(min: string, max: string) => void>();
    const videoContainer = createEl('div', '', ['html5-video-container']);
    videoEl = createVideoEl();
    videoContainer.appendChild(videoEl);
    fsBtnEl = createEl('button', '', ['ytp-fullscreen-button', 'ytp-button']);
    fsSvgEl = createEl('svg');
    fsBtnEl.appendChild(fsSvgEl);
    appendTrackedChild(playerEl, videoContainer);
    appendTrackedChild(playerEl, fsBtnEl);
    appendTrackedChild(flexyEl, playerEl);
    appendTrackedChild(bodyEl, flexyEl);
  } else if (opts?.withVideo ?? true) {
    videoEl = createVideoEl('generic-video');
    appendTrackedChild(bodyEl, videoEl);
  }

  const mockDoc: MockDocument = {
    cookie: '',
    parentNode: null,
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
    createElement: (tag: string) => createEl(tag),
    addEventListener: (type: string, fn: MockEventHandler, capture = false) => {
      const list = docListeners.get(type) || [];
      list.push({ fn, capture: Boolean(capture) });
      docListeners.set(type, list);
    },
    dispatchEvent: (ev: MockEvent) => {
      const list = docListeners.get(ev.type) || [];
      const ordered = [...list.filter((l) => l.capture), ...list.filter((l) => !l.capture)];
      for (const l of ordered) {
        if (ev.immediatePropagationStopped) break;
        ev.currentTarget = mockDoc;
        l.fn(ev);
      }
      return !ev.defaultPrevented;
    },
  };

  htmlEl.parentNode = mockDoc;

  const mockScreen: MockScreen = {
    width: opts?.screenWidth ?? 1920,
    height: opts?.screenHeight ?? 1080,
    availWidth: opts?.screenWidth ?? 1920,
    availHeight: opts?.screenHeight ?? 1080,
  };

  const mockWin: MockWindow = {
    parentNode: null,
    listeners: winListeners,
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
    addEventListener: (type: string, fn: MockEventHandler, capture = false) => {
      const list = winListeners.get(type) || [];
      list.push({ fn, capture: Boolean(capture) });
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
    const newBtn = createEl('button', '', ['ytp-fullscreen-button', 'ytp-button']);
    const newSvg = createEl('svg');
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
    createEl,
    createVideoEl,
    attachNewFsButton,
  };
}

function captureCdpTouchBridgeScript(): string {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('CDP offline in test'));
  const inputManager = new X11InputManager(':99', 1280, 720);
  try {
    const bridge = (inputManager as unknown as { cdpBridge: CdpBridgeLike }).cdpBridge;
    const sent: CdpCommand[] = [];
    bridge.isConnected = () => true;
    bridge.send = (method, params) => {
      sent.push({ method, params });
    };
    bridge.setupCarOptimizations();
    const evalCmd = sent.find((s) => s.method === 'Page.addScriptToEvaluateOnNewDocument');
    return requireValue(evalCmd?.params.source, 'CdpTouchBridge source script');
  } finally {
    inputManager.close();
    globalThis.fetch = originalFetch;
  }
}

const scriptSources = [
  {
    name: 'extension/content.js',
    run: (ctx: vm.Context) => vm.runInContext(contentJs, ctx),
  },
  {
    name: 'buildCarFullscreenScript()',
    run: (ctx: vm.Context) => vm.runInContext(`(() => { ${buildCarFullscreenScript()} })()`, ctx),
  },
] as const;

describe('YouTube Web Fullscreen & Car Optimization Scripts (Issue #67)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses content.js as Single Source of Truth across all 3 injection points with zero duplicated CSS/logic', () => {
    const coreScript = loadFullscreenCoreScript();
    const sharedScript = buildCarFullscreenScript(130);
    const bridgeScript = captureCdpTouchBridgeScript();

    expect(contentJs).toContain(FULLSCREEN_CORE_START_MARKER);
    expect(contentJs).toContain(FULLSCREEN_CORE_END_MARKER);
    expect(contentJs).toContain(coreScript);
    expect(sharedScript).toContain(coreScript);
    expect(bridgeScript).toContain(coreScript);

    // Ensure fullscreen-script.ts delegates cleanly to content.js rather than duplicating CSS/DOM logic
    expect(fullscreenScriptTs).not.toContain('.html5-video-container');
    expect(fullscreenScriptTs).not.toContain('#cinematics');
    expect(fullscreenScriptTs).not.toContain('tesroidEnterFs');

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
    const reqFsAfterFirst = MockEl.prototype.requestFullscreen;

    // Enter fullscreen before manager & xdotool run to verify active state survives late injections
    requireValue(env1.mockWin.tesroidEnterFs, 'mockWin.tesroidEnterFs')();
    expect(env1.mockDoc.fullscreenElement).toBe(env1.playerEl);

    vm.runInContext(managerScript, env1.ctx);
    vm.runInContext(bridgeScript, env1.ctx);

    expect(env1.mockWin.tesroidEnterFs).toBe(enterFnAfterFirst);
    expect(MockEl.prototype.requestFullscreen).toBe(reqFsAfterFirst);
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

  it('rounds fractional displayScale consistently in clampDisplayScale and buildCarFullscreenScript prelude', () => {
    expect(clampDisplayScale(125.6)).toBe(126);
    expect(clampDisplayScale(49.4)).toBe(120);

    const envFromBuilder = createRichDomEnv();
    vm.runInContext(`(() => { ${buildCarFullscreenScript(125.6)} })()`, envFromBuilder.ctx);
    expect(envFromBuilder.mockWin.__tesroidDisplayScale).toBe(126);
    expect(envFromBuilder.cssVars.get('--tesroid-zoom')).toBe('1.26');
  });

  describe.each(scriptSources)('behavioral parity ($name)', ({ run }) => {
    it('intercepts .ytp-fullscreen-button clicks cleanly in capture phase without double-toggle or firing YouTube click listener', () => {
      const env = createRichDomEnv();
      run(env.ctx);

      const fsBtn = requireValue(env.fsBtnEl, 'fsBtnEl');
      const fsSvg = requireValue(env.fsSvgEl, 'fsSvgEl');
      const player = requireValue(env.playerEl, 'playerEl');

      const ytClickSpy = vi.fn<MockEventHandler>();
      const playerClickSpy = vi.fn<MockEventHandler>();
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
      const ytNewListener = vi.fn<MockEventHandler>();
      newBtn.addEventListener('click', ytNewListener, false);
      newBtn.addEventListener('click', ytNewListener, true);
      newSvg.click();
      expect(ytNewListener).not.toHaveBeenCalled();
      expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(true);

      // Shadow DOM / non-Element target lacking `.closest()` falls back to `composedPath()` cleanly
      const lateDocSpy = vi.fn<MockEventHandler>();
      env.mockDoc.addEventListener('click', lateDocSpy, true);
      const shadowInner: MockEventTarget = {
        parentNode: null,
        listeners: new Map(),
      };
      const shadowEv = new MockEvent('click', {
        bubbles: true,
        target: shadowInner,
        composedPath: () => [shadowInner, newBtn, player, env.mockDoc],
      });
      env.mockDoc.dispatchEvent(shadowEv);
      expect(shadowEv.defaultPrevented).toBe(true);
      expect(shadowEv.immediatePropagationStopped).toBe(true);
      expect(lateDocSpy).not.toHaveBeenCalled();
      expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(false);
    });

    it('exposes complete Fullscreen API surface, dispatches fullscreenchange/webkitfullscreenchange, and handles edge-case exits cleanly', async () => {
      const env = createRichDomEnv();
      run(env.ctx);

      const player = requireValue(env.playerEl, 'playerEl');
      const video = requireValue(env.videoEl, 'videoEl');
      const flexy = requireValue(env.flexyEl, 'flexyEl');
      const tesroidExitFs = requireValue(env.mockWin.tesroidExitFs, 'tesroidExitFs');
      const exitFullscreen = requireValue(env.mockDoc.exitFullscreen, 'document.exitFullscreen');
      const webkitExitFullscreen = requireValue(
        env.mockDoc.webkitExitFullscreen,
        'document.webkitExitFullscreen',
      );
      const webkitCancelFullScreen = requireValue(
        env.mockDoc.webkitCancelFullScreen,
        'document.webkitCancelFullScreen',
      );
      const setFauxFullscreen = requireValue(player.setFauxFullscreen, 'player.setFauxFullscreen');

      expect(env.mockDoc.fullscreenEnabled).toBe(true);
      expect(env.mockDoc.webkitFullscreenEnabled).toBe(true);

      const docFsChanges: string[] = [];
      const winResizes: number[] = [];
      env.mockDoc.addEventListener('fullscreenchange', () => docFsChanges.push('fullscreenchange'));
      env.mockDoc.addEventListener('webkitfullscreenchange', () =>
        docFsChanges.push('webkitfullscreenchange'),
      );
      env.mockWin.addEventListener('resize', () => winResizes.push(1));

      // Calling exit while NOT in fullscreen must be a strict no-op (no spurious events)
      tesroidExitFs();
      await exitFullscreen();
      expect(docFsChanges).toEqual([]);
      expect(winResizes).toHaveLength(0);
      expect(setFauxFullscreen).not.toHaveBeenCalled();

      // 1. Enter via webkitRequestFullscreen (must return Promise)
      await requireValue(player.webkitRequestFullscreen, 'player.webkitRequestFullscreen').call(
        player,
      );
      expect(env.htmlEl.classList.contains('tesroid-web-fs-root')).toBe(true);
      expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(true);
      expect(flexy.hasAttribute('fullscreen')).toBe(false);
      expect(setFauxFullscreen).toHaveBeenCalledWith(true);
      expect(env.mockDoc.fullscreen).toBe(true);
      expect(env.mockDoc.webkitIsFullScreen).toBe(true);
      expect(env.mockDoc.fullscreenElement).toBe(player);
      expect(env.mockDoc.webkitFullscreenElement).toBe(player);
      expect(env.mockDoc.webkitCurrentFullScreenElement).toBe(player);
      expect(docFsChanges).toEqual(['fullscreenchange', 'webkitfullscreenchange']);
      expect(winResizes).toHaveLength(1);

      // 2. Exit via Escape key
      const escEv = new MockEvent('keydown', { key: 'Escape' });
      env.mockWin.dispatchEvent(escEv);
      expect(escEv.defaultPrevented).toBe(true);
      expect(escEv.immediatePropagationStopped).toBe(true);
      expect(env.htmlEl.classList.contains('tesroid-web-fs-root')).toBe(false);
      expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(false);
      expect(player.classList.contains('ytp-fullscreen')).toBe(false);
      expect(setFauxFullscreen).toHaveBeenCalledWith(false);
      expect(env.mockDoc.fullscreenElement).toBeNull();
      expect(docFsChanges).toEqual([
        'fullscreenchange',
        'webkitfullscreenchange',
        'fullscreenchange',
        'webkitfullscreenchange',
      ]);
      expect(winResizes).toHaveLength(2);

      // Repeated exit calls after already exiting must emit no extra events or setFauxFullscreen calls
      expect(setFauxFullscreen).toHaveBeenCalledTimes(2);
      tesroidExitFs();
      await exitFullscreen();
      await webkitCancelFullScreen();
      expect(docFsChanges).toHaveLength(4);
      expect(winResizes).toHaveLength(2);
      expect(setFauxFullscreen).toHaveBeenCalledTimes(2);

      // 3. Enter via player.toggleFullscreen() & exit via yt-navigate-start
      requireValue(player.toggleFullscreen, 'player.toggleFullscreen')();
      expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(true);
      env.mockWin.dispatchEvent(new MockEvent('yt-navigate-start'));
      expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(false);

      // 4. Enter via HTMLVideoElement.prototype.webkitEnterFullscreen & exit via webkitExitFullscreen
      requireValue(video.webkitEnterFullscreen, 'video.webkitEnterFullscreen').call(video);
      expect(env.mockDoc.fullscreenElement).toBe(video);
      await webkitExitFullscreen();
      expect(env.mockDoc.fullscreenElement).toBeNull();

      // 5. Disconnected fullscreen element fallback: still dispatches change events on document
      const transientEl = env.createEl('div', 'transient-fs');
      await requireValue(transientEl.requestFullscreen, 'transientEl.requestFullscreen').call(
        transientEl,
      );
      transientEl.isConnected = false;
      const beforeDisconnectExitCount = docFsChanges.length;
      tesroidExitFs();
      expect(env.mockDoc.fullscreenElement).toBeNull();
      expect(docFsChanges.slice(beforeDisconnectExitCount)).toEqual([
        'fullscreenchange',
        'webkitfullscreenchange',
      ]);

      // 6. Orphan root class cleanup without activeFsEl
      env.htmlEl.classList.add('tesroid-web-fs-root');
      tesroidExitFs();
      expect(env.htmlEl.classList.contains('tesroid-web-fs-root')).toBe(false);
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
      run(env.ctx);

      const tesroidEnterFs = requireValue(env.mockWin.tesroidEnterFs, 'tesroidEnterFs');
      const tesroidExitFs = requireValue(env.mockWin.tesroidExitFs, 'tesroidExitFs');

      // Before fullscreen: native Xvfb screen size preserved
      expect(env.mockScreen.width).toBe(1920);
      expect(env.mockScreen.height).toBe(1080);

      // Enter fullscreen: screen dimensions reflect Chrome window so screen*0.9 <= outerWidth/Height
      tesroidEnterFs();
      expect(env.mockScreen.width).toBe(1256);
      expect(env.mockScreen.height).toBe(658);
      expect(env.mockScreen.width * 0.9 > env.mockWin.outerWidth).toBe(false);
      expect(env.mockScreen.height * 0.9 > env.mockWin.outerHeight).toBe(false);

      // After exit: native Xvfb screen size restored
      tesroidExitFs();
      expect(env.mockScreen.width).toBe(1920);
      expect(env.mockScreen.height).toBe(1080);
    });

    it('reads native dimensions via Screen.prototype getters in readOrig and falls back when a getter throws', () => {
      const env = createRichDomEnv({
        outerWidth: 1256,
        outerHeight: 658,
        innerWidth: 1256,
        innerHeight: 626,
      });

      let nativeWidth = 1920;
      let nativeHeight = 1080;
      let nativeAvailWidth = 1920;
      let nativeAvailHeight = 1040;
      let shouldThrow = false;
      const getterCalls: Array<{ prop: string; isSelf: boolean }> = [];

      class ProtoScreen implements MockScreen {
        declare width: number;
        declare height: number;
        declare availWidth: number;
        declare availHeight: number;
      }

      const protoScreen = new ProtoScreen();
      const defineProtoGetter = (prop: keyof MockScreen, readValue: () => number) => {
        Object.defineProperty(ProtoScreen.prototype, prop, {
          get(this: unknown) {
            getterCalls.push({ prop, isSelf: this === protoScreen });
            if (shouldThrow) {
              throw new Error(`Screen.${prop} getter failed`);
            }
            return readValue();
          },
          configurable: true,
        });
      };

      defineProtoGetter('width', () => nativeWidth);
      defineProtoGetter('height', () => nativeHeight);
      defineProtoGetter('availWidth', () => nativeAvailWidth);
      defineProtoGetter('availHeight', () => nativeAvailHeight);

      env.mockWin.screen = protoScreen;
      (env.ctx as Record<string, unknown>).Screen = ProtoScreen;

      run(env.ctx);

      const tesroidEnterFs = requireValue(env.mockWin.tesroidEnterFs, 'tesroidEnterFs');
      const tesroidExitFs = requireValue(env.mockWin.tesroidExitFs, 'tesroidExitFs');

      // Mutate native Screen.prototype values after init to verify readOrig delegates to prototype getters
      getterCalls.length = 0;
      nativeWidth = 2560;
      nativeHeight = 1440;
      nativeAvailWidth = 2560;
      nativeAvailHeight = 1400;

      expect(protoScreen.width).toBe(2560);
      expect(protoScreen.height).toBe(1440);
      expect(protoScreen.availWidth).toBe(2560);
      expect(protoScreen.availHeight).toBe(1400);
      expect(getterCalls).toEqual([
        { prop: 'width', isSelf: true },
        { prop: 'height', isSelf: true },
        { prop: 'availWidth', isSelf: true },
        { prop: 'availHeight', isSelf: true },
      ]);

      // Fullscreen overrides screen dimensions with window dimensions
      tesroidEnterFs();
      expect(protoScreen.width).toBe(1256);
      expect(protoScreen.height).toBe(658);
      expect(protoScreen.availWidth).toBe(1256);
      expect(protoScreen.availHeight).toBe(658);

      // Exiting fullscreen restores reading from Screen.prototype getters
      tesroidExitFs();
      expect(protoScreen.width).toBe(2560);
      expect(protoScreen.height).toBe(1440);
      expect(protoScreen.availWidth).toBe(2560);
      expect(protoScreen.availHeight).toBe(1400);

      // Throwing Screen.prototype getters fall back cleanly to captured initial dimensions
      shouldThrow = true;
      expect(protoScreen.width).toBe(1920);
      expect(protoScreen.height).toBe(1080);
      expect(protoScreen.availWidth).toBe(1920);
      expect(protoScreen.availHeight).toBe(1040);
    });

    it('supports non-YouTube generic video and container fullscreen cleanly', async () => {
      const env = createRichDomEnv({ withYouTube: false });
      run(env.ctx);

      const wrapper = env.createEl('div', 'custom-player');
      const video2 = env.createVideoEl('second-video');
      env.bodyEl.appendChild(wrapper);
      env.bodyEl.appendChild(video2);

      await requireValue(wrapper.requestFullscreen, 'wrapper.requestFullscreen').call(wrapper);
      expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(true);
      expect(wrapper.classList.contains('tesroid-generic-fs-target')).toBe(true);
      expect(env.mockDoc.fullscreenElement).toBe(wrapper);

      // Switching directly to another target clears class from previous element
      await requireValue(video2.requestFullscreen, 'video2.requestFullscreen').call(video2);
      expect(wrapper.classList.contains('tesroid-generic-fs-target')).toBe(false);
      expect(video2.classList.contains('tesroid-generic-fs-target')).toBe(true);
      expect(env.mockDoc.fullscreenElement).toBe(video2);

      await requireValue(env.mockDoc.exitFullscreen, 'document.exitFullscreen')();
      expect(video2.classList.contains('tesroid-generic-fs-target')).toBe(false);
      expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(false);
      expect(env.mockDoc.fullscreenElement).toBeNull();
    });

    it('rounds fractional displayScale consistently via tesroidSetZoom', () => {
      const env = createRichDomEnv();
      run(env.ctx);

      const tesroidSetZoom = requireValue(env.mockWin.tesroidSetZoom, 'tesroidSetZoom');

      tesroidSetZoom(125.6);
      expect(env.mockWin.__tesroidDisplayScale).toBe(126);
      expect(env.cssVars.get('--tesroid-zoom')).toBe('1.26');

      tesroidSetZoom(133.4);
      expect(env.mockWin.__tesroidDisplayScale).toBe(133);
      expect(env.cssVars.get('--tesroid-zoom')).toBe('1.33');

      tesroidSetZoom(49.4);
      expect(env.mockWin.__tesroidDisplayScale).toBe(120);
      expect(env.cssVars.get('--tesroid-zoom')).toBe('1.2');
    });

    it('skips redundant DOM attribute and style writes during interval polling when fullscreen button is already ready', () => {
      const env = createRichDomEnv();
      const btn = requireValue(env.fsBtnEl, 'fsBtnEl');
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('disabled', '');

      let pointerEventsWrites = 0;
      let opacityWrites = 0;
      let pointerEventsVal = 'none';
      let opacityVal = '0.5';
      Object.defineProperty(btn.style, 'pointerEvents', {
        get: () => pointerEventsVal,
        set: (v: string) => {
          pointerEventsWrites++;
          pointerEventsVal = v;
        },
        configurable: true,
      });
      Object.defineProperty(btn.style, 'opacity', {
        get: () => opacityVal,
        set: (v: string) => {
          opacityWrites++;
          opacityVal = v;
        },
        configurable: true,
      });

      const removeSpy = vi.spyOn(btn, 'removeAttribute');

      run(env.ctx);

      expect(removeSpy).toHaveBeenCalledTimes(2);
      expect(pointerEventsWrites).toBe(1);
      expect(opacityWrites).toBe(1);

      removeSpy.mockClear();
      pointerEventsWrites = 0;
      opacityWrites = 0;

      // Subsequent 1s interval ticks should perform zero DOM/style writes when unchanged
      env.intervals[0]?.();
      env.intervals[0]?.();

      expect(removeSpy).not.toHaveBeenCalled();
      expect(pointerEventsWrites).toBe(0);
      expect(opacityWrites).toBe(0);
    });

    it('treats tesroidEnterFs and tesroidToggleFs as a no-op when neither #movie_player nor video exists', () => {
      const env = createRichDomEnv({ withYouTube: false, withVideo: false });
      run(env.ctx);

      const tesroidEnterFs = requireValue(env.mockWin.tesroidEnterFs, 'tesroidEnterFs');
      const tesroidToggleFs = requireValue(env.mockWin.tesroidToggleFs, 'tesroidToggleFs');

      const docFsChanges: string[] = [];
      const winResizes: number[] = [];
      env.mockDoc.addEventListener('fullscreenchange', () => docFsChanges.push('fullscreenchange'));
      env.mockWin.addEventListener('resize', () => winResizes.push(1));

      tesroidEnterFs();
      expect(env.htmlEl.classList.contains('tesroid-web-fs-root')).toBe(false);
      expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(false);
      expect(env.mockDoc.fullscreenElement).toBeNull();
      expect(docFsChanges).toEqual([]);
      expect(winResizes).toHaveLength(0);

      tesroidToggleFs();
      expect(env.htmlEl.classList.contains('tesroid-web-fs-root')).toBe(false);
      expect(env.bodyEl.classList.contains('tesroid-web-fs-active')).toBe(false);
      expect(env.mockDoc.fullscreenElement).toBeNull();
      expect(docFsChanges).toEqual([]);
      expect(winResizes).toHaveLength(0);
    });
  });
});
