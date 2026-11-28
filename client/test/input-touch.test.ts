import {
  decodeResizeFrame,
  encodeResizeFrame,
  PROTOCOL_TIMING,
  type ResizeFrame,
  TOUCH_ACTION,
  type TouchFrame,
} from "@tesroid/shared";
import { describe, expect, it } from "vitest";
import {
  buildResizeFrame,
  mapCanvasPointToStream,
  TouchInputEngine,
  TouchInputProcessor,
  ViewportResizeReporter,
} from "../src/input/index.js";
import type { ClientClock, ClientTimerHandle } from "../src/transport/ports.js";

class FakeClock implements ClientClock {
  private currentMs: number;
  private nextId = 1;
  private readonly timers = new Set<{
    readonly id: number;
    readonly fireAtMs: number;
    readonly callback: () => void;
    cancelled: boolean;
  }>();

  constructor(initialMs = 10_000) {
    this.currentMs = initialMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  setTimeout(callback: () => void, delayMs: number): ClientTimerHandle {
    const entry = {
      id: this.nextId++,
      fireAtMs: this.currentMs + Math.max(0, delayMs),
      callback,
      cancelled: false,
    };
    this.timers.add(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
        this.timers.delete(entry);
      },
    };
  }

  clearTimeout(handle: ClientTimerHandle): void {
    handle.cancel();
  }

  advanceBy(ms: number): void {
    const targetMs = this.currentMs + ms;
    while (true) {
      let nextTimer: {
        readonly id: number;
        readonly fireAtMs: number;
        readonly callback: () => void;
        cancelled: boolean;
      } | null = null;
      for (const timer of this.timers) {
        if (!timer.cancelled && timer.fireAtMs <= targetMs) {
          if (
            nextTimer === null ||
            timer.fireAtMs < nextTimer.fireAtMs ||
            (timer.fireAtMs === nextTimer.fireAtMs && timer.id < nextTimer.id)
          ) {
            nextTimer = timer;
          }
        }
      }
      if (nextTimer === null) {
        break;
      }
      this.timers.delete(nextTimer);
      this.currentMs = Math.max(this.currentMs, nextTimer.fireAtMs);
      nextTimer.callback();
    }
    this.currentMs = targetMs;
  }
}

class SimpleEventTarget implements EventTarget {
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, callback: EventListenerOrEventListenerObject | null): void {
    if (callback === null) {
      return;
    }
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(callback);
  }

  removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null): void {
    if (callback === null) {
      return;
    }
    this.listeners.get(type)?.delete(callback);
  }

  dispatchEvent(event: Event): boolean {
    const set = this.listeners.get(event.type);
    if (set === undefined) {
      return true;
    }
    for (const listener of [...set]) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
    return true;
  }
}

