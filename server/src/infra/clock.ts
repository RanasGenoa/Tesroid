export interface TimerHandle {
  readonly __brand: "TimerHandle";
}

export interface Clock {
  nowMs(): number;
  monotonicMs(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(callback: () => void, intervalMs: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

export class SystemClock implements Clock {
  // Spec: docs/architecture.md#2.3
  nowMs(): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#2.3
  monotonicMs(): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#2.3
  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#2.3
  clearTimeout(handle: TimerHandle): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#2.3
  setInterval(callback: () => void, intervalMs: number): TimerHandle {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#2.3
  clearInterval(handle: TimerHandle): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
