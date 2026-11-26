export interface VideoDecoderCallbacks {
  readonly onFrame: (frame: VideoFrame, streamEpoch: number) => void;
  readonly onDecoderError: (error: Error) => void;
  readonly onNeedsReset: () => void;
}

export class VideoDecoderPipeline {
  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  constructor(callbacks: VideoDecoderCallbacks) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  configure(avccConfigBytes: Uint8Array, streamEpoch: number): Promise<boolean> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  decode(avccPayload: Uint8Array, ptsUs: number, isKeyframe: boolean, streamEpoch: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  getDecodeQueueSize(): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  getMaxQueueLimit(targetFps: number): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  reset(newStreamEpoch: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#3
  dispose(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}

export class Canvas2DRenderer {
  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  attach(canvas: HTMLCanvasElement): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  renderFrame(frame: VideoFrame): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  clear(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  dispose(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
