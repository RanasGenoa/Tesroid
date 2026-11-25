import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientProtocol } from '../src/transport/protocol.js';
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

const captured = vi.hoisted(() => ({ metricsInstances: [] as any[] }));

vi.mock('../src/core/metrics.js', () => {
  return {
    MetricsCollector: function (this: any) {
      captured.metricsInstances.push(this); // Issue #105: インスタンス計装用に捕捉
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

describe('Issue 24 & Issue 29 HUD Improvements Tests', () => {
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
      // Issues #103/#106: straggler バリアと音声滞留報告の検証用
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

  it('Issue 29 & Issue 33: 設定メニュー（settings-modal）内に再エンコードボタンおよび電源管理ボタンが存在しないこと（HUD停止メニューへ集約）', () => {
    openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());

    // 設定モーダル内の #encoder-restart-btn は削除されていること
    const encoderRestartBtn = elementRegistry.get('encoder-restart-btn');
    expect(encoderRestartBtn).toBeUndefined();

    // Issue 33: 電源管理ボタンはHUD停止メニューに集約され、設定モーダルからは削除されていること
    expect(elementRegistry.get('power-sleep-btn')).toBeUndefined();
    expect(elementRegistry.get('power-resume-btn')).toBeUndefined();
    expect(elementRegistry.get('browser-restart-btn')).toBeUndefined();
  });

  it('Issue 29: HUDバッファ状態（hud-live-btn）連打時に再エンコードAPIが重複実行されないこと（連打ガード）', async () => {
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

    const hudLiveBtn = elementRegistry.get('hud-live-btn');
    expect(hudLiveBtn).toBeDefined();

    // 連続で3回タップ
    hudLiveBtn.click();
    hudLiveBtn.click();
    hudLiveBtn.click();

    await new Promise((resolve) => setTimeout(resolve, 10));

    // 連打ガードにより、JUMP_TO_LIVE 送信および /api/encoder/restart は 1 回だけ呼ばれること
    const jumpCalls = mockWsClient.send.mock.calls.filter((call: any[]) => {
      try {
        const payload = JSON.parse(new TextDecoder().decode(call[0].subarray(1)));
        return payload.type === 'JUMP_TO_LIVE';
      } catch {
        return false;
      }
    });
    expect(jumpCalls.length).toBe(1);

    const restartCalls = (globalThis.fetch as any).mock.calls.filter(
      (call: any[]) => call[0] === '/api/encoder/restart',
    );
    expect(restartCalls.length).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/encoder/restart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}` },
    });
  });

  it('Issue 24: CATCHUPモードやキュー遅延発生時にrawRttが跳ね上がっても、HUDの瞬間RTTが肥大化しないこと', () => {
    vi.useFakeTimers();
    try {
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

      const connText = elementRegistry.get('hud-conn-text');
      const connDot = elementRegistry.get('hud-conn-dot');
      expect(connText).toBeDefined();
      expect(connDot).toBeDefined();

      // 1. LIVE通常通信時の安定したPing/Pong (RTT 35ms)
      const now1 = performance.now();
      controlHandler({
        type: 'PONG',
        id: 1,
        clientTime: now1 - 35,
        serverTime: now1,
        serverMode: 'LIVE',
        catchupQueueMs: 0,
        serverBufferMs: 0,
      });

      expect(connText.textContent).toBe('35ms');
      expect(connDot.className).toBe('status-dot status-online');

      // 2. CATCHUPモードに遷移し、キュー遅延によってPONGが2500ms後に届いた場合
      const now2 = performance.now();
      controlHandler({
        type: 'PONG',
        id: 2,
        clientTime: now2 - 2500,
        serverTime: now2,
        serverMode: 'CATCHUP',
        catchupQueueMs: 2500,
        serverBufferMs: 5000,
      });

      // 送信キュー滞留による2500msに引きずられず、直近の安定した瞬間RTT (35ms) を維持していること
      expect(connText.textContent).toBe('35ms');
      expect(connDot.className).toBe('status-dot status-online');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Issue 24: パケット未着時間が1.2秒を超えた場合、通信状態インジケーターが瞬断警告（赤）へ連動すること', () => {
    vi.useFakeTimers();
    try {
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

      const connText = elementRegistry.get('hud-conn-text');
      const connDot = elementRegistry.get('hud-conn-dot');

      // 1. パケットが届いて接続良好
      const now = performance.now();
      controlHandler({
        type: 'PONG',
        id: 1,
        clientTime: now - 30,
        serverTime: now,
        serverMode: 'LIVE',
        catchupQueueMs: 0,
        serverBufferMs: 0,
      });
      expect(connDot.className).toBe('status-dot status-online');

      // 2. パケット受信が途絶えたまま 1500ms 時間を経過させる（模擬瞬断）
      vi.advanceTimersByTime(1500);

      // 1.2秒を超えてパケットが途絶えているため、瞬断判定となること
      expect(connDot.className).toBe('status-dot status-offline');
      expect(connText.textContent).toBe('瞬断中');

      // 3. 再びパケットが到着したらオンラインに復帰すること
      const now2 = performance.now();
      controlHandler({
        type: 'PONG',
        id: 2,
        clientTime: now2 - 25,
        serverTime: now2,
        serverMode: 'LIVE',
        catchupQueueMs: 0,
        serverBufferMs: 0,
      });
      expect(connDot.className).toBe('status-dot status-online');
      // EWMA平滑化 (30 * 0.7 + 25 * 0.3 = 28.5 ≈ 29ms) により急峻なジッタが吸収されていること
      expect(connText.textContent).toBe('29ms');
    } finally {
      vi.useRealTimers();
    }
  });

  // ---- 2026-11-25 モバイル回線インシデント対応 (Issues #103/#105) ----

  it('Issue #105: 映像到着が続いても PONG が届かなければ鮮切れの RTT を凍結表示せず「接続中」へ戻す', () => {
    vi.useFakeTimers();
    try {
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
      const connText = elementRegistry.get('hud-conn-text');

      const now1 = performance.now();
      controlHandler({
        type: 'PONG',
        id: 1,
        clientTime: now1 - 40,
        serverTime: now1,
        serverMode: 'LIVE',
        catchupQueueMs: 0,
        serverBufferMs: 0,
      });
      expect(connText.textContent).toBe('40ms');

      // CATCHUP バーストで映像・音声は届き続けるが PONG のみ滞留して 6 秒間不着の状況を再現
      for (let i = 0; i < 12; i++) {
        vi.advanceTimersByTime(500);
        controlHandler({ type: 'LIVE_JUMPED', timestamp: Date.now() }); // 映像到着の代わり（RTT は更新しない）
      }

      // 鮮度閾値 (5s) 超過で凍結値 40ms は破棄され、実測なしは「接続中」表示
      expect(connText.textContent).toBe('接続中');

      // メトリクスへも凍結値を再報告しない（未計測 = updateRtt(0)）
      const metrics = captured.metricsInstances[captured.metricsInstances.length - 1];
      expect(metrics).toBeDefined();
      expect(metrics.updateRtt).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Issue #103: LIVE_JUMPED の dropAudioBeforePts を音声 straggler バリアとして適用する', () => {
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

    controlHandler({ type: 'LIVE_JUMPED', timestamp: Date.now(), dropAudioBeforePts: 12345678 });
    expect(mockAudioPlayer.setLiveEdgeBarrier).toHaveBeenCalledWith(12345678);
  });

  it('Issue #103: LIVE ジャンプ時、PONG のサーバー最新 PTS から暫定 straggler バリアを設定する', () => {
    vi.useFakeTimers();
    try {
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

      const now = performance.now();
      controlHandler({
        type: 'PONG',
        id: 1,
        clientTime: now - 30,
        serverTime: now,
        latestPts: 5_000_000,
        serverMode: 'LIVE',
        catchupQueueMs: 0,
        serverBufferMs: 0,
      });

      controlHandler({ type: 'PRIMARY_JUMP_TO_LIVE' });

      expect(mockAudioPlayer.setLiveEdgeBarrier).toHaveBeenCalled();
      const barrier = mockAudioPlayer.setLiveEdgeBarrier.mock.calls[0][0];
      expect(barrier).toBeGreaterThanOrEqual(5_000_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
