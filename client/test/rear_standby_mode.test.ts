import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderStreamingView } from '../src/views/streaming.js';

let capturedOnFrame: ((frame: any) => void) | null = null;

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
      this.setAdditionalDelay = vi.fn();
      this.queueFrame = vi.fn();
      this.resetFirstFrame = vi.fn();
      this.reset = vi.fn();
      this.getBufferedDurationMs = vi.fn(() => 0);
      this.getQueueLength = vi.fn(() => 0);
      this.getMode = vi.fn(() => 'PASSIVE_STREAMING');
      this.getIsBuffering = vi.fn(() => false);
      this.destroy = vi.fn();
    },
  };
});

vi.mock('../src/core/decoder.js', () => {
  return {
    VideoStreamDecoder: function (this: any, onFrame: (frame: any) => void) {
      capturedOnFrame = onFrame;
      this.handlePacket = vi.fn();
      this.setBufferDepth = vi.fn();
      this.setTelemetryCollector = vi.fn();
      this.setDownstreamQueueLengthProvider = vi.fn();
      this.getPendingBufferedMs = vi.fn(() => 0);
      this.getDecodeQueueSize = vi.fn(() => 0);
      this.clearPendingPackets = vi.fn();
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
      this.recordVideoPacket = vi.fn();
      this.recordAudioPacket = vi.fn();
      this.recordFrameRendered = vi.fn();
      this.recordDecoderError = vi.fn();
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
    },
  };
});

describe('Streaming View - Rear-Seat Standby Mode (Issue #72)', () => {
  let elementRegistry: Map<string, any>;
  let wsListeners: Map<string, Function[]>;
  let mockContainer: any;
  let mockWsClient: any;
  let mockAudioPlayer: any;
  let mockAvSync: any;
  let cleanupView: (() => void) | null = null;

  const originalDocument = (globalThis as any).document;
  const originalWindow = (globalThis as any).window;
  const originalLocalStorage = (globalThis as any).localStorage;
  const originalSessionStorage = (globalThis as any).sessionStorage;
  const originalFetch = (globalThis as any).fetch;

  function createMockElement(id?: string, tagName = 'div'): any {
    const listeners: Record<string, Function[]> = {};
    const el: any = {
      id: id || '',
      tagName,
      className: '',
      textContent: '',
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
      querySelector: vi.fn((sel: string) =>
        sel.startsWith('#') ? elementRegistry.get(sel.slice(1)) || null : null,
      ),
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
    wsListeners = new Map<string, Function[]>();
    capturedOnFrame = null;
    cleanupView = null;

    const mockDocument: any = {
      getElementById: vi.fn((id: string) => elementRegistry.get(id) || null),
      createElement: vi.fn((tag: string) => createMockElement(undefined, tag)),
      body: createMockElement('body', 'body'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const storageMock = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    const mockWindow: any = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      location: { reload: vi.fn(), search: '' },
      localStorage: storageMock,
      sessionStorage: storageMock,
    };

    (globalThis as any).document = mockDocument;
    (globalThis as any).window = mockWindow;
    (globalThis as any).localStorage = storageMock;
    (globalThis as any).sessionStorage = storageMock;
    (globalThis as any).requestAnimationFrame = vi.fn((cb: any) => setTimeout(cb, 0));
    (globalThis as any).cancelAnimationFrame = vi.fn();
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    mockContainer = createMockElement('container');
    mockWsClient = {
      send: vi.fn(),
      on: vi.fn((ev: string, fn: Function) => {
        if (!wsListeners.has(ev)) wsListeners.set(ev, []);
        wsListeners.get(ev)!.push(fn);
      }),
      off: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    mockAudioPlayer = {
      resetJitterBuffer: vi.fn(),
      setAdditionalDelay: vi.fn(),
      getStats: vi.fn(() => ({ isUnlocked: false, state: 'suspended', packetsReceived: 0 })),
      unlock: vi.fn().mockResolvedValue(undefined),
      toggleMute: vi.fn(() => false),
    };
    mockAvSync = {
      reset: vi.fn(),
      updateVideoPts: vi.fn(),
      getDriftMs: vi.fn(() => 0),
    };
  });

  afterEach(() => {
    cleanupView?.();
    (globalThis as any).document = originalDocument;
    (globalThis as any).window = originalWindow;
    (globalThis as any).localStorage = originalLocalStorage;
    (globalThis as any).sessionStorage = originalSessionStorage;
    (globalThis as any).fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const emitWs = (event: string, payload: any) => {
    for (const fn of wsListeners.get(event) || []) {
      fn(payload);
    }
  };

  it('shows rear-seat standby overlay when primary is inactive, ignores paused status overwrites, and transitions to stream on primary connect/disconnect', () => {
    cleanupView = renderStreamingView(
      mockContainer,
      mockWsClient,
      mockAudioPlayer,
      mockAvSync,
      vi.fn(),
      'token-rear',
      'secondary',
      { initialPrimaryActive: false },
    );

    const statusOverlay = elementRegistry.get('stream-status-overlay');
    const noticeTitle = elementRegistry.get('notice-title');
    const noticeActionBtn = elementRegistry.get('notice-action-btn');

    expect(statusOverlay.style.display).toBe('flex');
    expect(noticeTitle.textContent).toBe('後席モニター待ち受け中');
    expect(noticeActionBtn.style.display).toBe('none');

    // Tapping overlay while waiting in rear standby must NOT trigger RESUME_BROWSER
    statusOverlay.click();
    expect(mockWsClient.send).not.toHaveBeenCalled();

    // Server reports browser paused (auto-sleep) -> standby overlay must NOT be overwritten
    emitWs('control', { type: 'BROWSER_STATUS', state: 'paused' });
    emitWs('control', { type: 'SERVER_METRICS', browserState: 'paused' });
    expect(noticeTitle.textContent).toBe('後席モニター待ち受け中');
    expect(noticeActionBtn.style.display).toBe('none');

    // Primary connects -> PRIMARY_SESSION_STATUS active: true -> switches to preparing, then hides overlay when frame renders
    emitWs('control', { type: 'PRIMARY_SESSION_STATUS', active: true });
    expect(noticeTitle.textContent).toBe('画面配信準備中...');
    expect(statusOverlay.style.display).toBe('flex');

    capturedOnFrame?.({ close: vi.fn() });
    expect(statusOverlay.style.display).toBe('none');

    // Primary disconnects -> PRIMARY_SESSION_STATUS active: false -> returns to rear standby overlay
    emitWs('control', { type: 'PRIMARY_SESSION_STATUS', active: false });
    expect(statusOverlay.style.display).toBe('flex');
    expect(noticeTitle.textContent).toBe('後席モニター待ち受け中');
    expect(noticeActionBtn.style.display).toBe('none');
  });
});
