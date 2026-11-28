import { STREAM_BOUNDS } from "../settings/constants.js";

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
  // セカンダリ参加時: プライマリがライブ端よりこの値以上後方を視聴中なら、プライマリ確認済み PTS 付近から追っかけ開始（仕様 02 §2.2）。
  secondaryJoinCatchupMinLagMs: 300,
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
  triggerOccupancyRatio: 0.85,
  resumeOccupancyRatio: 0.1,
  defaultExpireMinutes: 10,
  minExpireMinutes: 1,
} as const;

export interface LiveWatermarks {
  readonly highWaterBytes: number;
  readonly lowWaterBytes: number;
}

export interface CatchupFlowProfile {
  readonly congested: boolean;
  readonly effectiveWindowMs: number;
  readonly socketGuardBytes: number;
  readonly burstIntervalMs: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// Spec: docs/specs/03-streaming-transport.md#2.3
export function calculateLiveWatermarks(videoBitrateBps: number): LiveWatermarks {
  const rawHighBytes =
    Number.isFinite(videoBitrateBps) && videoBitrateBps > 0
      ? Math.round((videoBitrateBps / 8) * LIVE_HYSTERESIS_BOUNDS.windowSeconds)
      : 0;
  const highWaterBytes = clamp(
    rawHighBytes,
    LIVE_HYSTERESIS_BOUNDS.minHighWaterBytes,
    LIVE_HYSTERESIS_BOUNDS.maxHighWaterBytes,
  );
  const lowWaterBytes = Math.max(
    LIVE_HYSTERESIS_BOUNDS.minLowWaterBytes,
    Math.round(highWaterBytes * LIVE_HYSTERESIS_BOUNDS.lowWaterRatio),
  );
  return { highWaterBytes, lowWaterBytes };
}

export interface UnconsumedOccupancyInput {
  readonly latestGeneratedPtsUs: bigint | null;
  readonly primaryConfirmedPtsUs: bigint | null;
  readonly unconsumedBytes: number;
  readonly maxSeconds: number;
  readonly maxBytes: number;
}

// Spec: docs/specs/03-streaming-transport.md#2.4
export function calculateBufferHoldOccupancy(input: UnconsumedOccupancyInput): number {
  if (input.primaryConfirmedPtsUs === null || input.latestGeneratedPtsUs === null) {
    return 0;
  }
  const maxDurationUs = nonNegativeFinite(input.maxSeconds) * 1_000_000;
  const maxByteCap = nonNegativeFinite(input.maxBytes);
  const unconsumedDurationUs =
    input.latestGeneratedPtsUs > input.primaryConfirmedPtsUs
      ? Number(input.latestGeneratedPtsUs - input.primaryConfirmedPtsUs)
      : 0;
  const timeRatio = maxDurationUs > 0 ? unconsumedDurationUs / maxDurationUs : 0;
  const byteRatio = maxByteCap > 0 ? nonNegativeFinite(input.unconsumedBytes) / maxByteCap : 0;
  return Math.max(0, timeRatio, byteRatio);
}

// Spec: docs/specs/03-streaming-transport.md#2.4
export function calculateCatchupFlowProfile(
  targetBufferMs: number,
  drainRate: number,
  consecutiveStalls: number,
): CatchupFlowProfile {
  const baseTarget = Math.max(
    CATCHUP_FLOW_CONSTANTS.minWindowMs,
    Math.round(nonNegativeFinite(targetBufferMs)),
  );
  const clampedRate = Number.isFinite(drainRate)
    ? clamp(drainRate, 0, CATCHUP_FLOW_CONSTANTS.maxDrainRate)
    : 1;
  const stalls = Number.isFinite(consecutiveStalls)
    ? Math.max(0, Math.floor(consecutiveStalls))
    : 0;

  const congested =
    clampedRate < CATCHUP_FLOW_CONSTANTS.drainRateCongestionThreshold ||
    stalls >= CATCHUP_FLOW_CONSTANTS.consecutiveStallThreshold;

  if (!congested) {
    return {
      congested: false,
      effectiveWindowMs: baseTarget,
      socketGuardBytes: CATCHUP_FLOW_CONSTANTS.healthySocketGuardBytes,
      burstIntervalMs: CATCHUP_FLOW_CONSTANTS.healthyBurstIntervalMs,
    };
  }

  const effectiveWindowMs = Math.min(
    baseTarget,
    Math.max(CATCHUP_FLOW_CONSTANTS.minCongestedWindowMs, Math.round(baseTarget * clampedRate)),
  );

  const minGuard = CATCHUP_FLOW_CONSTANTS.congestedSocketGuardMinBytes;
  const maxGuard = CATCHUP_FLOW_CONSTANTS.congestedSocketGuardMaxBytes;
  const socketGuardBytes =
    stalls >= CATCHUP_FLOW_CONSTANTS.consecutiveStallThreshold
      ? minGuard
      : clamp(
          Math.round(
            minGuard +
              (maxGuard - minGuard) *
                clamp(clampedRate / CATCHUP_FLOW_CONSTANTS.drainRateCongestionThreshold, 0, 1),
          ),
          minGuard,
          maxGuard,
        );

  return {
    congested: true,
    effectiveWindowMs,
    socketGuardBytes,
    burstIntervalMs: CATCHUP_FLOW_CONSTANTS.congestedBurstIntervalMs,
  };
}

// Spec: docs/specs/03-streaming-transport.md#2.6
export function calculateServerRemainingBufferMs(
  serverLagMs: number,
  clientVideoBufferedMs: number,
  clientAudioBufferedMs: number,
): number {
  const lag = nonNegativeFinite(serverLagMs);
  const videoBuf = nonNegativeFinite(clientVideoBufferedMs);
  const audioBuf = nonNegativeFinite(clientAudioBufferedMs);
  return Math.max(0, lag - Math.max(videoBuf, audioBuf));
}

// Spec: docs/specs/10-power-lifecycle.md#2.4
export function calculateAutoSleepDelayMs(autoSleepMinutes: number): number | null {
  if (!Number.isFinite(autoSleepMinutes) || autoSleepMinutes <= 0) {
    return null;
  }

  return Math.max(STREAM_BOUNDS.autoSleepMinutes.minDelayMs, Math.round(autoSleepMinutes * 60_000));
}
