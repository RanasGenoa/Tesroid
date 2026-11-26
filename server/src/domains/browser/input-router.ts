import type { SpecialKey, TouchFrame } from "@tesroid/shared";
import type { Clock } from "../../infra/index.js";
import type { CdpClientPort, X11InputPort } from "./ports.js";

export interface InputRouterDeps {
  readonly clock: Clock;
  readonly cdp: CdpClientPort;
  readonly x11: X11InputPort;
}

export class BrowserInputRouter {
  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  constructor(deps: InputRouterDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  dispatchTouch(frame: TouchFrame): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  dispatchText(text: string): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  dispatchKey(key: SpecialKey): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  resetActiveTouches(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  dispose(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
