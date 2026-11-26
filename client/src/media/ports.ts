import type {
  MediaFrame,
  PrimarySyncMetadata,
  StreamingEvent,
  StreamingState,
} from "@tesroid/shared";

export interface PlaybackStatsSnapshot {
  readonly renderedFps: number;
  readonly isStaticScreen: boolean;
  readonly localVideoBufferedMs: number;
  readonly localAudioBufferedMs: number;
  readonly avDriftMs: number;
  readonly decodeQueueSize: number;
  readonly droppedFramesDelta: number;
  readonly decoderErrorsDelta: number;
  readonly frameRenderTimeMs: number | null;
  readonly waitingForKeyframe: boolean;
}

export interface MasterClockSnapshot {
  readonly audioPlaybackPtsUs: number | null;
  readonly source: "LOCAL_AUDIO" | "PRIMARY_REF" | "NONE";
  readonly valid: boolean;
}

export interface PlaybackControllerPort {
  attachCanvas(canvas: HTMLCanvasElement): void;
  getStreamingState(): StreamingState;
  dispatchStreamingEvent(event: StreamingEvent): void;
  handleMediaFrame(frame: MediaFrame): void;
  updatePrimarySyncRef(metadata: PrimarySyncMetadata): void;
  setTargetFps(fps: number): void;
  setTargetBufferMs(targetBufferMs: number): void;
  setAudioEnabled(enabled: boolean): void;
  unlockAudioOnGesture(): Promise<void>;
  resetForNewEpoch(newStreamEpoch: number): void;
  getStatsSnapshot(): PlaybackStatsSnapshot;
  dispose(): void;
}
