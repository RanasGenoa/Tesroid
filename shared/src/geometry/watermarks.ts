export const LIVE_HYSTERESIS_BOUNDS = {
  windowSeconds: 3.0,
  minHighWaterBytes: 512 * 1024,
  maxHighWaterBytes: 1_536 * 1024,
  minLowWaterBytes: 96 * 1024,
  lowWaterRatio: 0.2,
  audioMaxBufferedBytes: 2 * 1024 * 1024,
} as const;

export const CATCHUP_FLOW_CONSTANTS = {
  ringBufferMaxSeconds: 60,
  ringBufferMaxBytes: 48 * 1024 * 1024,
  maxQueueFrames: 6_600,
  minWindowMs: 400,
  minCongestedWindowMs: 2_500,
  drainRateCongestionThreshold: 0.85,
  ewmaAlpha: 0.3,
  consecutiveStallThreshold: 3,
  healthySocketGuardBytes: 128 * 1024,
  congestedSocketGuardMinBytes: 32 * 1024,
  congestedSocketGuardMaxBytes: 64 * 1024,
  healthyBurstIntervalMs: 2,
  congestedBurstIntervalMs: 10,
  progressWindowMinMs: 250,
  progressWindowMaxMs: 5_000,
  maxDrainRate: 20,
  idleToBufferSeconds: 5,
  keyframeLookbackMaxMs: 5_000,
} as const;

export const BUFFER_HOLD_CONSTANTS = {
  minTriggerMs: 10_000,
  maxTriggerMs: 30_000,
  bufferUsageTriggerRatio: 0.85,
  hwResumeHeadroomMs: 2_000,
  swResumeHeadroomMs: 3_000,
  minHysteresisSpanMs: 7_200,
  defaultExpireMinutes: 10,
  minExpireMinutes: 1,
  autoSleepHoldMarginMs: 5_000,
} as const;

export interface LiveWatermarks {
  readonly highWaterBytes: number;
  readonly lowWaterBytes: number;
}

export interface BufferHoldThresholds {
  readonly enabled: boolean;
  readonly triggerMs: number;
  readonly resumeMs: number;
  readonly bufferUsageTriggerRatio: number;
}

export interface CatchupFlowProfile {
  readonly congested: boolean;
  readonly effectiveWindowMs: number;
  readonly socketGuardBytes: number;
  readonly burstIntervalMs: number;
}

// Spec: docs/specs/03-streaming-transport.md#2.3
export function calculateLiveWatermarks(videoBitrateBps: number): LiveWatermarks {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.4
export function calculateBufferHoldThresholds(
  targetBufferMs: number,
  isHardwareEncoder: boolean,
): BufferHoldThresholds {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.4
export function calculateCatchupFlowProfile(
  targetBufferMs: number,
  drainRate: number,
  consecutiveStalls: number,
): CatchupFlowProfile {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/03-streaming-transport.md#2.6
export function calculateServerRemainingBufferMs(
  serverLagMs: number,
  clientVideoBufferedMs: number,
  clientAudioBufferedMs: number,
): number {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/10-power-lifecycle.md#2.4
export function calculateAutoSleepDelayMs(
  autoSleepMinutes: number,
  holdTriggerMs: number | null,
): number | null {
  throw new Error("NOT_IMPLEMENTED");
}
