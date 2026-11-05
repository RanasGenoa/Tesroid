import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayer } from '../src/core/audio-player.js';
import { AvSyncController } from '../src/core/av-sync.js';
import { VideoStreamDecoder } from '../src/core/decoder.js';
import { FramePacer } from '../src/core/frame-pacer.js';
import { AUDIO_FLAGS, ClientProtocol, VIDEO_FLAGS } from '../src/transport/protocol.js';
import { renderStreamingView } from '../src/views/streaming.js';

describe('E2E Network Impairment & Catch-up Streaming Suite (Latency, Packet Drop, Low Bandwidth, UI/UX)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(1) Burst Delivery after 2s Network Freeze: plays 30 burst frames strictly at 1x PTS intervals (~33.3ms) without fast-forwarding', () => {
    const renderedFrames: { timestamp: number; renderTimeMs: number }[] = [];
    const mockRenderer: any = {
      render: vi.fn((frame: any) => {
        renderedFrames.push({
          timestamp: frame.timestamp,
          renderTimeMs: performance.now(),
        });
      }),
    };

    const pacer = new FramePacer(mockRenderer, 30);

    // 1. Normal first frame at t=0, PTS=1000ms
    const firstFrame = { timestamp: 1_000_000, close: vi.fn() } as any;
    pacer.queueFrame(firstFrame);
    expect(renderedFrames.length).toBe(1);
    expect(renderedFrames[0].timestamp).toBe(1_000_000);

    // 2. Simulate 2000ms mobile network stall (0 packets arrive for 2 seconds)
    vi.advanceTimersByTime(2000);

    // 3. Suddenly 30 frames (1.0 second of 30fps video) arrive in a single 1ms burst!
    for (let i = 1; i <= 30; i++) {
      const ptsUs = 1_000_000 + i * 33_333;
      pacer.queueFrame({ timestamp: ptsUs, close: vi.fn() } as any);
    }

    // Because of stall detection + 1x PTS pacing, the burst MUST NOT be fast-forwarded in a single millisecond!
    expect(renderedFrames.length).toBeLessThanOrEqual(2);
    expect(pacer.getQueueLength()).toBeGreaterThanOrEqual(29);
    // Auto cushion should have engaged automatically on stall detection
    expect(pacer.getAutoCushionMs()).toBeGreaterThanOrEqual(180);

    // 4. Advance time in 500ms increments and verify frames are rendered one-by-one at ~1x speed
    const countBeforeDrain = renderedFrames.length;
    vi.advanceTimersByTime(500); // 0.5s -> should render ~14-16 frames (not all 30!)
    const countMidDrain = renderedFrames.length;
    expect(countMidDrain - countBeforeDrain).toBeGreaterThanOrEqual(12);
    expect(countMidDrain - countBeforeDrain).toBeLessThanOrEqual(18);

    // Advance remaining 600ms to finish draining all 30 frames
    vi.advanceTimersByTime(600);
    expect(renderedFrames.length).toBe(31);
    expect(pacer.getQueueLength()).toBe(0);

    // Verify spacing between consecutive rendered burst frames is ~33.3ms (never 0ms fast-forward)
    for (let i = 2; i < renderedFrames.length; i++) {
      const deltaRenderMs = renderedFrames[i].renderTimeMs - renderedFrames[i - 1].renderTimeMs;
      expect(deltaRenderMs).toBeGreaterThanOrEqual(25);
      expect(deltaRenderMs).toBeLessThanOrEqual(45);
    }

    pacer.destroy();
  });

  it('(2) Packet Clogging Auto-Pause (isBuffering) & Smooth Cushion Recovery', () => {
    const renderedFrames: number[] = [];
    const bufferingStates: boolean[] = [];
    const mockRenderer: any = {
      render: vi.fn((frame: any) => {
        renderedFrames.push(frame.timestamp);
      }),
    };

    const pacer = new FramePacer(mockRenderer, 30);
    pacer.onBufferingChange = (isBuffering) => {
      bufferingStates.push(isBuffering);
    };

    // Initial frame at t=0
    pacer.queueFrame({ timestamp: 1_000_000, close: vi.fn() } as any);
    expect(renderedFrames.length).toBe(1);

    // Network clogs for 400ms, then only 1 frame (33.3ms of PTS) trickles in
    vi.advanceTimersByTime(400);
    pacer.queueFrame({ timestamp: 1_033_333, close: vi.fn() } as any);

    // Client detects packet clogging and pauses playback (isBuffering = true) waiting for cushion
    expect(pacer.getIsBuffering()).toBe(true);
    expect(bufferingStates).toContain(true);
    // The trickled frame is held in buffer rather than immediately rendered & starving again
    expect(renderedFrames.length).toBe(1);

    // Now more frames arrive to fill the cushion (~200ms = 6 frames)
    for (let i = 2; i <= 8; i++) {
      pacer.queueFrame({ timestamp: 1_000_000 + i * 33_333, close: vi.fn() } as any);
    }

    // Cushion is now satisfied -> buffering state automatically clears and smooth 1x playback resumes
    expect(pacer.getIsBuffering()).toBe(false);
    expect(bufferingStates[bufferingStates.length - 1]).toBe(false);

    vi.advanceTimersByTime(350);
    expect(renderedFrames.length).toBe(9);

    pacer.destroy();
  });

  it('(3) Pre-Decode Compressed Queue Backpressure & Packet Drop / Keyframe Recovery', async () => {
    const decodedTimestamps: number[] = [];
    let downstreamQueueSize = 0;

    let hasKeyframe = false;
    const mockDecoderInstance: any = {
      configure: vi.fn(() => {
        hasKeyframe = false;
      }),
      decode: vi.fn((chunk: any) => {
        if (chunk.type === 'key') hasKeyframe = true;
        if (hasKeyframe) {
          decodedTimestamps.push(chunk.timestamp);
          mockDecoderInstance._init?.output?.({ timestamp: chunk.timestamp, close: vi.fn() });
        }
      }),
      reset: vi.fn(() => {
        hasKeyframe = false;
      }),
      close: vi.fn(),
      decodeQueueSize: 0,
      state: 'configured',
    };

    const mockConstructor: any = function (this: any, init: any) {
      mockDecoderInstance._init = init;
      return mockDecoderInstance;
    };
    mockConstructor.isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
    (globalThis as any).VideoDecoder = mockConstructor;
    (globalThis as any).EncodedVideoChunk = function (this: any, init: any) {
      return init;
    };

    const decoder = new VideoStreamDecoder(() => {
      downstreamQueueSize++;
    });
    decoder.setDownstreamQueueLengthProvider(() => downstreamQueueSize);

    const spsPpsKey = new Uint8Array([
      0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 0, 1, 0x65,
      0x88, 0x84, 0x00,
    ]);
    const deltaPkt = new Uint8Array([0, 0, 0, 1, 0x41, 0x9a, 0x12, 0x34]);

    // Configure + first keyframe
    await decoder.handlePacket(VIDEO_FLAGS.CONFIG | VIDEO_FLAGS.KEYFRAME, 1_000_000n, spsPpsKey);

    // Send 40 delta packets in a burst (exceeding maxActiveFrames = 14)
    for (let i = 1; i <= 40; i++) {
      await decoder.handlePacket(0, BigInt(1_000_000 + i * 33_333), deltaPkt);
    }

    // Active VideoFrames are capped at 14 while remaining packets wait safely in compressed pendingPackets queue (0 dropped!)
    expect(downstreamQueueSize).toBe(14);
    expect(decoder.getPendingPacketsCount()).toBe(27);
    expect(decoder.getPendingBufferedMs()).toBeGreaterThan(800);

    // As FramePacer renders frames and drains downstreamQueueSize, pumpPendingPackets decodes the rest seamlessly
    while (decoder.getPendingPacketsCount() > 0) {
      downstreamQueueSize = Math.max(0, downstreamQueueSize - 5);
      await decoder.pumpPendingPackets();
    }

    expect(decodedTimestamps.length).toBe(41); // All 41 frames decoded without any P-frame drop!
    decoder.close();
  });

  it('(4) Auto-Hybrid Mode & AV Lockstep Synchronization: prevents audio from running ahead of video and does not false-stall on static screens', () => {
    const renderedFrames: number[] = [];
    const mockRenderer: any = {
      render: vi.fn((frame: any) => {
        renderedFrames.push(frame.timestamp);
      }),
    };

    const avSync = new AvSyncController();
    const pacer = new FramePacer(mockRenderer, 30, avSync);

    // 1. Static screen / UI browsing test:
    // Frame 1 at t=0 (PTS=1.0s), then 1.5s of static screen (no frames), then Frame 2 at t=1500ms (PTS=2.5s).
    // Because PTS also advanced by 1.5s, this is NOT a network stall and must render immediately with 0ms buffering!
    pacer.queueFrame({ timestamp: 1_000_000, close: vi.fn() } as any);
    expect(renderedFrames.length).toBe(1);

    vi.advanceTimersByTime(1500);
    pacer.queueFrame({ timestamp: 2_500_000, close: vi.fn() } as any);
    expect(pacer.getIsBuffering()).toBe(false);
    expect(pacer.getAutoCushionMs()).toBe(0);
    expect(pacer.getQueueLength()).toBe(0);
    expect(renderedFrames.length).toBe(2);

    // 2. AV Lockstep Sync during network stall:
    // Simulate a 500ms network stall where PTS only advanced by 33ms (genuine network packet clog)
    vi.advanceTimersByTime(500);
    pacer.queueFrame({ timestamp: 2_533_333, close: vi.fn() } as any);
    expect(pacer.getIsBuffering()).toBe(true);
    expect(avSync.isVideoBuffering()).toBe(true);

    // Manual or Auto-Hybrid jumpToLive flushes queue and clears buffering immediately
    pacer.jumpToLive();
    expect(pacer.getIsBuffering()).toBe(false);
    expect(avSync.isVideoBuffering()).toBe(false);
    expect(pacer.getQueueLength()).toBe(0);

    pacer.destroy();
  });

  it('(5) HUD Dedicated Bottom Dock, Direct YouTube Search URL, and Clean Stream Reset', async () => {
    const elementRegistry = new Map<string, any>();

    function createMockElement(id?: string, tagName = 'div'): any {
      const listeners: Record<string, Function[]> = {};
      const classSet = new Set<string>();
      const el: any = {
        id: id || '',
        tagName,
        className: '',
        clientWidth: id === 'stream-viewport' ? 1280 : 0,
        clientHeight: id === 'stream-viewport' ? 668 : 0,
        value: '',
        textContent: '',
        title: '',
        classList: {
          toggle: vi.fn((cls: string) => {
            if (classSet.has(cls)) {
              classSet.delete(cls);
              return false;
            }
            classSet.add(cls);
            return true;
          }),
          remove: vi.fn((...clsList: string[]) => clsList.forEach((c) => classSet.delete(c))),
          add: vi.fn((...clsList: string[]) => clsList.forEach((c) => classSet.add(c))),
          contains: (cls: string) => classSet.has(cls),
        },
        style: {},
        children: [] as any[],
        listeners,
        focus: vi.fn(),
        blur: vi.fn(),
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
          if (sel.startsWith('#')) return elementRegistry.get(sel.slice(1)) || null;
          return null;
        }),
        querySelectorAll: vi.fn(() => []),
        getContext: vi.fn(() => ({
          drawImage: vi.fn(),
          clearRect: vi.fn(),
          fillRect: vi.fn(),
        })),
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

      if (id) elementRegistry.set(id, el);
      return el;
    }

    const windowListeners: Record<string, Function[]> = {};
    (globalThis as any).document = {
      getElementById: vi.fn((id: string) => elementRegistry.get(id) || null),
      createElement: vi.fn((tag: string) => createMockElement(undefined, tag)),
      body: createMockElement('body', 'body'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (globalThis as any).window = {
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1,
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      addEventListener: vi.fn((evt: string, fn: Function) => {
        if (!windowListeners[evt]) windowListeners[evt] = [];
        windowListeners[evt].push(fn);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn((evt: any) => {
        const fns = windowListeners[evt.type] || [];
        fns.forEach((f) => f(evt));
      }),
      location: { reload: vi.fn() },
      localStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
      sessionStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    };
    (globalThis as any).localStorage = (globalThis as any).window.localStorage;
    (globalThis as any).sessionStorage = (globalThis as any).window.sessionStorage;
    (globalThis as any).requestAnimationFrame = vi.fn((cb: any) => setTimeout(cb, 0));
    (globalThis as any).cancelAnimationFrame = vi.fn();
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ displayScale: 120, stream: { maxFps: 30, bitrate: 1000000 } }),
    });

    const wsHandlers: Record<string, Function> = {};
    const mockWsClient: any = {
      send: vi.fn(),
      on: vi.fn((evt: string, fn: Function) => {
        wsHandlers[evt] = fn;
      }),
      off: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const mockAudioPlayer: any = {
      resetJitterBuffer: vi.fn(),
      jumpToLive: vi.fn(),
      getBufferedAudioMs: vi.fn(() => 0),
      setAdditionalDelay: vi.fn(),
      unlock: vi.fn().mockResolvedValue(undefined),
      toggleMute: vi.fn(() => false),
      getStats: vi.fn(() => ({
        isUnlocked: true,
        state: 'running',
        packetsReceived: 10,
        isMuted: false,
      })),
    };
    const mockAvSync = new AvSyncController();
    const container = createMockElement('root');

    const cleanup = renderStreamingView(
      container,
      mockWsClient,
      mockAudioPlayer,
      mockAvSync,
      vi.fn(),
      'token-123',
    );

    // Verify dedicated stream-viewport and bottom stream-hud exist
    expect(elementRegistry.get('stream-viewport')).toBeDefined();
    expect(elementRegistry.get('stream-hud')).toBeDefined();
    expect(elementRegistry.get('hud-live-btn')).toBeDefined();

    // Verify YouTube search form navigates directly to YouTube search results URL
    const searchForm = elementRegistry.get('hud-search-form');
    const searchInput = elementRegistry.get('hud-search-input');
    searchInput.value = 'テスラ モデル3 レビュー';
    searchForm.dispatchEvent({ type: 'submit', preventDefault: vi.fn() });

    const expectedSearchCmd = ClientProtocol.packCommand({
      type: 'NAVIGATE',
      url: `https://www.youtube.com/results?search_query=${encodeURIComponent('テスラ モデル3 レビュー')}`,
    });
    expect(mockWsClient.send).toHaveBeenCalledWith(expectedSearchCmd);

    // Verify PONG with catchupQueueMs updates HUD live status badge to catch-up indicator
    wsHandlers['control']?.({
      type: 'PONG',
      clientTime: performance.now() - 45,
      latestPts: 5_000_000,
      serverMode: 'CATCHUP',
      catchupQueueMs: 2400,
    });

    const hudLiveBtn = elementRegistry.get('hud-live-btn');
    const hudLiveText = elementRegistry.get('hud-live-text');
    expect(hudLiveBtn.classList.contains('is-catchup')).toBe(true);
    expect(hudLiveText.textContent).toContain('S:2.4s');

    // Clicking HUD LIVE button sends JUMP_TO_LIVE command and returns badge to LIVE
    hudLiveBtn.click();
    expect(mockWsClient.send).toHaveBeenCalledWith(
      ClientProtocol.packCommand({ type: 'JUMP_TO_LIVE' }),
    );
    expect(hudLiveText.textContent).toBe('LIVE');

    // Receiving STREAM_RESET resets audio/video buffers cleanly
    mockAudioPlayer.resetJitterBuffer.mockClear();
    wsHandlers['control']?.({ type: 'STREAM_RESET' });
    expect(mockAudioPlayer.resetJitterBuffer).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('(6) 20s Outage Recovery with Controlled Pacing: verifies decoder & pacer never drop frames when server paces burst within targetBufferMs (Issue 26)', async () => {
    let mockInit: any;
    let hasKeyframe = false;
    const mockDecoderInstance: any = {
      configure: vi.fn(() => {
        hasKeyframe = false;
      }),
      decode: vi.fn((chunk: any) => {
        if (chunk.type === 'key') hasKeyframe = true;
        if (hasKeyframe) {
          mockInit?.output?.({
            timestamp: chunk.timestamp,
            close: vi.fn(),
          });
        }
      }),
      reset: vi.fn(() => {
        hasKeyframe = false;
      }),
      close: vi.fn(),
      decodeQueueSize: 0,
      state: 'configured',
    };

    const mockConstructor: any = function (this: any, init: any) {
      mockInit = init;
      return mockDecoderInstance;
    };
    mockConstructor.isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
    (globalThis as any).VideoDecoder = mockConstructor;
    (globalThis as any).EncodedVideoChunk = function (this: any, init: any) {
      return init;
    };

    const renderedFrames: number[] = [];
    const mockRenderer: any = {
      render: vi.fn((frame: any) => {
        renderedFrames.push(frame.timestamp);
      }),
      getFps: vi.fn(() => 30),
      getLastRenderTime: vi.fn(() => performance.now()),
    };

    let droppedCount = 0;
    const pacer = new FramePacer(mockRenderer, 30);
    pacer.onFrameDropped = () => {
      droppedCount++;
    };

    const decoder = new VideoStreamDecoder(
      {
        queueFrame: (f: VideoFrame) => pacer.queueFrame(f),
        getQueueLength: () => pacer.getQueueLength(),
      },
      undefined,
    );
    decoder.setBufferDepth({ targetDurationMs: 10000 }); // 10秒 target (maxPendingDurationMs = 16000ms)

    pacer.onFrameProcessed = () => {
      decoder.pumpPendingPackets();
    };

    // Config + Keyframe setup in a single initial packet
    const spsPpsKey = new Uint8Array([
      0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 0, 1, 0x65,
      0x88, 0x84, 0x00,
    ]);
    await decoder.handlePacket(VIDEO_FLAGS.CONFIG | VIDEO_FLAGS.KEYFRAME, 10_000_000n, spsPpsKey);

    // サーバーからスライディングウィンドウによって送出された 10 秒分のフレーム (300 フレーム) を順次受信
    const deltaPkt = new Uint8Array([0, 0, 0, 1, 0x41, 0x9a, 0x12, 0x34]);
    for (let i = 1; i < 300; i++) {
      const pts = 10_000_000n + BigInt(i * 33333);
      await decoder.handlePacket(0, pts, deltaPkt);
    }

    // クライアント側でパケットがトリム（GOPドロップ）されず、全パケットが pending またはデコードキューに保持されていること
    expect(decoder.getPendingPacketsCount()).toBeGreaterThan(250);
    expect(droppedCount).toBe(0);

    // 2秒分（約60フレーム）の再生を進める (タイマーステップとデコードポンプを連動)
    for (let step = 0; step < 60; step++) {
      vi.advanceTimersByTime(34);
      await decoder.pumpPendingPackets();
    }

    // 再生が進むにつれてフレームが描画され、一切フレームがドロップされていないこと
    expect(renderedFrames.length).toBeGreaterThanOrEqual(55);
    expect(droppedCount).toBe(0);

    pacer.destroy();
    decoder.close();
  });
});
