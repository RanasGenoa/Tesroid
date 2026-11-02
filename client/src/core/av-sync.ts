export class AvSyncController {
  private lastVideoPts: number = 0;
  private lastAudioPts: number = 0;
  private lastAudioScheduledTime: number = 0;
  private baseVideoPts: number | null = null;
  private baseAudioPts: number | null = null;

  // Audio playback clock tracking (maps WebAudio context.currentTime <-> Audio PTS)
  private audioAnchorContextTimeSec: number = 0;
  private audioAnchorPtsUs: number = 0;
  private audioContextTimeProvider?: () => number | null;
  private videoPausedForBuffering: boolean = false;

  public setAudioContextTimeProvider(provider: () => number | null): void {
    this.audioContextTimeProvider = provider;
  }

  public setVideoBuffering(isBuffering: boolean): void {
    this.videoPausedForBuffering = isBuffering;
  }

  public isVideoBuffering(): boolean {
    return this.videoPausedForBuffering;
  }

  public updateVideoPts(ptsUs: number): void {
    if (this.baseVideoPts === null && ptsUs > 0) {
      this.baseVideoPts = ptsUs;
    }
    this.lastVideoPts = ptsUs;
  }

  /**
   * Called when an AudioBufferSourceNode is scheduled to start at `scheduledContextTimeSec` (in AudioContext seconds).
   */
  public updateAudioPts(ptsUs: number, scheduledAudioTime?: number): void {
    if (this.baseAudioPts === null && ptsUs > 0) {
      this.baseAudioPts = ptsUs;
    }
    this.lastAudioPts = ptsUs;
    const schedTime = scheduledAudioTime ?? performance.now();
    this.lastAudioScheduledTime = schedTime;

    // If scheduledAudioTime is in AudioContext seconds (small number compared to performance.now() or provider exists)
    if (scheduledAudioTime !== undefined) {
      this.audioAnchorContextTimeSec = scheduledAudioTime;
      this.audioAnchorPtsUs = ptsUs;
    }
  }

  /**
   * Returns the exact Audio PTS (in microseconds) that is currently playing out of the speakers right now.
   * Returns null if audio is not actively playing.
   */
  public getCurrentPlayingAudioPtsUs(): number | null {
    if (!this.audioContextTimeProvider || this.audioAnchorPtsUs <= 0) {
      return null;
    }
    const nowCtxSec = this.audioContextTimeProvider();
    if (nowCtxSec === null || nowCtxSec <= 0) {
      return null;
    }
    const deltaSec = nowCtxSec - this.audioAnchorContextTimeSec;
    // If the anchor is more than 2 seconds in the past with no new audio packets, audio stream is idle/silent
    if (deltaSec > 1.5 || deltaSec < -10.0) {
      return null;
    }
    return Math.round(this.audioAnchorPtsUs + deltaSec * 1_000_000);
  }

  public reset(): void {
    this.lastVideoPts = 0;
    this.lastAudioPts = 0;
    this.baseVideoPts = null;
    this.baseAudioPts = null;
    this.lastAudioScheduledTime = 0;
    this.audioAnchorContextTimeSec = 0;
    this.audioAnchorPtsUs = 0;
    this.videoPausedForBuffering = false;
  }

  /**
   * Audio is master clock: always returns 1.0x native playback rate.
   * Audio must never be pitch-shifted or rate-altered.
   */
  public getPlaybackRate(): number {
    return 1.0;
  }

  public getLastAudioPts(): number {
    return this.lastAudioPts;
  }

  public getLastVideoPts(): number {
    return this.lastVideoPts;
  }

  public getLastAudioScheduledTime(): number {
    return this.lastAudioScheduledTime;
  }

  public getDriftMs(): number {
    // Prefer real-time speaker playout PTS when available
    const playingAudioPts = this.getCurrentPlayingAudioPtsUs();
    if (playingAudioPts !== null && this.lastVideoPts > 0) {
      const realDriftMs = (this.lastVideoPts - playingAudioPts) / 1000;
      if (Math.abs(realDriftMs) <= 5000) {
        return Math.round(realDriftMs);
      }
    }

    if (this.baseVideoPts === null || this.baseAudioPts === null) return 0;
    const videoElapsed = this.lastVideoPts - this.baseVideoPts;
    const audioElapsed = this.lastAudioPts - this.baseAudioPts;
    const driftMs = (videoElapsed - audioElapsed) / 1000;

    // If drift is wildly out of bounds (e.g. PTS wrap, reconnect), realign baselines
    if (Math.abs(driftMs) > 2000) {
      this.baseVideoPts = this.lastVideoPts;
      this.baseAudioPts = this.lastAudioPts;
      return 0;
    }
    return Math.round(driftMs);
  }
}