describe("client/input (Spec 03, 06)", () => {
  it("Spec 06 AC-02: ignores touch starts within top 20 px edge guard to preserve in-car OS swipe-down gesture", () => {
    const rect = { left: 0, top: 0, width: 800, height: 600 };

    // Top 20 px (inclusive) is blocked on touch start, y = 21 is accepted.
    expect(mapCanvasPointToStream(400, 0, rect, 800, 600, true)).toBeNull();
    expect(mapCanvasPointToStream(400, 20, rect, 800, 600, true)).toBeNull();
    expect(mapCanvasPointToStream(400, 21, rect, 800, 600, true)).toEqual({
      x: 400,
      y: 21,
      inside: true,
    });

    // Pure engine drops top-edge DOWN but allows active drag that moves above y = 20.
    const engine = new TouchInputEngine();
    engine.updateStreamDimensions(800, 600);

    const blockedDown = engine.handlePointer(
      { type: "down", pointerId: 1, clientX: 400, clientY: 20, button: 0, atMs: 100 },
      rect,
    );
    expect(blockedDown.frames).toEqual([]);
    expect(blockedDown.acceptedDown).toBe(false);

    const validDown = engine.handlePointer(
      { type: "down", pointerId: 1, clientX: 400, clientY: 50, button: 0, atMs: 200 },
      rect,
    );
    expect(validDown.acceptedDown).toBe(true);
    expect(validDown.frames[0]?.action).toBe(TOUCH_ACTION.DOWN);

    const dragIntoTop = engine.handlePointer(
      { type: "move", pointerId: 1, clientX: 400, clientY: 10, atMs: 220 },
      rect,
    );
    expect(dragIntoTop.frames[0]).toMatchObject({
      action: TOUCH_ACTION.MOVE,
      x: 400,
      y: 10,
    });
  });

  it("Spec 06 AC-02: applies 6 px slop, 60 ms / 20 px chatter debounce, ignores non-primary mouse buttons, cancels active pointers on blur/lostpointercapture, and maps contain-fitted coordinates excluding letterbox/pillarbox margins", () => {
    // Letterbox: 16:9 stream (1280x720) inside 800x600 canvas -> offsetY = 75, drawHeight = 450
    const letterboxRect = { left: 100, top: 30, width: 800, height: 600 };
    expect(mapCanvasPointToStream(500, 50, letterboxRect, 1_280, 720, true)).toBeNull();
    expect(mapCanvasPointToStream(500, 600, letterboxRect, 1_280, 720, true)).toBeNull();
    expect(mapCanvasPointToStream(500, 330, letterboxRect, 1_280, 720, true)).toEqual({
      x: 640,
      y: 360,
      inside: true,
    });
    // Drag moving outside letterbox clamps cleanly to stream bounds.
    expect(mapCanvasPointToStream(500, 620, letterboxRect, 1_280, 720, false)).toEqual({
      x: 640,
      y: 720,
      inside: false,
    });

    // Pillarbox: 4:3 stream (800x600) inside 1000x500 canvas -> offsetX ~= 166.67, drawWidth ~= 666.67
    const pillarRect = { left: 0, top: 0, width: 1_000, height: 500 };
    expect(mapCanvasPointToStream(100, 250, pillarRect, 800, 600, true)).toBeNull();
    expect(mapCanvasPointToStream(900, 250, pillarRect, 800, 600, true)).toBeNull();
    expect(mapCanvasPointToStream(500, 250, pillarRect, 800, 600, true)).toEqual({
      x: 400,
      y: 300,
      inside: true,
    });

    // Invalid / non-positive dimensions never divide by zero.
    expect(
      mapCanvasPointToStream(
        100,
        100,
        { left: 0, top: 0, width: 0, height: 500 },
        1_280,
        720,
        true,
      ),
    ).toBeNull();
    expect(mapCanvasPointToStream(100, 100, pillarRect, 0, 600, true)).toBeNull();

    // Pure engine: non-primary mouse button ignored, 6 px slop, 60 ms / 20 px debounce, multitouch.
    const engine = new TouchInputEngine();
    engine.updateStreamDimensions(1_280, 720);
    const canvasRect = { left: 0, top: 30, width: 800, height: 600 };

    expect(
      engine.handlePointer(
        { type: "down", pointerId: 1, clientX: 400, clientY: 330, button: 2, atMs: 1_000 },
        canvasRect,
      ).frames,
    ).toEqual([]);

    const down1 = engine.handlePointer(
      { type: "down", pointerId: 1, clientX: 400, clientY: 330, button: 0, atMs: 1_000 },
      canvasRect,
    );
    expect(down1.frames[0]?.action).toBe(TOUCH_ACTION.DOWN);

    // Move within 6 px slop is suppressed.
    expect(
      engine.handlePointer(
        { type: "move", pointerId: 1, clientX: 404, clientY: 334, atMs: 1_010 },
        canvasRect,
      ).frames,
    ).toEqual([]);

    // Release as single tap -> sets chatter debounce anchor.
    const up1 = engine.handlePointer(
      { type: "up", pointerId: 1, clientX: 402, clientY: 332, atMs: 1_050 },
      canvasRect,
    );
    expect(up1.frames[0]?.action).toBe(TOUCH_ACTION.UP);

    // Re-tap within 60 ms and 20 px is ignored.
    expect(
      engine.handlePointer(
        { type: "down", pointerId: 2, clientX: 410, clientY: 340, button: 0, atMs: 1_090 },
        canvasRect,
      ).frames,
    ).toEqual([]);

    // Re-tap within 60 ms but > 20 px away is accepted.
    const farDown = engine.handlePointer(
      { type: "down", pointerId: 3, clientX: 440, clientY: 340, button: 0, atMs: 1_095 },
      canvasRect,
    );
    expect(farDown.frames[0]?.action).toBe(TOUCH_ACTION.DOWN);

    // Move beyond 6 px slop is emitted; second finger emits POINTER_DOWN / POINTER_UP.
    const move3 = engine.handlePointer(
      { type: "move", pointerId: 3, clientX: 460, clientY: 340, atMs: 1_110 },
      canvasRect,
    );
    expect(move3.frames[0]?.action).toBe(TOUCH_ACTION.MOVE);

    const pointerDown4 = engine.handlePointer(
      { type: "down", pointerId: 4, clientX: 500, clientY: 350, button: 0, atMs: 1_120 },
      canvasRect,
    );
    expect(pointerDown4.frames[0]?.action).toBe(TOUCH_ACTION.POINTER_DOWN);

    const pointerUp4 = engine.handlePointer(
      { type: "up", pointerId: 4, clientX: 500, clientY: 350, atMs: 1_130 },
      canvasRect,
    );
    expect(pointerUp4.frames[0]?.action).toBe(TOUCH_ACTION.POINTER_UP);

    const up3 = engine.handlePointer(
      { type: "up", pointerId: 3, clientX: 460, clientY: 340, atMs: 1_140 },
      canvasRect,
    );
    expect(up3.frames[0]?.action).toBe(TOUCH_ACTION.UP);

    // After 60 ms elapsed, same-spot tap is accepted again.
    expect(
      engine.handlePointer(
        { type: "down", pointerId: 5, clientX: 460, clientY: 340, button: 0, atMs: 1_210 },
        canvasRect,
      ).acceptedDown,
    ).toBe(true);

    // DOM TouchInputProcessor cancels active pointers on lostpointercapture and window blur.
    const fakeWindow = new SimpleEventTarget();
    const fakeCanvas = new SimpleEventTarget() as SimpleEventTarget & {
      getBoundingClientRect(): DOMRect;
      ownerDocument: { defaultView: EventTarget };
    };
    fakeCanvas.getBoundingClientRect = () =>
      ({ left: 0, top: 30, width: 800, height: 600 }) as DOMRect;
    fakeCanvas.ownerDocument = { defaultView: fakeWindow };

    const emittedFrames: TouchFrame[] = [];
    const interactions: number[] = [];
    const clock = new FakeClock(5_000);
    const processor = new TouchInputProcessor(
      {
        onTouchFrame: (frame) => emittedFrames.push(frame),
        onUserInteraction: (atMs) => interactions.push(atMs),
      },
      { clock },
    );
    processor.updateStreamDimensions(1_280, 720);
    processor.attach(fakeCanvas as unknown as HTMLCanvasElement);

    const dispatchPointer = (
      type: string,
      pointerId: number,
      clientX: number,
      clientY: number,
    ): void => {
      const event = new Event(type) as Event & {
        pointerId: number;
        clientX: number;
        clientY: number;
        button: number;
        pressure: number;
      };
      event.pointerId = pointerId;
      event.clientX = clientX;
      event.clientY = clientY;
      event.button = 0;
      event.pressure = 0.5;
      fakeCanvas.dispatchEvent(event);
    };

    dispatchPointer("pointerdown", 11, 400, 330);
    expect(interactions).toEqual([5_000]);
    fakeCanvas.dispatchEvent(new Event("lostpointercapture"));
    expect(emittedFrames.at(-1)?.action).toBe(TOUCH_ACTION.CANCEL);

    clock.advanceBy(100);
    dispatchPointer("pointerdown", 12, 420, 330);
    fakeWindow.dispatchEvent(new Event("blur"));
    expect(emittedFrames.at(-1)).toMatchObject({
      action: TOUCH_ACTION.CANCEL,
      pointerId: 12n,
    });

    processor.detach();
  });

  it("Spec 03 §2.1: debounces viewport resize events by 350 ms and encodes 7-byte RESIZE frames", () => {
    // Pure frame builder & 7-byte roundtrip using dynamic DPR (no hardcoded 1.53).
    const built = buildResizeFrame(773, 553, 1.25);
    expect(built).toEqual({ width: 773, height: 553, dprX100: 125 });
    expect(buildResizeFrame(0, 553, 1)).toBeNull();

    if (built !== null) {
      const encoded = encodeResizeFrame(built);
      expect(encoded.byteLength).toBe(7);
      expect(decodeResizeFrame(encoded)).toEqual(built);
    }

    const clock = new FakeClock(0);
    let viewportWidth = 773;
    let viewportHeight = 553;
    let currentDpr = 1.4;
    const observerHolder: { trigger: (() => void) | null } = { trigger: null };
    const resizeTarget = new SimpleEventTarget();

    const fakeViewport = {
      getBoundingClientRect: () =>
        ({ left: 0, top: 0, width: viewportWidth, height: viewportHeight }) as DOMRect,
      clientWidth: viewportWidth,
      clientHeight: viewportHeight,
      ownerDocument: { defaultView: resizeTarget },
    } as unknown as HTMLElement;

    const frames: ResizeFrame[] = [];
    const reporter = new ViewportResizeReporter(
      { onResizeFrame: (frame) => frames.push(frame) },
      {
        clock,
        getDpr: () => currentDpr,
        createResizeObserver: (cb) => ({
          observe: () => {
            observerHolder.trigger = cb;
          },
          disconnect: () => {
            observerHolder.trigger = null;
          },
        }),
      },
    );

    reporter.attach(fakeViewport);

    // Rapid resize bursts collapse into a single frame after 350 ms.
    observerHolder.trigger?.();
    clock.advanceBy(200);
    viewportWidth = 900;
    viewportHeight = 600;
    observerHolder.trigger?.();

    clock.advanceBy(PROTOCOL_TIMING.clientResizeDebounceMs - 1);
    expect(frames).toEqual([]);

    clock.advanceBy(1);
    expect(frames).toEqual([{ width: 900, height: 600, dprX100: 140 }]);

    // Window resize also debounces; identical dimensions are deduplicated.
    resizeTarget.dispatchEvent(new Event("resize"));
    clock.advanceBy(PROTOCOL_TIMING.clientResizeDebounceMs);
    expect(frames).toHaveLength(1);

    // triggerImmediate bypasses debounce immediately.
    viewportWidth = 1_280;
    viewportHeight = 720;
    currentDpr = 2.0;
    resizeTarget.dispatchEvent(new Event("resize"));
    reporter.triggerImmediate();
    expect(frames).toEqual([
      { width: 900, height: 600, dprX100: 140 },
      { width: 1_280, height: 720, dprX100: 200 },
    ]);

    clock.advanceBy(PROTOCOL_TIMING.clientResizeDebounceMs);
    expect(frames).toHaveLength(2);
    reporter.detach();
  });

  it("Spec 06 §2.2: normalizes touch coordinates in effective layout dimensions after maxSize clamp", () => {
    // 実車相当: クライアントビューポート 1710×941 dpr=2、stream.maxSize=1280 → 有効寸法 1280×704 で正規化される。
    const engine = new TouchInputEngine();
    engine.updateStreamDimensions(1_710, 941, { dpr: 2, maxSize: 1_280 });

    const down = engine.handlePointer(
      { type: "down", pointerId: 1, clientX: 855, clientY: 470, button: 0, atMs: 100 },
      { left: 0, top: 0, width: 1_710, height: 941 },
    );
    expect(down.frames[0]).toMatchObject({
      action: TOUCH_ACTION.DOWN,
      x: 640,
      screenWidth: 1_280,
      screenHeight: 704,
    });
    expect(down.frames[0]?.y).toBeGreaterThanOrEqual(351);
    expect(down.frames[0]?.y).toBeLessThanOrEqual(353);

    // maxSize 変更時は次の resize 報告を待たず再正規化する（SETTINGS_UPDATED 経路と同じ呼び出し）。
    engine.handlePointer(
      { type: "up", pointerId: 1, clientX: 855, clientY: 470, button: 0, atMs: 300 },
      { left: 0, top: 0, width: 1_710, height: 941 },
    );
    engine.updateStreamDimensions(1_710, 941, { dpr: 2, maxSize: 960 });
    const downAfter = engine.handlePointer(
      { type: "down", pointerId: 2, clientX: 855, clientY: 470, button: 0, atMs: 500 },
      { left: 0, top: 0, width: 1_710, height: 941 },
    );
    expect(downAfter.frames[0]).toMatchObject({
      action: TOUCH_ACTION.DOWN,
      x: 480,
      screenWidth: 960,
      screenHeight: 528,
    });
  });

  it("Spec 06 §2.2: raw viewport dimensions without opts keep legacy identity behavior", () => {
    const engine = new TouchInputEngine();
    engine.updateStreamDimensions(1_280, 720);
    const down = engine.handlePointer(
      { type: "down", pointerId: 1, clientX: 640, clientY: 360, button: 0, atMs: 100 },
      { left: 0, top: 0, width: 1_280, height: 720 },
    );
    expect(down.frames[0]).toMatchObject({ x: 640, y: 360, screenWidth: 1_280 });
  });
});
