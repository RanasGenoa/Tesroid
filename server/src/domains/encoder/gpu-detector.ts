import type { EncoderBackend, EncoderMode } from "@tesroid/shared";
import type { GpuHardwareProbePort, GpuProbeResult } from "./ports.js";

export const ENCODER_RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

export const ENCODER_WATCHDOG_CONSTANTS = {
  videoStallTimeoutMs: 3_000,
  earlyCrashWindowMs: 5_000,
  sigtermGraceMs: 80,
  restartDelayMs: 100,
  audioRestartDelayMs: 1_000,
  nvencProbeTimeoutMs: 8_000,
  vaapiProbeTimeoutMs: 3_000,
} as const;

export interface FallbackLadderState {
  readonly mode: EncoderMode;
  readonly backend: EncoderBackend;
  readonly vaapiLowPower: boolean;
  readonly gpuColorConvert: boolean;
  readonly retryAttempt: number;
}

// Spec: docs/specs/05-encoder-gpu.md#2.2
export function detectBestEncoderBackend(
  mode: EncoderMode,
  probe: GpuHardwareProbePort,
  explicitVaapiDevice: string | null,
  explicitVaapiDriver: string | null,
): Promise<GpuProbeResult> {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/05-encoder-gpu.md#2.2
export function computeNextFallbackStep(
  state: FallbackLadderState,
  vaapiAvailable: boolean,
): FallbackLadderState | null {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/05-encoder-gpu.md#2.2
export function getEncoderRetryDelayMs(attempt: number): number {
  throw new Error("NOT_IMPLEMENTED");
}
