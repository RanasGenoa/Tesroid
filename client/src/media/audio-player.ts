export const AUDIO_PLAYER_CONSTANTS = {
  sampleRate: 48_000,
  channels: 2,
  defaultGain: 0.88,
  declickFadeMs: 1,
  initialCushionMs: 160,
  underrunGapMs: 40,
  underrunRebufferMs: 80,
  scheduleLookaheadMs: 25,
  maxScheduleLookaheadMs: 500,
  maxBufferedMs: 45_000,
} as const;

export class AudioPlayerPipeline {
  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  unlock(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  configure(opusHeadBytes: Uint8Array, streamEpoch: number): Promise<boolean> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  decode(opusPayload: Uint8Array, ptsUs: number, streamEpoch: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  setMuted(muted: boolean): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  setGain(gain: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  setAdaptiveDelayMs(delayMs: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  setHoldForVideoBuffering(holding: boolean): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  getPlaybackPtsUs(): number | null {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  getBufferedMs(): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  resetForNewEpoch(newStreamEpoch: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  dispose(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
