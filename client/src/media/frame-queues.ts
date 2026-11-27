import { CATCHUP_FLOW_CONSTANTS, STREAM_BOUNDS } from "@tesroid/shared";
import type { VideoFrameLike } from "./ports.js";

export interface QueuedVideoFrame {
  readonly streamEpoch: number;
  readonly ptsUs: number;
  readonly frame: VideoFrameLike;
  readonly receivedAtMs: number;
}

export interface QueueBufferMetrics {
  readonly count: number;
  readonly bufferedMs: number;
  readonly estimatedBytes: number;
}

const DEFAULT_LIVE_QUEUE_MAX_FRAMES = 16;

function safeCloseFrame(frame: VideoFrameLike): void {
  try {
    frame.close();
  } catch {
    // Ignore close failures on already-closed browser frames.
  }
}

function estimateFrameBytes(frame: VideoFrameLike): number {
  if (typeof frame.allocationSize === "function") {
    try {
      const size = frame.allocationSize();
      if (Number.isFinite(size) && size > 0) {
        return size;
      }
    } catch {
      // Fallback to YUV420 size estimate when allocationSize is unavailable on detached frames.
    }
  }
  const pixels = Math.max(0, frame.codedWidth) * Math.max(0, frame.codedHeight);
  return Math.max(1, Math.round(pixels * 1.5));
}

function frameDurationMs(frame: VideoFrameLike): number {
  return frame.duration != null && Number.isFinite(frame.duration) && frame.duration > 0
    ? frame.duration / 1_000
    : 0;
}

function computeQueueBufferedMs(items: readonly QueuedVideoFrame[]): number {
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) {
    return 0;
  }
  if (items.length === 1) {
    return frameDurationMs(first.frame);
  }
  return Math.max(0, (last.ptsUs - first.ptsUs) / 1_000) + frameDurationMs(last.frame);
}

interface StoredQueueEntry {
  readonly item: QueuedVideoFrame;
  readonly bytes: number;
}

abstract class BaseVideoFrameQueue {
  protected readonly entries: StoredQueueEntry[] = [];
  protected estimatedBytes = 0;
  protected evictedCount = 0;

  peek(): QueuedVideoFrame | null {
    return this.entries[0]?.item ?? null;
  }

  shift(): QueuedVideoFrame | null {
    const head = this.entries.shift();
    if (head === undefined) {
      return null;
    }
    this.estimatedBytes = Math.max(0, this.estimatedBytes - head.bytes);
    return head.item;
  }

  dropOlderThan(minPtsUs: number): number {
    let dropped = 0;
    while (this.entries.length > 0) {
      const head = this.entries[0];
      if (head === undefined || head.item.ptsUs >= minPtsUs) {
        break;
      }
      this.entries.shift();
      this.estimatedBytes = Math.max(0, this.estimatedBytes - head.bytes);
      safeCloseFrame(head.item.frame);
      dropped += 1;
    }
    return dropped;
  }

  clearAndCloseAll(): void {
    for (const entry of this.entries) {
      safeCloseFrame(entry.item.frame);
    }
    this.entries.length = 0;
    this.estimatedBytes = 0;
  }

  consumeEvictedCount(): number {
    const count = this.evictedCount;
    this.evictedCount = 0;
    return count;
  }

  getMetrics(): QueueBufferMetrics {
    return {
      count: this.entries.length,
      bufferedMs: computeQueueBufferedMs(this.entries.map((entry) => entry.item)),
      estimatedBytes: this.estimatedBytes,
    };
  }

  protected evictHead(): void {
    const oldest = this.entries.shift();
    if (oldest === undefined) {
      return;
    }
    this.estimatedBytes = Math.max(0, this.estimatedBytes - oldest.bytes);
    safeCloseFrame(oldest.item.frame);
    this.evictedCount += 1;
  }
}

export class LiveVideoQueue extends BaseVideoFrameQueue {
  private readonly maxFrames: number;

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  constructor(maxFrames = DEFAULT_LIVE_QUEUE_MAX_FRAMES) {
    super();
    this.maxFrames =
      Number.isInteger(maxFrames) && maxFrames >= 1 ? maxFrames : DEFAULT_LIVE_QUEUE_MAX_FRAMES;
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  push(item: QueuedVideoFrame): void {
    const bytes = estimateFrameBytes(item.frame);
    this.entries.push({ item, bytes });
    this.estimatedBytes += bytes;
    while (this.entries.length > this.maxFrames) {
      this.evictHead();
    }
  }
}

export class CatchupVideoQueue extends BaseVideoFrameQueue {
  private readonly maxBytes: number;
  private readonly maxDurationMs: number;

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  constructor(
    maxBytes = CATCHUP_FLOW_CONSTANTS.ringBufferMaxBytes,
    maxDurationMs = STREAM_BOUNDS.targetBufferMs.max,
  ) {
    super();
    this.maxBytes =
      Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.round(maxBytes)
        : CATCHUP_FLOW_CONSTANTS.ringBufferMaxBytes;
    this.maxDurationMs =
      Number.isFinite(maxDurationMs) && maxDurationMs > 0
        ? Math.round(maxDurationMs)
        : STREAM_BOUNDS.targetBufferMs.max;
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  push(item: QueuedVideoFrame): void {
    const bytes = estimateFrameBytes(item.frame);
    if (bytes > this.maxBytes) {
      safeCloseFrame(item.frame);
      this.evictedCount += 1;
      return;
    }

    this.entries.push({ item, bytes });
    this.estimatedBytes += bytes;

    while (this.entries.length > 0) {
      const overBytes = this.estimatedBytes > this.maxBytes;
      const overDuration =
        this.entries.length > 1 &&
        computeQueueBufferedMs(this.entries.map((entry) => entry.item)) > this.maxDurationMs;
      if (!overBytes && !overDuration) {
        break;
      }
      this.evictHead();
    }
  }
}
