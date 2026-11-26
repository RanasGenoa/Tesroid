import type { AlignedDimensions, SpecialKey, TouchFrame } from "@tesroid/shared";
import type { PowerBrowserPort } from "../power/ports.js";

export interface BrowserLaunchConfig {
  readonly display: string;
  readonly locale: string;
  readonly timezone: string;
  readonly userDataDir: string;
  readonly pulseSocketPath: string;
  readonly cdpPort: number;
  readonly initialUrl: string;
  readonly viewport: AlignedDimensions;
}

export interface BrowserPageInfo {
  readonly url: string | null;
  readonly title: string | null;
}

export interface CdpClientPort {
  connect(port: number): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  dispatchTouchEvent(
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    touchPoints: readonly { readonly x: number; readonly y: number; readonly id: number }[],
  ): Promise<void>;
  insertText(text: string): Promise<void>;
  dispatchKey(key: SpecialKey): Promise<void>;
  navigate(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  addScriptToEvaluateOnNewDocument(source: string): Promise<void>;
  getPageInfo(): Promise<BrowserPageInfo>;
}

export interface X11InputPort {
  dispatchMouseOrWheel(frame: TouchFrame): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKey(key: SpecialKey): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
}

export interface BrowserControlPort extends PowerBrowserPort {
  navigate(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  toggleFullscreen(): Promise<void>;
  setDisplayScale(scale: number): Promise<void>;
  resizeViewport(dimensions: AlignedDimensions): Promise<void>;
  injectTouch(frame: TouchFrame): Promise<void>;
  injectText(text: string): Promise<void>;
  injectKey(key: SpecialKey): Promise<void>;
}
