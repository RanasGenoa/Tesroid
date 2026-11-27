import { computeContainRect, TOUCH_ACTION, TOUCH_GUARD, type TouchFrame } from "@tesroid/shared";
import { type ClientClock, createBrowserClock } from "../transport/ports.js";

export interface TouchProcessorCallbacks {
  readonly onTouchFrame: (frame: TouchFrame) => void;
  readonly onUserInteraction: (atMs: number) => void;
}

export interface TouchProcessorOptions {
  readonly clock?: Pick<ClientClock, "nowMs">;
}

export interface CanvasRectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface TouchPointerInput {
  readonly type: "down" | "move" | "up" | "cancel";
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly button?: number;
  readonly pressure?: number;
  readonly atMs: number;
}

export interface MappedStreamPoint {
  readonly x: number;
  readonly y: number;
  readonly inside: boolean;
}

export interface TouchStepResult {
  readonly frames: readonly TouchFrame[];
  readonly userInteractionAtMs: number | null;
  readonly acceptedDown: boolean;
}

interface TrackedPointer {
  readonly pointerId: number;
  readonly startLocalX: number;
  readonly startLocalY: number;
  x: number;
  y: number;
  slopPassed: boolean;
}

interface TapSnapshot {
  readonly localX: number;
  readonly localY: number;
  readonly atMs: number;
}

const MAX_UINT16 = 0xffff;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function encodePressure(pressure: number | undefined): number {
  if (pressure === undefined || !Number.isFinite(pressure) || pressure <= 0) {
    return MAX_UINT16;
  }
  if (pressure <= 1) {
    return clamp(Math.round(pressure * MAX_UINT16), 1, MAX_UINT16);
  }
  return clamp(Math.round(pressure), 1, MAX_UINT16);
}

// Spec: docs/specs/06-browser-input-cdp.md#2.2
export function mapCanvasPointToStream(
  clientX: number,
  clientY: number,
  canvasRect: CanvasRectLike,
  streamWidth: number,
  streamHeight: number,
  isTouchStart: boolean,
): MappedStreamPoint | null {
  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    !Number.isFinite(canvasRect.left) ||
    !Number.isFinite(canvasRect.top) ||
    !isPositiveFinite(canvasRect.width) ||
    !isPositiveFinite(canvasRect.height) ||
    !isPositiveFinite(streamWidth) ||
    !isPositiveFinite(streamHeight)
  ) {
    return null;
  }

  // Preserve in-car OS swipe-down gesture at the top edge of the screen.
  if (isTouchStart && clientY <= TOUCH_GUARD.topEdgeGuardPx) {
    return null;
  }

  const contain = computeContainRect(
    canvasRect.width,
    canvasRect.height,
    streamWidth,
    streamHeight,
  );
  if (contain.drawWidth <= 0 || contain.drawHeight <= 0) {
    return null;
  }

  const localX = clientX - canvasRect.left;
  const localY = clientY - canvasRect.top;

  const inside =
    localX >= contain.offsetX &&
    localX <= contain.offsetX + contain.drawWidth &&
    localY >= contain.offsetY &&
    localY <= contain.offsetY + contain.drawHeight;

  if (isTouchStart && !inside) {
    return null;
  }

  const x = Math.round(
    clamp(((localX - contain.offsetX) / contain.drawWidth) * streamWidth, 0, streamWidth),
  );
  const y = Math.round(
    clamp(((localY - contain.offsetY) / contain.drawHeight) * streamHeight, 0, streamHeight),
  );

  return { x, y, inside };
}

