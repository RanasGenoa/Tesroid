import type { TouchFrame } from "@tesroid/shared";

export interface TouchProcessorCallbacks {
  readonly onTouchFrame: (frame: TouchFrame) => void;
  readonly onUserInteraction: (atMs: number) => void;
}

export class TouchInputProcessor {
  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  constructor(callbacks: TouchProcessorCallbacks) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  attach(canvas: HTMLCanvasElement): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  detach(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  updateStreamDimensions(width: number, height: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  cancelAllTouches(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
