import type { PowerState } from "./power.js";

export const SESSION_ROLES = [
  "PRIMARY",
  "ACTING_PRIMARY",
  "SECONDARY_STREAMING",
  "SECONDARY_STANDBY",
] as const;

export type SessionRole = (typeof SESSION_ROLES)[number];

export type PrimaryPlaybackMode = "INTERACTIVE" | "LIVE" | "CATCHUP" | "BUFFER_HOLD";

export interface PrimarySyncMetadata {
  readonly primaryRenderedPts: number | null;
  readonly primaryFeedbackAgeMs: number | null;
  readonly primaryTargetBufferMs: number;
  readonly primaryMode: PrimaryPlaybackMode | null;
}

export interface AuthLockoutStatus {
  readonly consecutiveFailures: number;
  readonly isLocked: boolean;
  readonly remainingAttempts: number;
  readonly lastFailureAt: string | null;
}

export const AUTH_SECURITY_CONSTANTS = {
  maxConsecutiveFailures: 10,
  warningRemainingThreshold: 5,
  tokenBytes: 32,
  tokenHexLength: 64,
  tokenTtlMs: 86_400_000,
  tokenSweepIntervalMs: 600_000,
  lockoutShutdownDelayMs: 200,
  bcryptCost: 10,
} as const;

export interface SystemStatusResponse {
  readonly isSetupCompleted: boolean;
  readonly hasActiveSession: boolean;
  readonly powerState: PowerState;
  readonly consecutiveFailures: number;
  readonly isLocked: boolean;
  readonly remainingAttempts: number;
  readonly locale: string;
}
