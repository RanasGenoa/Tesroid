import type { BufferedMediaEntry } from "./ports.js";

export interface RingBufferStats {
  readonly entryCount: number;
  readonly totalBytes: number;
  readonly usageRatio: number;
  readonly latestMediaPtsUs: bigint | null;
  readonly oldestMediaPtsUs: bigint | null;
}

export interface RingBufferConfig {
  readonly maxSeconds: number;
  readonly maxBytes: number;
}

export class MediaRingBuffer {
  // Spec: docs/specs/03-streaming-transport.md#2.4
  constructor(config: RingBufferConfig) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  push(entry: BufferedMediaEntry, isConfig: boolean): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  getVideoConfig(): BufferedMediaEntry | null {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  getAudioConfig(): BufferedMediaEntry | null {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  sliceFromKeyframe(targetPtsUs: bigint, maxLookbackMs: number): readonly BufferedMediaEntry[] {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  clear(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  getStats(): RingBufferStats {
    throw new Error("NOT_IMPLEMENTED");
  }
}
