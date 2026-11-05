import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamicLatencyController } from '../src/core/latency.js';
import { MetricsCollector } from '../src/core/metrics.js';
import { EdgeGuard } from '../src/input/edge-guard.js';
import { TouchMapper } from '../src/input/touch-mapper.js';
import { TOUCH_EVENT_ACTION, WSS_CHANNEL } from '../src/transport/protocol.js';
import { WsClient } from '../src/transport/ws-client.js';

function unpackTouchPacket(pkt: Uint8Array) {
  const view = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  return {
    channel: pkt[0],
    action: view.getUint8(2),
    pointerId: Number(view.getBigInt64(3, false)),
    x: view.getInt32(11, false),
    y: view.getInt32(15, false),
    screenWidth: view.getUint16(19, false),
    screenHeight: view.getUint16(21, false),
    pressure: view.getUint16(23, false),
  };
}

describe('EdgeGuard, TouchMapper, WsClient, DynamicLatencyController & MetricsCollector', () => {
  const origWindow = (globalThis as any).window;
  const origWebSocket = (globalThis as any).WebSocket;

  afterEach(() => {
    (globalThis as any).window = origWindow;
    (globalThis as any).WebSocket = origWebSocket;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('EdgeGuard protects top 20px for Tesla OS browser swipe-down gesture', () => {
    expect(EdgeGuard.isTopEdgeGesture(0)).toBe(true);
    expect(EdgeGuard.isTopEdgeGesture(20)).toBe(true);
    expect(EdgeGuard.isTopEdgeGesture(21)).toBe(false);
    expect(EdgeGuard.isTopEdgeGesture(360)).toBe(false);
  });

  it('TouchMapper handles pillarbox/letterbox contain scaling, edge guard, slop, chatter debounce, multi-touch & window blur', () => {
    let fakeNow = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => fakeNow);

    const canvasListeners = new Map<string, Function>();
    const windowListeners = new Map<string, Function>();
    const objectFitMode = 'contain';
    // Canvas element occupies 1600x720 on screen while video stream is 1280x720 (pillarboxed: 160px black bars left & right!)
    const rect = { left: 0, top: 0, width: 1600, height: 720 };

    const mockCanvas: any = {
      width: 1280,
      height: 720,
      addEventListener: vi.fn((ev: string, fn: Function) => canvasListeners.set(ev, fn)),
      removeEventListener: vi.fn((ev: string) => canvasListeners.delete(ev)),
      getBoundingClientRect: () => rect,
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    };

    (globalThis as any).window = {
      addEventListener: vi.fn((ev: string, fn: Function) => windowListeners.set(ev, fn)),
      removeEventListener: vi.fn((ev: string) => windowListeners.delete(ev)),
      getComputedStyle: () => ({ objectFit: objectFitMode }),
      setTimeout: globalThis.setTimeout.bind(globalThis),
    };

    const sentPackets: Uint8Array[] = [];
    const mockWs: any = {
      send: vi.fn((data: Uint8Array) => sentPackets.push(data)),
    };
    const latency = new DynamicLatencyController();
    const mapper = new TouchMapper(mockCanvas, mockWs, latency);

    const fire = (type: string, props: any) => {
      canvasListeners.get(type)?.({
        pointerType: 'touch',
        button: 0,
        buttons: 1,
        preventDefault: vi.fn(),
        ...props,
      });
    };

    // 1. Right-click mouse (button=2) & unpaired hover MOVE ignored
    fire('pointerdown', {
      pointerType: 'mouse',
      button: 2,
      pointerId: 1,
      clientX: 500,
      clientY: 300,
    });
    fire('pointermove', { pointerId: 99, clientX: 500, clientY: 300 });
    expect(sentPackets).toHaveLength(0);

    // 2. Top-edge gesture (clientY = 12 <= 20) suppressed by EdgeGuard
    fire('pointerdown', { pointerId: 1, clientX: 800, clientY: 12 });
    expect(sentPackets).toHaveLength(0);

    // 3. Pillarboxed center tap: clientX=800 on 1600x720 element -> maps to exact center x=640 on 1280x720 stream!
    fire('pointerdown', { pointerId: 1, clientX: 800, clientY: 360 });
    expect(sentPackets).toHaveLength(1);
    expect(unpackTouchPacket(sentPackets[0])).toMatchObject({
      channel: WSS_CHANNEL.TOUCH,
      action: TOUCH_EVENT_ACTION.DOWN,
      pointerId: 1,
      x: 640,
      y: 360,
    });
    expect(latency.getMode()).toBe('ACTIVE_INTERACTION');

    // 4. Touch slop (< 6px) suppressed; >= 6px forwarded; multi-touch second finger uses POINTER_DOWN (5) & POINTER_UP (6)
    sentPackets.length = 0;
    fire('pointermove', { pointerId: 1, clientX: 803, clientY: 362 }); // < 6px
    expect(sentPackets).toHaveLength(0);

    fire('pointermove', { pointerId: 1, clientX: 820, clientY: 360 }); // 20px -> sent!
    expect(unpackTouchPacket(sentPackets[0]).action).toBe(TOUCH_EVENT_ACTION.MOVE);

    sentPackets.length = 0;
    fire('pointerdown', { pointerId: 2, clientX: 400, clientY: 360 });
    expect(unpackTouchPacket(sentPackets[0]).action).toBe(TOUCH_EVENT_ACTION.POINTER_DOWN);

    sentPackets.length = 0;
    fire('pointerup', { pointerId: 2, clientX: 400, clientY: 360 });
    expect(unpackTouchPacket(sentPackets[0]).action).toBe(TOUCH_EVENT_ACTION.POINTER_UP);

    // 5. Window blur cancels remaining active pointer (pointerId=1) to prevent stuck touch!
    sentPackets.length = 0;
    windowListeners.get('blur')?.();
    expect(sentPackets).toHaveLength(1);
    expect(unpackTouchPacket(sentPackets[0])).toMatchObject({
      action: TOUCH_EVENT_ACTION.CANCEL,
      pointerId: 1,
    });

    // 6. Chatter debounce: rapid DOWN within <60ms & <20px after UP is suppressed
    fakeNow = 2000;
    fire('pointerdown', { pointerId: 5, clientX: 800, clientY: 360 });
    fire('pointerup', { pointerId: 5, clientX: 800, clientY: 360 });
    sentPackets.length = 0;
    fakeNow = 2025; // +25ms < 60ms
    fire('pointerdown', { pointerId: 6, clientX: 805, clientY: 362 });
    expect(sentPackets).toHaveLength(0);

    mapper.destroy();
    expect(canvasListeners.size).toBe(0);
  });

  it('WsClient derives wss:// URL, ignores truncated/corrupted frames safely, and backs off exponentially until close()', () => {
    vi.useFakeTimers();

    const instances: any[] = [];
    class FakeWebSocket {
      public static OPEN = 1;
      public readyState = 1;
      public binaryType = 'blob';
      public url: string;
      public onopen: any = null;
      public onclose: any = null;
      public onerror: any = null;
      public onmessage: any = null;
      public send = vi.fn();
      public close = vi.fn(() => {
        this.readyState = 3;
        this.onclose?.({ code: 1000, reason: 'closed' });
      });
      constructor(url: string) {
        this.url = url;
        instances.push(this);
      }
    }

    (globalThis as any).WebSocket = FakeWebSocket;
    (globalThis as any).window = {
      location: { protocol: 'https:', host: 'tesroid.example.com' },
    };

    const client = new WsClient();
    client.connect();
    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe('wss://tesroid.example.com/ws');

    // Truncated VIDEO (<10B), empty buffer, and malformed CONTROL JSON must not throw
    const videos: any[] = [];
    const controls: any[] = [];
    client.on('video', (v) => videos.push(v));
    client.on('control', (c) => controls.push(c));

    instances[0].onmessage({ data: new Uint8Array([]).buffer });
    instances[0].onmessage({ data: new Uint8Array([WSS_CHANNEL.VIDEO, 0x01, 0x00]).buffer }); // <10B
    const badJson = new Uint8Array([WSS_CHANNEL.CONTROL_RESPONSE, 0x7b, 0x21]); // "{!"
    instances[0].onmessage({ data: badJson.buffer });
    expect(videos).toHaveLength(0);
    expect(controls).toHaveLength(0);

    // Unexpected disconnect triggers 1000ms -> 2000ms exponential backoff reconnect
    instances[0].onclose({ code: 1006, reason: 'abnormal' });
    vi.advanceTimersByTime(999);
    expect(instances).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(instances).toHaveLength(2);

    instances[1].onclose({ code: 1006, reason: 'abnormal' });
    vi.advanceTimersByTime(2000);
    expect(instances).toHaveLength(3);

    // Explicit close() suppresses further automatic reconnects
    client.close();
    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(3);
  });

  it('MetricsCollector aggregates 10-second windows accurately and resets windowed counters', () => {
    vi.useFakeTimers();
    let fakeNow = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => fakeNow);

    (globalThis as any).window = {
      innerWidth: 1920,
      innerHeight: 1080,
      devicePixelRatio: 2,
      setInterval: globalThis.setInterval.bind(globalThis),
    };

    const collector = new MetricsCollector();
    const reports: any[] = [];
    collector.onReport = (m) => reports.push(m);

    for (let i = 0; i < 600; i++) {
      collector.recordFrameRendered(i % 2 === 0 ? 58 : 62);
      collector.recordVideoPacket(2500);
    }
    collector.recordAudioPacket();
    collector.recordFrameDropped();
    collector.recordDecoderError();
    collector.updateRtt(32);
    collector.updateDecodeQueueSize(2);
    collector.updateAvDrift(-8.44);

    fakeNow = 11_000; // +10.0s elapsed
    vi.advanceTimersByTime(10_000);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      renderFps: 60,
      minFps: 58,
      maxFps: 62,
      totalFramesRendered: 600,
      droppedFrames: 1,
      decoderErrors: 1,
      rttMs: 32,
      decodeQueueSize: 2,
      videoPacketsReceived: 600,
      audioPacketsReceived: 1,
      bitrateKbps: 1200, // (600 * 2500 * 8) / 10 / 1000
      avDriftMs: -8.4,
      displayWidth: 1920,
      displayHeight: 1080,
      devicePixelRatio: 2,
    });

    // Next 10s idle window resets windowed counters to 0 while keeping cumulative totals
    fakeNow = 21_000;
    vi.advanceTimersByTime(10_000);
    expect(reports).toHaveLength(2);
    expect(reports[1].renderFps).toBe(0);
    expect(reports[1].videoPacketsReceived).toBe(0);
    expect(reports[1].totalFramesRendered).toBe(600);

    collector.destroy();
  });
});
