import type { ResizeFrame } from "@tesroid/shared";

export interface ResizeReporterCallbacks {
  readonly onResizeFrame: (frame: ResizeFrame) => void;
}

export class ViewportResizeReporter {
  // Spec: docs/specs/03-streaming-transport.md#2.1
  constructor(callbacks: ResizeReporterCallbacks) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  attach(viewportElement: HTMLElement): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  detach(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  triggerImmediate(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
