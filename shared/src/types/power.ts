export const POWER_STATES = [
  "STOPPED",
  "STARTING",
  "ACTIVE",
  "BUFFER_HOLD",
  "SLEEP_PAUSED",
  "RESTARTING",
  "ERROR",
] as const;

export type PowerState = (typeof POWER_STATES)[number];

export interface PowerStatusSnapshot {
  readonly state: PowerState;
  readonly streamEpoch: number;
  readonly currentUrl: string | null;
  readonly currentTitle: string | null;
  readonly updatedAtMs: number;
}

export interface PowerActionResult {
  readonly ok: boolean;
  readonly state: PowerState;
  readonly streamEpoch: number;
}
