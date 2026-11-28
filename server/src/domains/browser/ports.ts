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
  readonly vaapiRenderNode: string | null;
}

export interface BrowserPageInfo {
  readonly url: string | null;
  readonly title: string | null;
}

// 仕様 06 §2.4: ページ監視の即時同期経路。ページ遷移・読み込み完了の CDP イベント種別。
export type PageNavigationEvent =
  | "frameNavigated"
  | "navigatedWithinDocument"
  | "load"
  | "domContentLoaded";

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
  setViewportSize(dimensions: AlignedDimensions): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  setPageInitScript(source: string): Promise<void>;
  // 接続ごとに 1 回登録する。null で解除（仕様 06 §2.4 の即時同期）。
  setPageEventListener(listener: ((event: PageNavigationEvent) => void) | null): void;
  getPageInfo(): Promise<BrowserPageInfo>;
}

export interface BrowserControlPort extends PowerBrowserPort {
  navigate(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  toggleFullscreen(): Promise<void>;
  setDisplayScale(scale: number): Promise<void>;
  resizeViewport(dimensions: AlignedDimensions): Promise<void>;
  getCurrentViewport(): AlignedDimensions;
  injectTouch(frame: TouchFrame): Promise<void>;
  injectText(text: string): Promise<void>;
  injectKey(key: SpecialKey): Promise<void>;
}
