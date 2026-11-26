import type { PowerActionResult, PowerState, PowerStatusSnapshot } from "@tesroid/shared";

export interface PowerBrowserPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  freezeTree(): Promise<void>;
  resumeTree(): Promise<void>;
  restartBrowser(): Promise<void>;
  setMonitoringPaused(paused: boolean): void;
  getCurrentPageInfo(): { readonly url: string | null; readonly title: string | null };
}

export interface PowerEncoderPort {
  ensureDualRunning(): Promise<void>;
  stopAll(): Promise<void>;
  advanceEpochAndResetClock(): number;
  pauseWithTimelineComp(): Promise<void>;
  clearTimelineComp(): void;
  getCurrentEpoch(): number;
}

export interface PowerStreamingPort {
  clearBufferAndQueues(): void;
  broadcastPowerState(state: PowerState, streamEpoch: number): void;
  onPowerSleep(): void;
  onPowerHoldEntered(atMs: number): void;
  onPowerHoldExited(newStreamEpoch: number): void;
}

export interface PowerSessionPort {
  hasActivePrimaryOrActing(): boolean;
  demoteAllStreamingToStandby(streamEpoch: number): void;
  promoteStandbyToStreaming(streamEpoch: number): void;
}

export type HoldExitReason = "DRAINED" | "INTERACTION" | "NEW_PRIMARY" | "LIVE_FALLBACK" | "RESET";

export interface PowerControllerPort {
  getStatus(): PowerStatusSnapshot;
  ensureActive(): Promise<PowerActionResult>;
  sleep(): Promise<PowerActionResult>;
  resume(): Promise<PowerActionResult>;
  restartBrowser(): Promise<PowerActionResult>;
  enterBufferHold(): Promise<PowerActionResult>;
  exitBufferHold(reason: HoldExitReason): Promise<PowerActionResult>;
  onPrimaryConnected(options?: { readonly preserveBufferHold?: boolean }): Promise<void>;
  onPrimaryDisconnected(): void;
  dispose(): void;
}