export class TouchInputEngine {
  private streamWidth = 0;
  private streamHeight = 0;
  private readonly activePointers = new Map<number, TrackedPointer>();
  private lastTapUp: TapSnapshot | null = null;

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  updateStreamDimensions(width: number, height: number): void {
    if (!isPositiveFinite(width) || !isPositiveFinite(height)) {
      this.streamWidth = 0;
      this.streamHeight = 0;
      return;
    }
    this.streamWidth = clamp(Math.round(width), 1, MAX_UINT16);
    this.streamHeight = clamp(Math.round(height), 1, MAX_UINT16);
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  handlePointer(input: TouchPointerInput, canvasRect: CanvasRectLike): TouchStepResult {
    if (!isPositiveFinite(this.streamWidth) || !isPositiveFinite(this.streamHeight)) {
      return { frames: [], userInteractionAtMs: null, acceptedDown: false };
    }

    switch (input.type) {
      case "down":
        return this.handleDown(input, canvasRect);
      case "move":
        return this.handleMove(input, canvasRect);
      case "up":
        return this.handleUp(input, canvasRect);
      case "cancel":
        return this.handleCancel(input);
    }
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  cancelAll(): readonly TouchFrame[] {
    if (this.activePointers.size === 0) {
      this.lastTapUp = null;
      return [];
    }
    const frames: TouchFrame[] = [];
    for (const pointer of this.activePointers.values()) {
      frames.push(
        this.buildFrame(TOUCH_ACTION.CANCEL, pointer.pointerId, pointer.x, pointer.y, 0, 0),
      );
    }
    this.activePointers.clear();
    this.lastTapUp = null;
    return frames;
  }

  private handleDown(input: TouchPointerInput, canvasRect: CanvasRectLike): TouchStepResult {
    if (input.button !== undefined && input.button !== 0) {
      return { frames: [], userInteractionAtMs: null, acceptedDown: false };
    }

    const mapped = mapCanvasPointToStream(
      input.clientX,
      input.clientY,
      canvasRect,
      this.streamWidth,
      this.streamHeight,
      true,
    );
    if (mapped === null) {
      return { frames: [], userInteractionAtMs: null, acceptedDown: false };
    }

    const localX = input.clientX - canvasRect.left;
    const localY = input.clientY - canvasRect.top;

    if (this.activePointers.size === 0 && this.lastTapUp !== null) {
      const elapsed = input.atMs - this.lastTapUp.atMs;
      const dist = Math.hypot(localX - this.lastTapUp.localX, localY - this.lastTapUp.localY);
      if (
        elapsed >= 0 &&
        elapsed < TOUCH_GUARD.clientDebounceMs &&
        dist <= TOUCH_GUARD.clientDebounceRadiusPx
      ) {
        return { frames: [], userInteractionAtMs: null, acceptedDown: false };
      }
    }

    const isAdditionalPointer = this.activePointers.size > 0;
    if (isAdditionalPointer) {
      for (const existing of this.activePointers.values()) {
        existing.slopPassed = true;
      }
    }
    this.lastTapUp = null;

    this.activePointers.set(input.pointerId, {
      pointerId: input.pointerId,
      startLocalX: localX,
      startLocalY: localY,
      x: mapped.x,
      y: mapped.y,
      slopPassed: isAdditionalPointer,
    });

    const action = isAdditionalPointer ? TOUCH_ACTION.POINTER_DOWN : TOUCH_ACTION.DOWN;
    const frame = this.buildFrame(
      action,
      input.pointerId,
      mapped.x,
      mapped.y,
      encodePressure(input.pressure),
      1,
    );
    return { frames: [frame], userInteractionAtMs: input.atMs, acceptedDown: true };
  }

  private handleMove(input: TouchPointerInput, canvasRect: CanvasRectLike): TouchStepResult {
    const pointer = this.activePointers.get(input.pointerId);
    if (pointer === undefined) {
      return { frames: [], userInteractionAtMs: null, acceptedDown: false };
    }

    const mapped = mapCanvasPointToStream(
      input.clientX,
      input.clientY,
      canvasRect,
      this.streamWidth,
      this.streamHeight,
      false,
    );
    if (mapped === null) {
      return { frames: [], userInteractionAtMs: null, acceptedDown: false };
    }

    const localX = input.clientX - canvasRect.left;
    const localY = input.clientY - canvasRect.top;

    if (!pointer.slopPassed && this.activePointers.size === 1) {
      const dist = Math.hypot(localX - pointer.startLocalX, localY - pointer.startLocalY);
      if (dist <= TOUCH_GUARD.clientSlopPx) {
        return { frames: [], userInteractionAtMs: null, acceptedDown: false };
      }
      pointer.slopPassed = true;
    }

    pointer.x = mapped.x;
    pointer.y = mapped.y;

    const frame = this.buildFrame(
      TOUCH_ACTION.MOVE,
      input.pointerId,
      mapped.x,
      mapped.y,
      encodePressure(input.pressure),
      1,
    );
    return { frames: [frame], userInteractionAtMs: input.atMs, acceptedDown: false };
  }

  private handleUp(input: TouchPointerInput, canvasRect: CanvasRectLike): TouchStepResult {
    const pointer = this.activePointers.get(input.pointerId);
    if (pointer === undefined) {
      return { frames: [], userInteractionAtMs: null, acceptedDown: false };
    }

    const mapped = mapCanvasPointToStream(
      input.clientX,
      input.clientY,
      canvasRect,
      this.streamWidth,
      this.streamHeight,
      false,
    );
    const x = mapped?.x ?? pointer.x;
    const y = mapped?.y ?? pointer.y;

    const isLast = this.activePointers.size === 1;
    const wasSingleTap = isLast && !pointer.slopPassed;
    this.activePointers.delete(input.pointerId);

    if (wasSingleTap) {
      this.lastTapUp = {
        localX: input.clientX - canvasRect.left,
        localY: input.clientY - canvasRect.top,
        atMs: input.atMs,
      };
    } else if (isLast) {
      this.lastTapUp = null;
    }

    const action = isLast ? TOUCH_ACTION.UP : TOUCH_ACTION.POINTER_UP;
    const frame = this.buildFrame(action, input.pointerId, x, y, 0, 0);
    return { frames: [frame], userInteractionAtMs: input.atMs, acceptedDown: false };
  }

  private handleCancel(input: TouchPointerInput): TouchStepResult {
    const pointer = this.activePointers.get(input.pointerId);
    if (pointer === undefined) {
      return { frames: [], userInteractionAtMs: null, acceptedDown: false };
    }
    this.activePointers.delete(input.pointerId);
    if (this.activePointers.size === 0) {
      this.lastTapUp = null;
    }
    const frame = this.buildFrame(TOUCH_ACTION.CANCEL, input.pointerId, pointer.x, pointer.y, 0, 0);
    return { frames: [frame], userInteractionAtMs: null, acceptedDown: false };
  }

  private buildFrame(
    action: TouchFrame["action"],
    pointerId: number,
    x: number,
    y: number,
    pressure: number,
    buttons: number,
  ): TouchFrame {
    return {
      action,
      pointerId: BigInt(Math.trunc(pointerId)),
      x,
      y,
      screenWidth: this.streamWidth,
      screenHeight: this.streamHeight,
      pressure,
      actionButton: 0,
      buttons,
    };
  }
}

interface AttachedDomState {
  readonly canvas: HTMLCanvasElement;
  readonly blurTarget: EventTarget | null;
  readonly onPointerDown: (event: Event) => void;
  readonly onPointerMove: (event: Event) => void;
  readonly onPointerUp: (event: Event) => void;
  readonly onPointerCancel: (event: Event) => void;
  readonly onLostPointerCapture: () => void;
  readonly onWindowBlur: () => void;
}

export class TouchInputProcessor {
  private readonly callbacks: TouchProcessorCallbacks;
  private readonly clock: Pick<ClientClock, "nowMs">;
  private readonly engine = new TouchInputEngine();
  private attached: AttachedDomState | null = null;

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  constructor(callbacks: TouchProcessorCallbacks, options?: TouchProcessorOptions) {
    this.callbacks = callbacks;
    this.clock = options?.clock ?? createBrowserClock();
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  attach(canvas: HTMLCanvasElement): void {
    this.detach();

    const handlePointer = (type: TouchPointerInput["type"], event: Event): void => {
      const pointerEvent = event as PointerEvent;
      const rect = canvas.getBoundingClientRect();
      const result = this.engine.handlePointer(
        {
          type,
          pointerId: pointerEvent.pointerId,
          clientX: pointerEvent.clientX,
          clientY: pointerEvent.clientY,
          button: pointerEvent.button,
          pressure: pointerEvent.pressure,
          atMs: this.clock.nowMs(),
        },
        {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
      );

      if (result.acceptedDown) {
        try {
          canvas.setPointerCapture?.(pointerEvent.pointerId);
        } catch {
          // Synthetic pointer events without active DOM capture state can throw safely here.
        }
      } else if (type === "up" || type === "cancel") {
        try {
          if (canvas.hasPointerCapture?.(pointerEvent.pointerId)) {
            canvas.releasePointerCapture?.(pointerEvent.pointerId);
          }
        } catch {
          // Ignore release failures when capture was already lost.
        }
      }

      if (result.userInteractionAtMs !== null) {
        this.callbacks.onUserInteraction(result.userInteractionAtMs);
      }
      for (const frame of result.frames) {
        this.callbacks.onTouchFrame(frame);
      }
    };

    const onPointerDown = (event: Event) => {
      handlePointer("down", event);
    };
    const onPointerMove = (event: Event) => {
      handlePointer("move", event);
    };
    const onPointerUp = (event: Event) => {
      handlePointer("up", event);
    };
    const onPointerCancel = (event: Event) => {
      handlePointer("cancel", event);
    };
    const onLostPointerCapture = () => {
      this.cancelAllTouches();
    };
    const onWindowBlur = () => {
      this.cancelAllTouches();
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("lostpointercapture", onLostPointerCapture);

    const view = canvas.ownerDocument?.defaultView ?? globalThis;
    const blurTarget = typeof view.addEventListener === "function" ? view : null;
    blurTarget?.addEventListener("blur", onWindowBlur);

    this.attached = {
      canvas,
      blurTarget,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onWindowBlur,
    };
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  detach(): void {
    this.cancelAllTouches();
    if (this.attached === null) {
      return;
    }
    const {
      canvas,
      blurTarget,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onWindowBlur,
    } = this.attached;
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerCancel);
    canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
    blurTarget?.removeEventListener("blur", onWindowBlur);
    this.attached = null;
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  updateStreamDimensions(width: number, height: number): void {
    this.engine.updateStreamDimensions(width, height);
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  cancelAllTouches(): void {
    for (const frame of this.engine.cancelAll()) {
      this.callbacks.onTouchFrame(frame);
    }
  }
}
