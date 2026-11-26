import type { PrimarySyncMetadata } from "@tesroid/shared";
import type { MasterClockSnapshot } from "./ports.js";

export type FrameSyncAction = "RENDER_NOW" | "WAIT" | "DROP_LATE";

export interface FrameSyncEvaluation {
  readonly action: FrameSyncAction;
  readonly waitMs: number;
  readonly signedDriftMs: number;
}

export interface JitterState {
  readonly adaptiveDelayMs: number;
  readonly stallCushionMs: number;
  readonly isBuffering: boolean;
}

export class MasterSyncClock {
  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  updateLocalAudioClock(audioPlaybackPtsUs: number, nowMs: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.4
  updateSecondaryPrimaryRef(metadata: PrimarySyncMetadata, nowMs: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  recordVideoArrival(nowMs: number, audioRunning: boolean): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  recordRttSample(rttMs: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  evaluateVideoFrame(videoPtsUs: number, nowMs: number): FrameSyncEvaluation {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  computeSignedAvDriftMs(videoPtsUs: number, audioPtsUs: number): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  getMasterClockSnapshot(nowMs: number): MasterClockSnapshot {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  getJitterState(): JitterState {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  reset(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
