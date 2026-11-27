import { CATCHUP_FLOW_CONSTANTS } from "@tesroid/shared";
import type { BufferedMediaEntry } from "./ports.js";

export interface RingBufferStats {
  readonly entryCount: number;
  readonly totalBytes: number;
  readonly usageRatio: number;
  readonly latestMediaPtsUs: bigint | null;
  readonly oldestMediaPtsUs: bigint | null;
}

export interface UnconsumedBufferStats {
  readonly unconsumedDurationMs: number;
  readonly unconsumedBytes: number;
}

export interface RingBufferConfig {
  readonly maxSeconds: number;
  readonly maxBytes: number;
}

export class MediaRingBuffer {
  private readonly maxSeconds: number;
  private readonly maxBytes: number;
  private readonly maxDurationUs: bigint;
  private readonly entries: BufferedMediaEntry[] = [];
  private totalBytes = 0;
  private videoConfig: BufferedMediaEntry | null = null;
  private audioConfig: BufferedMediaEntry | null = null;

  // Spec: docs/specs/03-streaming-transport.md#2.4
  constructor(config: RingBufferConfig) {
    this.maxSeconds =
      Number.isFinite(config.maxSeconds) && config.maxSeconds > 0
        ? config.maxSeconds
        : CATCHUP_FLOW_CONSTANTS.ringBufferMaxSeconds;
    this.maxBytes =
      Number.isFinite(config.maxBytes) && config.maxBytes > 0
        ? Math.round(config.maxBytes)
        : CATCHUP_FLOW_CONSTANTS.ringBufferMaxBytes;
    this.maxDurationUs = BigInt(Math.round(this.maxSeconds * 1_000_000));
  }

  getMaxSeconds(): number {
    return this.maxSeconds;
  }

  getMaxBytes(): number {
    return this.maxBytes;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  push(entry: BufferedMediaEntry, isConfig: boolean): void {
    if (isConfig) {
      if (entry.mediaType === "video") {
        this.videoConfig = entry;
      } else {
        this.audioConfig = entry;
      }
      return;
    }

    this.entries.push(entry);
    this.totalBytes += entry.frameBytes.byteLength;
    this.evictIfNeeded();
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  getVideoConfig(): BufferedMediaEntry | null {
    return this.videoConfig;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  getAudioConfig(): BufferedMediaEntry | null {
    return this.audioConfig;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  sliceFromKeyframe(targetPtsUs: bigint, maxLookbackMs: number): readonly BufferedMediaEntry[] {
    let firstKeyframeIndex = -1;
    let bestKeyframeIndex = -1;

    for (let i = 0; i < this.entries.length; i += 1) {
      const entry = this.entries[i];
      if (entry === undefined || entry.mediaType !== "video" || !entry.isKeyframe) {
        continue;
      }
      if (firstKeyframeIndex === -1) {
        firstKeyframeIndex = i;
      }
      if (entry.ptsUs <= targetPtsUs) {
        bestKeyframeIndex = i;
      }
    }

    if (firstKeyframeIndex === -1) {
      return [];
    }
    if (bestKeyframeIndex !== -1) {
      return this.entries.slice(bestKeyframeIndex);
    }

    const firstKeyframe = this.entries[firstKeyframeIndex];
    const maxLookbackUs = BigInt(Math.max(0, Math.round(maxLookbackMs))) * 1_000n;
    if (firstKeyframe !== undefined && firstKeyframe.ptsUs - targetPtsUs <= maxLookbackUs) {
      return this.entries.slice(firstKeyframeIndex);
    }
    return [];
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  getUnconsumedBytesAfter(confirmedPtsUs: bigint | null): number {
    if (confirmedPtsUs === null || this.entries.length === 0) {
      return 0;
    }
    let unconsumedBytes = 0;
    for (const entry of this.entries) {
      if (entry.ptsUs > confirmedPtsUs) {
        unconsumedBytes += entry.frameBytes.byteLength;
      }
    }
    return unconsumedBytes;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  getUnconsumedStats(confirmedPtsUs: bigint | null): UnconsumedBufferStats {
    if (confirmedPtsUs === null || this.entries.length === 0) {
      return { unconsumedDurationMs: 0, unconsumedBytes: 0 };
    }
    const latestMediaPtsUs = this.getStats().latestMediaPtsUs;
    if (latestMediaPtsUs === null) {
      return { unconsumedDurationMs: 0, unconsumedBytes: 0 };
    }
    return {
      unconsumedDurationMs: Math.max(0, Number(latestMediaPtsUs - confirmedPtsUs) / 1_000),
      unconsumedBytes: this.getUnconsumedBytesAfter(confirmedPtsUs),
    };
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  clear(): void {
    this.entries.length = 0;
    this.totalBytes = 0;
    this.videoConfig = null;
    this.audioConfig = null;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  getStats(): RingBufferStats {
    let oldestMediaPtsUs: bigint | null = null;
    let latestMediaPtsUs: bigint | null = null;
    for (const entry of this.entries) {
      if (oldestMediaPtsUs === null || entry.ptsUs < oldestMediaPtsUs) {
        oldestMediaPtsUs = entry.ptsUs;
      }
      if (latestMediaPtsUs === null || entry.ptsUs > latestMediaPtsUs) {
        latestMediaPtsUs = entry.ptsUs;
      }
    }
    const byteRatio = this.maxBytes > 0 ? this.totalBytes / this.maxBytes : 0;
    const durationUs =
      oldestMediaPtsUs !== null && latestMediaPtsUs !== null
        ? Math.max(0, Number(latestMediaPtsUs - oldestMediaPtsUs))
        : 0;
    const timeRatio = this.maxSeconds > 0 ? durationUs / (this.maxSeconds * 1_000_000) : 0;

    return {
      entryCount: this.entries.length,
      totalBytes: this.totalBytes,
      usageRatio: Math.max(byteRatio, timeRatio),
      latestMediaPtsUs,
      oldestMediaPtsUs,
    };
  }

  private evictIfNeeded(): void {
    while (this.entries.length > 0) {
      const oldest = this.entries[0];
      const latest = this.entries[this.entries.length - 1];
      const overBytes = this.totalBytes > this.maxBytes;
      const overDuration =
        oldest !== undefined &&
        latest !== undefined &&
        latest.ptsUs - oldest.ptsUs > this.maxDurationUs;

      if (!overBytes && !overDuration) {
        break;
      }

      let firstKeyframeIndex = -1;
      let secondKeyframeIndex = -1;
      for (let i = 0; i < this.entries.length; i += 1) {
        const entry = this.entries[i];
        if (entry === undefined || entry.mediaType !== "video" || !entry.isKeyframe) {
          continue;
        }
        if (firstKeyframeIndex === -1) {
          firstKeyframeIndex = i;
        } else {
          secondKeyframeIndex = i;
          break;
        }
      }

      if (secondKeyframeIndex !== -1) {
        this.dropPrefix(secondKeyframeIndex);
        continue;
      }
      if (firstKeyframeIndex > 0) {
        this.dropPrefix(firstKeyframeIndex);
        continue;
      }
      if (firstKeyframeIndex === -1) {
        this.dropPrefix(1);
        continue;
      }
      // Protect the single latest in-progress GOP from partial eviction.
      break;
    }
  }

  private dropPrefix(count: number): void {
    const removed = this.entries.splice(0, count);
    for (const entry of removed) {
      this.totalBytes -= entry.frameBytes.byteLength;
    }
    if (this.totalBytes < 0) {
      this.totalBytes = 0;
    }
  }
}
