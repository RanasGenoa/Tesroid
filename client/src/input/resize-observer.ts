import { PROTOCOL_TIMING, type ResizeFrame } from "@tesroid/shared";
import {
  type ClientClock,
  type ClientTimerHandle,
  createBrowserClock,
} from "../transport/ports.js";

export interface ResizeReporterCallbacks {
  readonly onResizeFrame: (frame: ResizeFrame) => void;
}

export interface ResizeObserverLike {
  observe(target: HTMLElement): void;
  disconnect(): void;
}

export interface ViewportResizeReporterOptions {
  readonly clock?: ClientClock;
  readonly debounceMs?: number;
  readonly getDpr?: () => number;
  readonly createResizeObserver?: (callback: () => void) => ResizeObserverLike;
}

const MAX_UINT16 = 0xffff;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function defaultGetDpr(): number {
  return typeof globalThis.devicePixelRatio === "number" &&
    Number.isFinite(globalThis.devicePixelRatio) &&
    globalThis.devicePixelRatio > 0
    ? globalThis.devicePixelRatio
    : 1;
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function buildResizeFrame(width: number, height: number, dpr: number): ResizeFrame | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return {
    width: clamp(Math.round(width), 1, MAX_UINT16),
    height: clamp(Math.round(height), 1, MAX_UINT16),
    dprX100: clamp(Math.round(safeDpr * 100), 1, MAX_UINT16),
  };
}

function readElementSize(element: HTMLElement): {
  readonly width: number;
  readonly height: number;
} {
  const rect = element.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height };
  }
  return { width: element.clientWidth, height: element.clientHeight };
}

function isSameFrame(a: ResizeFrame | null, b: ResizeFrame): boolean {
  return a !== null && a.width === b.width && a.height === b.height && a.dprX100 === b.dprX100;
}

export class ViewportResizeReporter {
  private readonly callbacks: ResizeReporterCallbacks;
  private readonly clock: ClientClock;
  private readonly debounceMs: number;
  private readonly getDpr: () => number;
  private readonly createResizeObserver?: (callback: () => void) => ResizeObserverLike;

  private element: HTMLElement | null = null;
  private observer: ResizeObserverLike | null = null;
  private resizeTarget: EventTarget | null = null;
  private windowResizeHandler: (() => void) | null = null;
  private debounceTimer: ClientTimerHandle | null = null;
  private lastEmittedFrame: ResizeFrame | null = null;

  // Spec: docs/specs/03-streaming-transport.md#2.1
  constructor(callbacks: ResizeReporterCallbacks, options?: ViewportResizeReporterOptions) {
    this.callbacks = callbacks;
    this.clock = options?.clock ?? createBrowserClock();
    this.debounceMs = options?.debounceMs ?? PROTOCOL_TIMING.clientResizeDebounceMs;
    this.getDpr = options?.getDpr ?? defaultGetDpr;
    this.createResizeObserver = options?.createResizeObserver;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  attach(viewportElement: HTMLElement): void {
    this.detach();
    this.element = viewportElement;

    const scheduleEmit = () => {
      this.scheduleDebouncedEmit();
    };

    if (this.createResizeObserver !== undefined) {
      this.observer = this.createResizeObserver(scheduleEmit);
      this.observer.observe(viewportElement);
    } else if (typeof globalThis.ResizeObserver === "function") {
      const ro = new globalThis.ResizeObserver(() => {
        scheduleEmit();
      });
      ro.observe(viewportElement);
      this.observer = ro;
    }

    const view = viewportElement.ownerDocument?.defaultView ?? globalThis;
    if (typeof view.addEventListener === "function") {
      this.resizeTarget = view;
      this.windowResizeHandler = scheduleEmit;
      view.addEventListener("resize", scheduleEmit);
    }
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  detach(): void {
    this.clearDebounceTimer();
    this.observer?.disconnect();
    this.observer = null;
    if (this.resizeTarget !== null && this.windowResizeHandler !== null) {
      this.resizeTarget.removeEventListener("resize", this.windowResizeHandler);
    }
    this.resizeTarget = null;
    this.windowResizeHandler = null;
    this.element = null;
    this.lastEmittedFrame = null;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  triggerImmediate(): void {
    this.clearDebounceTimer();
    this.emitCurrentSize(false);
  }

  private scheduleDebouncedEmit(): void {
    this.clearDebounceTimer();
    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = null;
      this.emitCurrentSize(true);
    }, this.debounceMs);
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer !== null) {
      this.clock.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private emitCurrentSize(skipUnchanged: boolean): void {
    if (this.element === null) {
      return;
    }
    const { width, height } = readElementSize(this.element);
    const frame = buildResizeFrame(width, height, this.getDpr());
    if (frame === null) {
      return;
    }
    if (skipUnchanged && isSameFrame(this.lastEmittedFrame, frame)) {
      return;
    }
    this.lastEmittedFrame = frame;
    this.callbacks.onResizeFrame(frame);
  }
}
