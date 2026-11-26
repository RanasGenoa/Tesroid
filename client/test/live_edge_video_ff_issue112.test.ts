import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderStreamingView } from '../src/views/streaming.js';

// Issue #112 F-4b: サーバー起因の LIVE 復帰 (LIVE_JUMPED / CATCHUP→LIVE) で、音声 straggler
// バリアと同一境界の映像側早送り (decoder.flushPendingForLiveJump + framePacer.jumpToLive(true))
// が対称に発火することを検証する。実測ではバリアが音声側にだけ適用され、古い映像キュー
// (decodeQueueSize 86〜98 / drift −2.0〜−2.4s) が残り「音声先行」が恒常化していた。

const captured = vi.hoisted(() => ({
  pacerInstances: [] as any[],
  decoderInstances: [] as any[],
  rendererInstances: [] as any[],
  metricsInstances: [] as any[],
}));

vi.mock('../src/core/canvas-renderer.js', () => {
  return {
    CanvasRenderer: function (this: any) {
      captured.rendererInstances.push(this);
      this.resetFirstFrame = vi.fn();
      this.getFps = vi.fn(() => 30);
      this.getLastRenderTime = vi.fn(() => performance.now());
      this.onFrameDrawn = null;
    },
  };
});

vi.mock('../src/core/frame-pacer.js', () => {
  return {
    FramePacer: function (this: any) {
      captured.pacerInstances.push(this);
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
      this.onFrameDropped = null;
    },
  };
});

