import { PROTOCOL_TIMING, type PrimarySyncMetadata } from "@tesroid/shared";
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

export const SYNC_CLOCK_CONSTANTS = {
  minRenderIntervalMs: 8,
  lateDropThresholdMs: 45,
  renderEarlyToleranceMs: 8,
  jitterDropoutExcludeMs: 850,
  jitterSpreadThresholdMs: 90,
  adaptiveDelayMinMs: 60,
  adaptiveDelayMaxMs: 240,
  adaptiveRiseMaxMsPerFrame: 20,
  adaptiveDecayMsPerSec: 20,
  stallIntervalThresholdMs: 120,
  stallCushionStepMs: 90,
  stallCushionMinMs: 180,
  stallCushionMaxMs: 450,
  stallQuietFramesForDecay: 8,
  sampleWindowSize: 60,
  minJitterSamples: 4,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function computeSpreadMs(values: readonly number[]): number {
  if (values.length < SYNC_CLOCK_CONSTANTS.minJitterSamples) {
    return 0;
  }
  return Math.max(0, percentile(values, 95) - percentile(values, 50));
}

interface StoredPrimaryRef {
  readonly primaryRenderedPts: number;
  readonly primaryFeedbackAgeMs: number;
  readonly receivedAtMs: number;
}

export class MasterSyncClock {
  private localAudioPtsUs: number | null = null;
  private localAudioUpdatedAtMs: number | null = null;
  private primaryRef: StoredPrimaryRef | null = null;

  private videoAnchorPtsUs: number | null = null;
  private videoAnchorAtMs: number | null = null;
  private lastRenderAtMs: number | null = null;

  private lastVideoArrivalAtMs: number | null = null;
  private arrivalIntervalsMs: number[] = [];
  private rttSamplesMs: number[] = [];
  private lastRttMs: number | null = null;
  private adaptiveDelayMs = 0;
  private stallCushionMs = 0;
  private networkStallActive = false;
  private isBuffering = false;
  private bufferingStartedAtMs: number | null = null;
  private quietFrameStreak = 0;

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  updateLocalAudioClock(audioPlaybackPtsUs: number, nowMs: number): void {
    if (!Number.isFinite(audioPlaybackPtsUs) || !Number.isFinite(nowMs)) {
      return;
    }
    this.localAudioPtsUs = audioPlaybackPtsUs;
    this.localAudioUpdatedAtMs = nowMs;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.4
  updateSecondaryPrimaryRef(metadata: PrimarySyncMetadata, nowMs: number): void {
    if (
      metadata.primaryRenderedPts === null ||
      metadata.primaryFeedbackAgeMs === null ||
      !Number.isFinite(metadata.primaryRenderedPts) ||
      !Number.isFinite(metadata.primaryFeedbackAgeMs) ||
      !Number.isFinite(nowMs)
    ) {
      this.primaryRef = null;
      return;
    }
    this.primaryRef = {
      primaryRenderedPts: metadata.primaryRenderedPts,
      primaryFeedbackAgeMs: metadata.primaryFeedbackAgeMs,
      receivedAtMs: nowMs,
    };
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  recordVideoArrival(nowMs: number, audioRunning: boolean): void {
    if (!Number.isFinite(nowMs)) {
      return;
    }
    if (this.lastVideoArrivalAtMs === null) {
      this.lastVideoArrivalAtMs = nowMs;
      return;
    }

    const intervalMs = Math.max(0, nowMs - this.lastVideoArrivalAtMs);
    this.lastVideoArrivalAtMs = nowMs;

    if (intervalMs <= SYNC_CLOCK_CONSTANTS.jitterDropoutExcludeMs) {
      this.arrivalIntervalsMs.push(intervalMs);
      if (this.arrivalIntervalsMs.length > SYNC_CLOCK_CONSTANTS.sampleWindowSize) {
        this.arrivalIntervalsMs.shift();
      }
    }

    this.updateAdaptiveDelay(intervalMs);
    this.updateStallCushion(intervalMs, audioRunning);
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  recordRttSample(rttMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs < 0) {
      return;
    }
    this.rttSamplesMs.push(rttMs);
    if (this.rttSamplesMs.length > SYNC_CLOCK_CONSTANTS.sampleWindowSize) {
      this.rttSamplesMs.shift();
    }
    this.lastRttMs = rttMs;
  }

  // Spec: docs/specs/04-client-playback-avsync.md#4
  notifyVideoQueueEmpty(nowMs: number, audioRunning: boolean): void {
    // Static screen guard: ignore empty video queue while audio flows cleanly without active network stall.
    if (audioRunning && !this.networkStallActive) {
      this.isBuffering = false;
      this.bufferingStartedAtMs = null;
      return;
    }
    if (this.stallCushionMs <= 0) {
      return;
    }
    if (!this.isBuffering) {
      this.isBuffering = true;
      this.bufferingStartedAtMs = nowMs;
      return;
    }
    if (
      this.bufferingStartedAtMs !== null &&
      nowMs - this.bufferingStartedAtMs >= SYNC_CLOCK_CONSTANTS.stallCushionMaxMs
    ) {
      this.isBuffering = false;
      this.bufferingStartedAtMs = null;
    }
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  recordFrameRendered(videoPtsUs: number, nowMs: number): void {
    if (!Number.isFinite(nowMs) || !Number.isFinite(videoPtsUs)) {
      return;
    }
    this.lastRenderAtMs = nowMs;
    if (this.videoAnchorPtsUs === null || this.videoAnchorAtMs === null) {
      this.videoAnchorPtsUs = videoPtsUs;
      this.videoAnchorAtMs = nowMs;
    }
    this.isBuffering = false;
    this.bufferingStartedAtMs = null;
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  evaluateVideoFrame(videoPtsUs: number, nowMs: number): FrameSyncEvaluation {
    const master = this.getMasterClockSnapshot(nowMs);
    if (master.valid && master.audioPlaybackPtsUs !== null) {
      const signedDriftMs = this.computeSignedAvDriftMs(videoPtsUs, master.audioPlaybackPtsUs);
      if (signedDriftMs < -SYNC_CLOCK_CONSTANTS.lateDropThresholdMs) {
        return { action: "DROP_LATE", waitMs: 0, signedDriftMs };
      }
      if (signedDriftMs > SYNC_CLOCK_CONSTANTS.renderEarlyToleranceMs) {
        return { action: "WAIT", waitMs: signedDriftMs, signedDriftMs };
      }
      return this.applyMinRenderInterval(nowMs, signedDriftMs);
    }

    if (this.videoAnchorPtsUs === null || this.videoAnchorAtMs === null) {
      return { action: "RENDER_NOW", waitMs: 0, signedDriftMs: 0 };
    }
    const expectedNowPtsUs =
      this.videoAnchorPtsUs + Math.max(0, nowMs - this.videoAnchorAtMs) * 1_000;
    const deltaMs = (videoPtsUs - expectedNowPtsUs) / 1_000;
    if (deltaMs > SYNC_CLOCK_CONSTANTS.renderEarlyToleranceMs) {
      return { action: "WAIT", waitMs: deltaMs, signedDriftMs: 0 };
    }
    return this.applyMinRenderInterval(nowMs, 0);
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  computeSignedAvDriftMs(videoPtsUs: number, audioPtsUs: number): number {
    return (videoPtsUs - audioPtsUs) / 1_000;
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  getMasterClockSnapshot(nowMs: number): MasterClockSnapshot {
    if (this.localAudioPtsUs !== null && this.localAudioUpdatedAtMs !== null) {
      const elapsedMs = Math.max(0, nowMs - this.localAudioUpdatedAtMs);
      return {
        audioPlaybackPtsUs: this.localAudioPtsUs + elapsedMs * 1_000,
        source: "LOCAL_AUDIO",
        valid: true,
      };
    }

    if (this.primaryRef !== null) {
      const localOffsetMs = nowMs - this.primaryRef.receivedAtMs;
      const totalAgeMs = this.primaryRef.primaryFeedbackAgeMs + localOffsetMs;
      const validAge =
        this.primaryRef.primaryFeedbackAgeMs >= 0 &&
        this.primaryRef.primaryFeedbackAgeMs < PROTOCOL_TIMING.primaryFeedbackMaxAgeMs &&
        localOffsetMs >= PROTOCOL_TIMING.primaryFeedbackLocalOffsetMinMs &&
        localOffsetMs <= PROTOCOL_TIMING.primaryFeedbackLocalOffsetMaxMs &&
        totalAgeMs < PROTOCOL_TIMING.primaryFeedbackMaxAgeMs;
      if (validAge) {
        return {
          audioPlaybackPtsUs: this.primaryRef.primaryRenderedPts + totalAgeMs * 1_000,
          source: "PRIMARY_REF",
          valid: true,
        };
      }
    }

    return {
      audioPlaybackPtsUs: null,
      source: "NONE",
      valid: false,
    };
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  getJitterState(): JitterState {
    return {
      adaptiveDelayMs: this.adaptiveDelayMs,
      stallCushionMs: this.stallCushionMs,
      isBuffering: this.isBuffering,
    };
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  reset(): void {
    this.localAudioPtsUs = null;
    this.localAudioUpdatedAtMs = null;
    this.primaryRef = null;
    this.videoAnchorPtsUs = null;
    this.videoAnchorAtMs = null;
    this.lastRenderAtMs = null;
    this.lastVideoArrivalAtMs = null;
    this.arrivalIntervalsMs = [];
    this.rttSamplesMs = [];
    this.lastRttMs = null;
    this.adaptiveDelayMs = 0;
    this.stallCushionMs = 0;
    this.networkStallActive = false;
    this.isBuffering = false;
    this.bufferingStartedAtMs = null;
    this.quietFrameStreak = 0;
  }

  private applyMinRenderInterval(nowMs: number, signedDriftMs: number): FrameSyncEvaluation {
    if (this.lastRenderAtMs !== null) {
      const remaining = SYNC_CLOCK_CONSTANTS.minRenderIntervalMs - (nowMs - this.lastRenderAtMs);
      if (remaining > 0) {
        return { action: "WAIT", waitMs: remaining, signedDriftMs };
      }
    }
    return { action: "RENDER_NOW", waitMs: 0, signedDriftMs };
  }

  private updateAdaptiveDelay(intervalMs: number): void {
    const maxSpread = Math.max(
      computeSpreadMs(this.arrivalIntervalsMs),
      computeSpreadMs(this.rttSamplesMs),
    );
    const targetAdaptive =
      maxSpread >= SYNC_CLOCK_CONSTANTS.jitterSpreadThresholdMs
        ? clamp(
            Math.round(maxSpread),
            SYNC_CLOCK_CONSTANTS.adaptiveDelayMinMs,
            SYNC_CLOCK_CONSTANTS.adaptiveDelayMaxMs,
          )
        : 0;

    if (targetAdaptive > this.adaptiveDelayMs) {
      this.adaptiveDelayMs = Math.min(
        targetAdaptive,
        this.adaptiveDelayMs + SYNC_CLOCK_CONSTANTS.adaptiveRiseMaxMsPerFrame,
      );
    } else if (targetAdaptive < this.adaptiveDelayMs) {
      const decay = (SYNC_CLOCK_CONSTANTS.adaptiveDecayMsPerSec * intervalMs) / 1_000;
      this.adaptiveDelayMs = Math.max(targetAdaptive, this.adaptiveDelayMs - decay);
    }
  }

  private isOngoingTransferDelayIncreasing(): boolean {
    if (computeSpreadMs(this.rttSamplesMs) >= SYNC_CLOCK_CONSTANTS.jitterSpreadThresholdMs) {
      return true;
    }
    if (this.rttSamplesMs.length >= 2 && this.lastRttMs !== null) {
      const baselineRttMs = percentile(this.rttSamplesMs.slice(0, -1), 50);
      if (this.lastRttMs - baselineRttMs >= SYNC_CLOCK_CONSTANTS.jitterSpreadThresholdMs) {
        return true;
      }
    }
    return false;
  }

  private updateStallCushion(intervalMs: number, audioRunning: boolean): void {
    const transferDelayIncreasing = this.isOngoingTransferDelayIncreasing();
    if (
      intervalMs >= SYNC_CLOCK_CONSTANTS.stallIntervalThresholdMs &&
      (!audioRunning || transferDelayIncreasing)
    ) {
      this.quietFrameStreak = 0;
      this.networkStallActive = true;
      this.stallCushionMs =
        this.stallCushionMs === 0
          ? SYNC_CLOCK_CONSTANTS.stallCushionMinMs
          : Math.min(
              SYNC_CLOCK_CONSTANTS.stallCushionMaxMs,
              this.stallCushionMs + SYNC_CLOCK_CONSTANTS.stallCushionStepMs,
            );
      return;
    }

    if (intervalMs < SYNC_CLOCK_CONSTANTS.stallIntervalThresholdMs) {
      this.quietFrameStreak += 1;
      this.isBuffering = false;
      this.bufferingStartedAtMs = null;
      if (!transferDelayIncreasing) {
        this.networkStallActive = false;
      }
      if (
        this.quietFrameStreak >= SYNC_CLOCK_CONSTANTS.stallQuietFramesForDecay &&
        this.stallCushionMs > 0
      ) {
        const decay = (SYNC_CLOCK_CONSTANTS.adaptiveDecayMsPerSec * intervalMs) / 1_000;
        this.stallCushionMs = Math.max(0, this.stallCushionMs - decay);
      }
    }
  }
}
