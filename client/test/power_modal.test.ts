import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderStreamingView } from '../src/views/streaming.js';
import { ClientProtocol } from '../src/transport/protocol.js';

// クラスを new されるモックは arrow でなく正規関数コンストラクタで書く
vi.mock('../src/core/canvas-renderer.js', () => {
  return {
    CanvasRenderer: function (this: any) {
      this.resetFirstFrame = vi.fn();
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
    },
  };
});

vi.mock('../src/core/decoder.js', () => {
  return {
    VideoStreamDecoder: function (this: any) {
      this.reset = vi.fn();
      this.close = vi.fn();
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
      this.destroy = vi.fn();
    },
  };
});

vi.mock('../src/core/latency.js', () => {
  return {
    DynamicLatencyController: function (this: any) {},
  };
});

describe('Streaming View - Power & Resource Control Quick Modal', () => {
  let elementRegistry: Map<string, any>;
  let mockContainer: any;
  let mockWsClient: any;
  let mockAudioPlayer: any;
  let mockAvSync: any;
  let onOpenSettings: any;
  const testToken = 'tesroid-jwt-token-xyz';

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
      on: vi.fn(),
      off: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    mockAudioPlayer = {
      resetJitterBuffer: vi.fn(),
      unlock: vi.fn().mockResolvedValue(undefined),
      toggleMute: vi.fn(() => false),
    };
    mockAvSync = {
      reset: vi.fn(),
      updateVideoPts: vi.fn(),
    };
    onOpenSettings = vi.fn();
  });

  it('(a) hud-stop-btn クリックでモーダルが出る・即停止は起きぬ（wsClient.send が呼ばれぬ）', () => {
    renderStreamingView(mockContainer, mockWsClient, mockAudioPlayer, mockAvSync, onOpenSettings, testToken);

    const stopBtn = elementRegistry.get('hud-stop-btn');
    expect(stopBtn).toBeDefined();

    // クリック前はモーダルなし
    expect(elementRegistry.get('power-menu-modal')).toBeUndefined();

    // HUD 停止ボタンをクリック
    stopBtn.click();

    // モーダルが出現していること
    const modal = elementRegistry.get('power-menu-modal');
    expect(modal).toBeDefined();

    // 即停止は起きず、wsClient.send は呼ばれていないこと
    expect(mockWsClient.send).not.toHaveBeenCalled();
  });

  it('(b)「⚡再エンコード」クリックで fetch が /api/encoder/restart・POST・Bearer 付きで呼ばれる', async () => {
    renderStreamingView(mockContainer, mockWsClient, mockAudioPlayer, mockAvSync, onOpenSettings, testToken);

    // HUD 停止ボタンをクリックしてモーダルを開く
    const stopBtn = elementRegistry.get('hud-stop-btn');
    stopBtn.click();

    const encoderRestartBtn = elementRegistry.get('power-encoder-restart-btn');
    expect(encoderRestartBtn).toBeDefined();

    // 「⚡再エンコード」ボタンをクリック
    encoderRestartBtn.click();

    // 非同期 fetch の完了を待つ
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/encoder/restart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}` },
    });

    // モーダルは開いたまま（連続操作可能）
    expect(elementRegistry.get('power-menu-modal')).toBeDefined();
  });

  it('(c)「ワンタップ停止」で wsClient.send が1回呼ばれる', () => {
    renderStreamingView(mockContainer, mockWsClient, mockAudioPlayer, mockAvSync, onOpenSettings, testToken);

    // HUD 停止ボタンをクリックしてモーダルを開く
    const stopBtn = elementRegistry.get('hud-stop-btn');
    stopBtn.click();

    const quickStopBtn = elementRegistry.get('power-quick-stop-btn');
    expect(quickStopBtn).toBeDefined();

    // 「ワンタップ停止」をクリック
    quickStopBtn.click();

    // wsClient.send が1回呼ばれていること
    expect(mockWsClient.send).toHaveBeenCalledTimes(1);

    // 期待されるコマンドは PAUSE_BROWSER
    const expectedPayload = ClientProtocol.packCommand({ type: 'PAUSE_BROWSER' });
    expect(mockWsClient.send).toHaveBeenCalledWith(expectedPayload);

    // 音声ジッターバッファのリセットが行われていること
    expect(mockAudioPlayer.resetJitterBuffer).toHaveBeenCalledTimes(1);

    // モーダルが閉じていること（removeが呼ばれていること）
    expect(elementRegistry.get('power-menu-modal')).toBeUndefined();
  });
});