vi.mock('../src/core/decoder.js', () => {
  return {
    VideoStreamDecoder: function (this: any) {
      captured.decoderInstances.push(this);
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
      captured.metricsInstances.push(this);
      this.onReport = null;
      this.updateRtt = vi.fn();
      this.recordFrameRendered = vi.fn();
      this.recordFrameDropped = vi.fn();
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

describe('Issue #112 F-4b: サーバー起因 LIVE 復帰時の映像側対称早送り', () => {
  const cleanups: Array<() => void> = [];
  let elementRegistry: Map<string, any>;
  let mockContainer: any;
  let mockWsClient: any;
  let mockAudioPlayer: any;
  let mockAvSync: any;
  let onOpenSettings: any;
  let eventListeners: Record<string, Function[]>;
  const testToken = 'tesroid-test-token';

  function createMockElement(id?: string, tagName = 'div'): any {
    const listeners: Record<string, Function[]> = {};
    const el: any = {
      id: id || '',
      tagName,
      className: '',
      classList: { toggle: vi.fn(), remove: vi.fn(), add: vi.fn() },
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
    captured.pacerInstances.length = 0;
    captured.decoderInstances.length = 0;
    captured.rendererInstances.length = 0;
    captured.metricsInstances.length = 0;
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
    (globalThis as any).fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
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
      resetDecoder: vi.fn(),
      resetJitterBuffer: vi.fn(),
      jumpToLive: vi.fn(),
      unlock: vi.fn().mockResolvedValue(undefined),
      toggleMute: vi.fn(() => false),
      getStats: vi.fn(() => ({ packetsReceived: 0, state: 'running', isMuted: false })),
      handleAudioPacket: vi.fn(),
      setLiveEdgeBarrier: vi.fn(),
      clearLiveEdgeBarrier: vi.fn(),
      getLastKnownPtsUs: vi.fn(() => 0),
      getBufferedAudioMs: vi.fn(() => 0),
    };
    mockAvSync = {
      reset: vi.fn(),
      updateVideoPts: vi.fn(),
      getDriftMs: vi.fn(() => 0),
    };
    onOpenSettings = vi.fn();
  });

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      fn();
    }
  });

  function startStreaming() {
    cleanups.push(
      renderStreamingView(
        mockContainer,
        mockWsClient,
        mockAudioPlayer,
        mockAvSync,
        onOpenSettings,
        testToken,
      ),
    );
    const controlHandler = eventListeners['control']?.[0];
    expect(controlHandler).toBeDefined();
    return controlHandler as (msg: any) => void;
  }

  it('LIVE_JUMPED で音声バリアと同一境界の映像早送り (preserveCushion=true) が発火する', () => {
    const control = startStreaming();
    const pacer = captured.pacerInstances[0];
    const decoder = captured.decoderInstances[0];
    expect(pacer).toBeDefined();
    expect(decoder).toBeDefined();

    control({ type: 'LIVE_JUMPED', timestamp: Date.now(), dropAudioBeforePts: 987654321 });

    // 音声側: 既存の権威バリア (Issue #103) は維持
    expect(mockAudioPlayer.setLiveEdgeBarrier).toHaveBeenCalledWith(987654321);
    // 映像側: F-4b の対称早送り。サーバー起因なので自適応クッションは保持する
    expect(decoder.flushPendingForLiveJump).toHaveBeenCalledTimes(1);
    expect(pacer.jumpToLive).toHaveBeenCalledTimes(1);
    expect(pacer.jumpToLive).toHaveBeenCalledWith(true);
  });

  it('PONG の CATCHUP→LIVE 遷移エッジで一度だけ映像早送りが発火し、LIVE 継続では再発火しない', () => {
    const control = startStreaming();
    const pacer = captured.pacerInstances[0];
    const decoder = captured.decoderInstances[0];

    const pong = (mode: 'CATCHUP' | 'LIVE') => ({
      type: 'PONG',
      id: 1,
      clientTime: performance.now() - 40,
      serverTime: performance.now(),
      serverMode: mode,
      catchupQueueMs: mode === 'CATCHUP' ? 5000 : 0,
      serverBufferMs: 0,
    });

    control(pong('CATCHUP'));
    expect(pacer.jumpToLive).not.toHaveBeenCalled();

    control(pong('LIVE'));
    expect(decoder.flushPendingForLiveJump).toHaveBeenCalledTimes(1);
    expect(pacer.jumpToLive).toHaveBeenCalledTimes(1);
    expect(pacer.jumpToLive).toHaveBeenCalledWith(true);

    // 同一 LIVE のまま PONG が届き続けても再発火しない (再生中キューの実時間運用は壊さない)
    control(pong('LIVE'));
    control(pong('LIVE'));
    expect(pacer.jumpToLive).toHaveBeenCalledTimes(1);
    expect(decoder.flushPendingForLiveJump).toHaveBeenCalledTimes(1);
  });

  it('dropAudioBeforePts 不在の LIVE_JUMPED でも音声再同期と映像早送りが対に発火する (F-4 フォールバック経路)', () => {
    const control = startStreaming();
    const pacer = captured.pacerInstances[0];
    const decoder = captured.decoderInstances[0];

    control({ type: 'LIVE_JUMPED', timestamp: Date.now() });

    expect(mockAudioPlayer.setLiveEdgeBarrier).not.toHaveBeenCalled();
    expect(mockAudioPlayer.jumpToLive).toHaveBeenCalledTimes(1);
    expect(decoder.flushPendingForLiveJump).toHaveBeenCalledTimes(1);
    expect(pacer.jumpToLive).toHaveBeenCalledWith(true);
  });

  it('STREAM_RESET で audioPlayer.resetDecoder() が呼ばれ、実描画 FPS / FramePacer 破棄が MetricsCollector へ接続される', () => {
    const control = startStreaming();
    const pacer = captured.pacerInstances[0];
    const renderer = captured.rendererInstances[0];
    const metrics = captured.metricsInstances[0];

    control({ type: 'STREAM_RESET', timestamp: Date.now() });
    expect(mockAudioPlayer.resetDecoder).toHaveBeenCalledTimes(1);

    // 描画 FPS は VideoDecoder 出力ではなく CanvasRenderer 実描画で計測する
    expect(metrics.recordFrameRendered).not.toHaveBeenCalled();
    renderer.onFrameDrawn?.(29);
    expect(metrics.recordFrameRendered).toHaveBeenCalledWith(29);

    // FramePacer のドロップ通知は MetricsCollector へ伝搬する
    pacer.onFrameDropped?.();
    expect(metrics.recordFrameDropped).toHaveBeenCalledTimes(1);
  });
});
