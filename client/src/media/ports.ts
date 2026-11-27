import type {
  MediaFrame,
  PrimarySyncMetadata,
  StreamingEvent,
  StreamingState,
  TelemetryCategory,
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

export interface VideoFrameLike {
  readonly timestamp: number;
  readonly duration?: number | null;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  allocationSize?(): number;
  close(): void;
}

export interface AudioDataLike {
  readonly format: AudioSampleFormat | null;
  readonly sampleRate: number;
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly timestamp: number;
  copyTo(destination: AllowSharedBufferSource, options: AudioDataCopyToOptions): void;
  close(): void;
}

export interface Canvas2DContextLike {
  fillStyle: string | CanvasGradient | CanvasPattern;
  drawImage(image: VideoFrameLike, dx: number, dy: number, dw: number, dh: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

export interface CanvasElementLike {
  width: number;
  height: number;
  getContext(
    contextId: "2d",
    options?: CanvasRenderingContext2DSettings,
  ): Canvas2DContextLike | null;
}

export interface VideoDecoderConfigProbe {
  readonly codec: string;
  readonly description: Uint8Array<ArrayBuffer>;
  readonly hardwareAcceleration?: HardwareAcceleration;
  readonly optimizeForLatency?: boolean;
}

export interface VideoDecoderAdapter {
  readonly state: string;
  readonly decodeQueueSize: number;
  configure(config: VideoDecoderConfigProbe): void;
  decode(payload: Uint8Array, timestampUs: number, isKeyframe: boolean): void;
  close(): void;
}

export interface VideoDecoderFactory {
  isConfigSupported(config: VideoDecoderConfigProbe): Promise<boolean>;
  create(callbacks: {
    readonly onOutput: (frame: VideoFrameLike) => void;
    readonly onError: (error: Error) => void;
  }): VideoDecoderAdapter;
}

export interface AudioDecoderConfigSpec {
  readonly codec: "opus";
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly description?: Uint8Array<ArrayBuffer>;
}

export interface AudioDecoderAdapter {
  readonly state: string;
  readonly decodeQueueSize: number;
  configure(config: AudioDecoderConfigSpec): void;
  decode(payload: Uint8Array, timestampUs: number): void;
  close(): void;
}

export interface AudioDecoderFactory {
  isConfigSupported(config: AudioDecoderConfigSpec): Promise<boolean>;
  create(callbacks: {
    readonly onOutput: (data: AudioDataLike) => void;
    readonly onError: (error: Error) => void;
  }): AudioDecoderAdapter;
}

export interface AudioGainParamLike {
  value: number;
  setValueAtTime?(value: number, startTime: number): unknown;
}

export interface AudioGainNodeLike {
  readonly gain: AudioGainParamLike;
  connect(destination: unknown): void;
  disconnect?(): void;
}

export interface AudioBufferLike {
  readonly duration: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  copyToChannel(source: Float32Array<ArrayBuffer>, channelNumber: number): void;
}

export interface AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null;
  readonly playbackRate: AudioGainParamLike;
  connect(destination: AudioGainNodeLike): void;
  disconnect?(): void;
  start(when?: number): void;
  stop(when?: number): void;
  onended: (() => void) | null;
}

export interface AudioContextLike {
  readonly state: AudioContextState;
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createGain(): AudioGainNodeLike;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceNodeLike;
}

export type AudioContextFactory = (options: {
  readonly latencyHint: "interactive";
  readonly sampleRate: number;
}) => AudioContextLike;

// Spec: docs/specs/08-observability.md#2.1
// 再生エンジンの観測事象を app 層のメトリクス/テレメトリへ橋渡しする狭い Port。
export interface PlaybackObserverPort {
  onFrameRendered(renderDurationMs: number): void;
  onDroppedFrames(count: number): void;
  onDecoderError(): void;
  emitTelemetry(
    category: TelemetryCategory,
    event: string,
    data?: Record<string, unknown> | undefined,
  ): void;
  recordThrottledSync(event: string, data?: Record<string, unknown> | undefined): void;
}

export interface PlaybackControllerPort {
  attachCanvas(canvas: CanvasElementLike): void;
  getStreamingState(): StreamingState;
  dispatchStreamingEvent(event: StreamingEvent): void;
  handleMediaFrame(frame: MediaFrame): void;
  updatePrimarySyncRef(metadata: PrimarySyncMetadata): void;
  setTargetFps(fps: number): void;
  setTargetBufferMs(targetBufferMs: number): void;
  setPrimaryAuthority(isPrimary: boolean): void;
  setAudioEnabled(enabled: boolean): void;
  unlockAudioOnGesture(): Promise<void>;
  resetForNewEpoch(newStreamEpoch: number): void;
  getStatsSnapshot(): PlaybackStatsSnapshot;
  dispose(): void;
}
