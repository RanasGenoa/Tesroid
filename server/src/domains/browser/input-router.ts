import { type SpecialKey, TOUCH_ACTION, TOUCH_GUARD, type TouchFrame } from "@tesroid/shared";
import type { Clock, TimerHandle } from "../../infra/index.js";
import type { CdpClientPort } from "./ports.js";

export type DroppedInputKind = "touch" | "text" | "key" | "navigate" | "navigation" | "fullscreen";

export interface InputRouterDeps {
  readonly clock: Clock;
  readonly cdp: CdpClientPort;
  readonly onDroppedInput?: (kind: DroppedInputKind, reason: string) => void;
}

interface ActivePointer {
  readonly id: number;
  readonly startX: number;
  readonly startY: number;
  x: number;
  y: number;
  started: boolean;
  slopPassed: boolean;
}

interface TapSnapshot {
  readonly x: number;
  readonly y: number;
  readonly atMs: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toCdpTouchId(pointerId: bigint): number {
  return Number(BigInt.asUintN(31, pointerId));
}

export class BrowserInputRouter {
  private readonly deps: InputRouterDeps;
  private readonly pointers = new Map<string, ActivePointer>();
  private lastTapUp: TapSnapshot | null = null;
  private debounceTimer: TimerHandle | null = null;
  private stuckTimer: TimerHandle | null = null;

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  constructor(deps: InputRouterDeps) {
    this.deps = deps;
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  async dispatchTouch(frame: TouchFrame): Promise<void> {
    if (
      !Number.isFinite(frame.x) ||
      !Number.isFinite(frame.y) ||
      !Number.isFinite(frame.screenWidth) ||
      !Number.isFinite(frame.screenHeight) ||
      frame.screenWidth <= 0 ||
      frame.screenHeight <= 0
    ) {
      return;
    }

    if (!this.deps.cdp.isConnected()) {
      this.clearLocalTouchState();
      this.deps.onDroppedInput?.("touch", "cdp_disconnected");
      return;
    }

    const x = clamp(frame.x, 0, frame.screenWidth);
    const y = clamp(frame.y, 0, frame.screenHeight);
    const key = frame.pointerId.toString();

    switch (frame.action) {
      case TOUCH_ACTION.DOWN: {
        if (this.pointers.size > 0) {
          await this.resetActiveTouches();
        }
        const now = this.deps.clock.nowMs();
        const prevTap = this.lastTapUp;
        if (prevTap !== null) {
          const elapsed = now - prevTap.atMs;
          const dist = Math.hypot(x - prevTap.x, y - prevTap.y);
          if (
            elapsed >= 0 &&
            elapsed < TOUCH_GUARD.serverDebounceMs &&
            dist <= TOUCH_GUARD.serverDebounceRadiusPx
          ) {
            this.pointers.set(key, {
              id: toCdpTouchId(frame.pointerId),
              startX: x,
              startY: y,
              x,
              y,
              started: false,
              slopPassed: false,
            });
            this.clearDebounceTimer();
            this.debounceTimer = this.deps.clock.setTimeout(() => {
              this.debounceTimer = null;
              void this.promoteDebouncedPointer(key);
            }, TOUCH_GUARD.serverDebounceMs - elapsed);
            this.armStuckTimer();
            return;
          }
        }

        this.lastTapUp = null;
        this.pointers.set(key, {
          id: toCdpTouchId(frame.pointerId),
          startX: x,
          startY: y,
          x,
          y,
          started: true,
          slopPassed: false,
        });
        this.armStuckTimer();
        await this.emitCdpTouch("touchStart");
        return;
      }

      case TOUCH_ACTION.POINTER_DOWN: {
        await this.promoteAllPendingPointers();
        for (const existing of this.pointers.values()) {
          existing.slopPassed = true;
        }
        this.lastTapUp = null;
        this.pointers.set(key, {
          id: toCdpTouchId(frame.pointerId),
          startX: x,
          startY: y,
          x,
          y,
          started: true,
          slopPassed: true,
        });
        this.armStuckTimer();
        await this.emitCdpTouch("touchStart");
        return;
      }

      case TOUCH_ACTION.MOVE: {
        const pointer = this.pointers.get(key);
        if (pointer === undefined) {
          return;
        }

        if (!pointer.started) {
          const movedDist = Math.hypot(x - pointer.startX, y - pointer.startY);
          if (movedDist <= TOUCH_GUARD.serverSlopPx) {
            pointer.x = x;
            pointer.y = y;
            this.armStuckTimer();
            return;
          }
          // Dragging past slop during debounce immediately promotes the suppressed tap to touchStart.
          this.clearDebounceTimer();
          this.lastTapUp = null;
          pointer.started = true;
          pointer.slopPassed = true;
          pointer.x = pointer.startX;
          pointer.y = pointer.startY;
          await this.emitCdpTouch("touchStart");
          pointer.x = x;
          pointer.y = y;
          this.armStuckTimer();
          await this.emitCdpTouch("touchMove");
          return;
        }

        if (!pointer.slopPassed && this.pointers.size === 1) {
          const movedDist = Math.hypot(x - pointer.startX, y - pointer.startY);
          if (movedDist <= TOUCH_GUARD.serverSlopPx) {
            this.armStuckTimer();
            return;
          }
          pointer.slopPassed = true;
        }

        pointer.x = x;
        pointer.y = y;
        this.armStuckTimer();
        await this.emitCdpTouch("touchMove");
        return;
      }

      case TOUCH_ACTION.POINTER_UP:
      case TOUCH_ACTION.UP: {
        const pointer = this.pointers.get(key);
        if (pointer === undefined) {
          return;
        }

        if (!pointer.started) {
          this.clearDebounceTimer();
          this.pointers.delete(key);
          if (this.pointers.size === 0) {
            this.clearStuckTimer();
          }
          return;
        }

        const isSingleTapUp = this.pointers.size === 1 && !pointer.slopPassed;
        const tapX = pointer.x;
        const tapY = pointer.y;
        this.pointers.delete(key);

        if (isSingleTapUp) {
          this.lastTapUp = { x: tapX, y: tapY, atMs: this.deps.clock.nowMs() };
        } else if (this.pointers.size === 0) {
          this.lastTapUp = null;
        }

        if (this.pointers.size === 0) {
          this.clearStuckTimer();
        } else {
          this.armStuckTimer();
        }
        await this.emitCdpTouch("touchEnd");
        return;
      }

      case TOUCH_ACTION.CANCEL: {
        await this.resetActiveTouches();
        return;
      }
    }
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  async dispatchText(text: string): Promise<void> {
    if (!this.deps.cdp.isConnected()) {
      this.deps.onDroppedInput?.("text", "cdp_disconnected");
      return;
    }
    if (text.length === 0) {
      return;
    }
    await this.deps.cdp.insertText(text);
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  async dispatchKey(key: SpecialKey): Promise<void> {
    if (!this.deps.cdp.isConnected()) {
      this.deps.onDroppedInput?.("key", "cdp_disconnected");
      return;
    }
    await this.deps.cdp.dispatchKey(key);
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  async resetActiveTouches(): Promise<void> {
    this.clearDebounceTimer();
    this.clearStuckTimer();
    const hadStarted = this.hasStartedPointer();
    this.pointers.clear();
    if (hadStarted && this.deps.cdp.isConnected()) {
      await this.deps.cdp.dispatchTouchEvent("touchCancel", []);
    }
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  dispose(): void {
    this.clearLocalTouchState();
    this.lastTapUp = null;
  }

  private hasStartedPointer(): boolean {
    for (const pointer of this.pointers.values()) {
      if (pointer.started) {
        return true;
      }
    }
    return false;
  }

  private clearLocalTouchState(): void {
    this.clearDebounceTimer();
    this.clearStuckTimer();
    this.pointers.clear();
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer !== null) {
      this.deps.clock.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private clearStuckTimer(): void {
    if (this.stuckTimer !== null) {
      this.deps.clock.clearTimeout(this.stuckTimer);
      this.stuckTimer = null;
    }
  }

  private armStuckTimer(): void {
    this.clearStuckTimer();
    this.stuckTimer = this.deps.clock.setTimeout(() => {
      this.stuckTimer = null;
      void this.resetActiveTouches();
    }, TOUCH_GUARD.stuckTouchTimeoutMs);
  }

  private async promoteDebouncedPointer(key: string): Promise<void> {
    const pointer = this.pointers.get(key);
    if (pointer === undefined || pointer.started) {
      return;
    }
    if (!this.deps.cdp.isConnected()) {
      this.clearLocalTouchState();
      this.deps.onDroppedInput?.("touch", "cdp_disconnected");
      return;
    }
    this.lastTapUp = null;
    pointer.started = true;
    this.armStuckTimer();
    await this.emitCdpTouch("touchStart");
  }

  private async promoteAllPendingPointers(): Promise<void> {
    this.clearDebounceTimer();
    let promoted = false;
    for (const pointer of this.pointers.values()) {
      if (!pointer.started) {
        pointer.started = true;
        pointer.slopPassed = true;
        promoted = true;
      }
    }
    if (promoted) {
      await this.emitCdpTouch("touchStart");
    }
  }

  private async emitCdpTouch(
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
  ): Promise<void> {
    const touchPoints: { readonly x: number; readonly y: number; readonly id: number }[] = [];
    for (const pointer of this.pointers.values()) {
      if (pointer.started) {
        touchPoints.push({
          x: pointer.x,
          y: pointer.y,
          id: pointer.id,
        });
      }
    }
    await this.deps.cdp.dispatchTouchEvent(type, touchPoints);
  }
}
