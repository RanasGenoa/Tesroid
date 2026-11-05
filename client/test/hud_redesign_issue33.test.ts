import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openSettingsWithAuth } from '../src/views/settings-modal.js';
import { renderStreamingView } from '../src/views/streaming.js';

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

describe('Issue 33: HUD Redesign & Settings Modal Cleanup Tests', () => {
  let elementRegistry: Map<string, any>;
  let mockContainer: any;
  let mockWsClient: any;
  let mockAudioPlayer: any;
  let mockAvSync: any;
  let onOpenSettings: any;
  let eventListeners: Record<string, Function[]>;
  const testToken = 'tesroid-jwt-token-33';

  function createMockElement(id?: string, tagName = 'div'): any {
    const listeners: Record<string, Function[]> = {};
    const el: any = {
      id: id || '',
      tagName,
      className: '',
      classList: {
        toggle: vi.fn(),
        remove: vi.fn(),
        add: vi.fn(),
      },
      style: {},
      children: [] as any[],
      listeners,
      title: '',
      textContent: '',
      innerHTML: '',
      addEventListener: vi.fn((event: string, fn: Function) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
      }),
      removeEventListener: vi.fn((event: string, fn: Function) => {
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
      }),
      querySelector: vi.fn((sel: string) => {
        if (sel.startsWith('#')) {
          return elementRegistry.get(sel.slice(1)) || null;
        }
        return null;
      }),
      querySelectorAll: vi.fn(() => []),
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
      },
    });

    if (id) {
      elementRegistry.set(id, el);
    }
    return el;
  }

  beforeEach(() => {
    elementRegistry = new Map<string, any>();
    eventListeners = {};

    const mockDocument: any = {
      getElementById: vi.fn((id: string) => elementRegistry.get(id) || null),
      createElement: vi.fn((tag: string) => createMockElement(undefined, tag)),
      body: createMockElement('body', 'body'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const mockWindow: any = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      location: { reload: vi.fn() },
      localStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
      sessionStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
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
    (globalThis as any).confirm = vi.fn().mockReturnValue(true);

    mockContainer = createMockElement('container');
    mockWsClient = {
      send: vi.fn(),
      on: vi.fn((event: string, handler: Function) => {
        if (!eventListeners[event]) eventListeners[event] = [];
        eventListeners[event].push(handler);
      }),
      off: vi.fn((event: string, handler: Function) => {
        if (eventListeners[event]) {
          eventListeners[event] = eventListeners[event].filter((h) => h !== handler);
        }
      }),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    mockAudioPlayer = {
      resetJitterBuffer: vi.fn(),
      jumpToLive: vi.fn(),
      unlock: vi.fn().mockResolvedValue(undefined),
      toggleMute: vi.fn(() => false),
      getStats: vi.fn(() => ({ packetsReceived: 0, state: 'running', isMuted: false })),
      handleAudioPacket: vi.fn(),
    };
    mockAvSync = {
      reset: vi.fn(),
      updateVideoPts: vi.fn(),
      getDriftMs: vi.fn(() => 0),
    };
    onOpenSettings = vi.fn();
  });

  it('1. HUDは画面上部に配置され（stream-hud が stream-viewport より前）、キーボード隠蔽を防止すること', () => {
    renderStreamingView(
      mockContainer,
      mockWsClient,
      mockAudioPlayer,
      mockAvSync,
      onOpenSettings,
      testToken,
    );

    const containerHtml = mockContainer.innerHTML;
    const hudIndex = containerHtml.indexOf('id="stream-hud"');
    const viewportIndex = containerHtml.indexOf('id="stream-viewport"');

    expect(hudIndex).toBeGreaterThan(-1);
    expect(viewportIndex).toBeGreaterThan(-1);
    // stream-hud が stream-viewport より前に記述されていること（画面上部Dock）
    expect(hudIndex).toBeLessThan(viewportIndex);
  });

  it('2. 不要なHUDボタン（更新、全画面、フィット、ミュート、HUDトグル）が削除されていること', () => {
    renderStreamingView(
      mockContainer,
      mockWsClient,
      mockAudioPlayer,
      mockAvSync,
      onOpenSettings,
      testToken,
    );

    // 削除対象ボタンが存在しないこと
    expect(elementRegistry.get('hud-reload-btn')).toBeUndefined();
    expect(elementRegistry.get('hud-cinema-btn')).toBeUndefined();
    expect(elementRegistry.get('hud-fit-toggle')).toBeUndefined();
    expect(elementRegistry.get('hud-mute-btn')).toBeUndefined();
    expect(elementRegistry.get('hud-toggle-btn')).toBeUndefined();

    // 必須コントロールは残っていること
    expect(elementRegistry.get('hud-stop-btn')).toBeDefined();
    expect(elementRegistry.get('hud-conn')).toBeDefined();
    expect(elementRegistry.get('hud-signal')).toBeDefined();
    expect(elementRegistry.get('hud-live-btn')).toBeDefined();
    expect(elementRegistry.get('hud-fps-toggle')).toBeDefined();
    expect(elementRegistry.get('hud-bitrate-toggle')).toBeDefined();
    expect(elementRegistry.get('hud-back-btn')).toBeDefined();
    expect(elementRegistry.get('hud-home-btn')).toBeDefined();
    expect(elementRegistry.get('hud-search-form')).toBeDefined();
    expect(elementRegistry.get('hud-settings-btn')).toBeDefined();
  });

  it('3. 通信シグナルメーター（hud-signal）がRTTと連動してレベル更新されること', () => {
    renderStreamingView(
      mockContainer,
      mockWsClient,
      mockAudioPlayer,
      mockAvSync,
      onOpenSettings,
      testToken,
    );

    const controlHandler = eventListeners['control']?.[0];
    expect(controlHandler).toBeDefined();

    const hudSignal = elementRegistry.get('hud-signal');
    expect(hudSignal).toBeDefined();

    // 良好通信 (RTT 25ms < 60ms) -> Level 4
    const now1 = performance.now();
    controlHandler({
      type: 'PONG',
      id: 1,
      clientTime: now1 - 25,
      serverTime: now1,
      serverMode: 'LIVE',
      catchupQueueMs: 0,
      serverBufferMs: 0,
    });
    expect(hudSignal.className).toBe('signal-meter signal-level-4');

    // 通常通信 (RTT 70ms) -> Level 3
    const now2 = performance.now();
    controlHandler({
      type: 'PONG',
      id: 2,
      clientTime: now2 - 180, // EWMA平滑化により徐々に変化
      serverTime: now2,
      serverMode: 'LIVE',
      catchupQueueMs: 0,
      serverBufferMs: 0,
    });
    // RTTが上がるとレベルが変動すること
    expect(hudSignal.className).toMatch(/signal-meter signal-level-[1-3]/);
  });

  it('4. 設定画面（settings-modal）から不要項目（電源、FPS/ビットレート選択、音声テスト、ログDL）が削除されていること', () => {
    openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());

    // 削除された項目
    expect(elementRegistry.get('power-sleep-btn')).toBeUndefined();
    expect(elementRegistry.get('power-resume-btn')).toBeUndefined();
    expect(elementRegistry.get('browser-restart-btn')).toBeUndefined();
    expect(elementRegistry.get('audio-test-btn')).toBeUndefined();
    expect(elementRegistry.get('cfg-bitrate')).toBeUndefined();
    expect(elementRegistry.get('cfg-fps')).toBeUndefined();
    expect(elementRegistry.get('cfg-telemetry-download-btn')).toBeUndefined();

    // 残っている項目
    expect(elementRegistry.get('browser-url-input')).toBeDefined();
    expect(elementRegistry.get('browser-url-btn')).toBeDefined();
    expect(elementRegistry.get('cfg-pin')).toBeDefined();
    expect(elementRegistry.get('cfg-display-scale')).toBeDefined();
    expect(elementRegistry.get('cfg-buffer-depth')).toBeDefined();
    expect(elementRegistry.get('cfg-save-btn')).toBeDefined();
    expect(elementRegistry.get('cfg-telemetry-toggle')).toBeDefined();
    expect(elementRegistry.get('cfg-telemetry-clear-btn')).toBeDefined();
  });
});
