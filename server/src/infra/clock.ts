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
  private readonly timeouts = new Map<TimerHandle, ReturnType<typeof globalThis.setTimeout>>();
  private readonly intervals = new Map<TimerHandle, ReturnType<typeof globalThis.setInterval>>();

  // Spec: docs/architecture.md#2.3
  nowMs(): number {
    return Date.now();
  }

  // Spec: docs/architecture.md#2.3
  monotonicMs(): number {
    return performance.now();
  }

  // Spec: docs/architecture.md#2.3
  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const handle: TimerHandle = { __brand: "TimerHandle" };
    const timer = globalThis.setTimeout(() => {
      this.timeouts.delete(handle);
      callback();
    }, delayMs);
    this.timeouts.set(handle, timer);
    return handle;
  }

  // Spec: docs/architecture.md#2.3
  clearTimeout(handle: TimerHandle): void {
    const timer = this.timeouts.get(handle);
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      this.timeouts.delete(handle);
    }
  }

  // Spec: docs/architecture.md#2.3
  setInterval(callback: () => void, intervalMs: number): TimerHandle {
    const handle: TimerHandle = { __brand: "TimerHandle" };
    const timer = globalThis.setInterval(callback, intervalMs);
    this.intervals.set(handle, timer);
    return handle;
  }

  // Spec: docs/architecture.md#2.3
  clearInterval(handle: TimerHandle): void {
    const timer = this.intervals.get(handle);
    if (timer !== undefined) {
      globalThis.clearInterval(timer);
      this.intervals.delete(handle);
    }
  }
}
