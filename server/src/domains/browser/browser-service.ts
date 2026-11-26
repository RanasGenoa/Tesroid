import type { AlignedDimensions, SpecialKey, TouchFrame } from "@tesroid/shared";
import type { Clock, ProcessRunner, ProcessTreeController } from "../../infra/index.js";
import type { SettingsRepository } from "../settings/ports.js";
import type { BrowserInputRouter } from "./input-router.js";
import type {
  BrowserControlPort,
  BrowserLaunchConfig,
  BrowserPageInfo,
  CdpClientPort,
  X11InputPort,
} from "./ports.js";

export interface BrowserServiceDeps {
  readonly clock: Clock;
  readonly settings: SettingsRepository;
  readonly processRunner: ProcessRunner;
  readonly processTree: ProcessTreeController;
  readonly cdp: CdpClientPort;
  readonly x11: X11InputPort;
  readonly inputRouter: BrowserInputRouter;
  readonly config: Omit<BrowserLaunchConfig, "initialUrl" | "timezone">;
}

export class BrowserService implements BrowserControlPort {
  // Spec: docs/specs/06-browser-input-cdp.md#2.1
  constructor(deps: BrowserServiceDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.1
  start(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  stop(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  freezeTree(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  resumeTree(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  restartBrowser(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.4
  setMonitoringPaused(paused: boolean): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.4
  getCurrentPageInfo(): BrowserPageInfo {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.1
  navigate(url: string): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  goBack(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  goForward(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  reload(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.4
  toggleFullscreen(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.4
  setDisplayScale(scale: number): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.3
  resizeViewport(dimensions: AlignedDimensions): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  injectTouch(frame: TouchFrame): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  injectText(text: string): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  injectKey(key: SpecialKey): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
}
