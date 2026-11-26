export interface QueuedVideoFrame {
  readonly streamEpoch: number;
  readonly ptsUs: number;
  readonly frame: VideoFrame;
  readonly receivedAtMs: number;
}

export interface QueueBufferMetrics {
  readonly count: number;
  readonly bufferedMs: number;
  readonly estimatedBytes: number;
}

export class LiveVideoQueue {
  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  push(item: QueuedVideoFrame): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  peek(): QueuedVideoFrame | null {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  shift(): QueuedVideoFrame | null {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  dropOlderThan(minPtsUs: number): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  clearAndCloseAll(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  getMetrics(): QueueBufferMetrics {
    throw new Error("NOT_IMPLEMENTED");
  }
}

export class CatchupVideoQueue {
  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  constructor(maxBytes?: number) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  push(item: QueuedVideoFrame): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  peek(): QueuedVideoFrame | null {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  shift(): QueuedVideoFrame | null {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  clearAndCloseAll(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  getMetrics(): QueueBufferMetrics {
    throw new Error("NOT_IMPLEMENTED");
  }
}
