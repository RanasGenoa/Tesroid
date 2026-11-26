import {
  CATCHUP_FLOW_CONSTANTS,
  type CatchupFlowProfile,
  calculateCatchupFlowProfile,
} from "@tesroid/shared";
import type { Clock, TimerHandle } from "../../infra/index.js";
import type { BufferedMediaEntry } from "./ports.js";

const MAX_BURST_FRAMES_PER_TICK = 16;

export interface CatchupDrainSample {
  readonly renderedPtsUs: number;
  readonly nowMs: number;
}

export interface CatchupPacerDeps {
  readonly clock: Clock;
}

export class CatchupPacer {
  private readonly clock: Clock;
  private readonly queue: BufferedMediaEntry[] = [];
  private active = false;
  private targetBufferMs = 0;
  private drainRate = 1;
  private consecutiveStalls = 0;
  private lastSample: CatchupDrainSample | null = null;
  private pumpTimer: TimerHandle | null = null;
  private onEmit: ((entry: BufferedMediaEntry) => boolean) | null = null;
  private onDrained: (() => void) | null = null;

  // Spec: docs/specs/03-streaming-transport.md#2.4
  constructor(deps: CatchupPacerDeps) {
    this.clock = deps.clock;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  start(
    initialEntries: readonly BufferedMediaEntry[],
    targetBufferMs: number,
    onEmit: (entry: BufferedMediaEntry) => boolean,
    onDrained: () => void,
  ): void {
    this.flush();
    this.targetBufferMs = Math.max(0, Math.round(targetBufferMs));
    this.onEmit = onEmit;
    this.onDrained = onDrained;
    this.active = true;
    for (const entry of initialEntries) {
      this.queue.push(entry);
    }
    this.trimExcessBacklog();

    if (this.queue.length === 0) {
      this.finishDrain();
      return;
    }
    this.pump();
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  enqueue(entry: BufferedMediaEntry): void {
    if (!this.active) {
      return;
    }
    this.queue.push(entry);
    this.trimExcessBacklog();
    if (this.pumpTimer === null) {
      this.schedulePump();
    }
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  recordProgress(sample: CatchupDrainSample): void {
    if (!Number.isFinite(sample.renderedPtsUs) || !Number.isFinite(sample.nowMs)) {
      return;
    }
    if (this.lastSample === null) {
      this.lastSample = sample;
      return;
    }

    const elapsedMs = sample.nowMs - this.lastSample.nowMs;
    if (elapsedMs < CATCHUP_FLOW_CONSTANTS.progressWindowMinMs) {
      return;
    }
    if (elapsedMs > CATCHUP_FLOW_CONSTANTS.progressWindowMaxMs) {
      this.lastSample = sample;
      return;
    }

    const ptsDeltaMs = (sample.renderedPtsUs - this.lastSample.renderedPtsUs) / 1_000;
    const rawRate = Math.min(
      CATCHUP_FLOW_CONSTANTS.maxDrainRate,
      Math.max(0, ptsDeltaMs / elapsedMs),
    );
    const alpha = CATCHUP_FLOW_CONSTANTS.ewmaAlpha;
    this.drainRate = (1 - alpha) * this.drainRate + alpha * rawRate;
    this.lastSample = sample;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  recordSocketStall(): void {
    this.consecutiveStalls += 1;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  getFlowProfile(): CatchupFlowProfile {
    return calculateCatchupFlowProfile(this.targetBufferMs, this.drainRate, this.consecutiveStalls);
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  flush(): void {
    this.clearPumpTimer();
    this.queue.length = 0;
    this.active = false;
    this.drainRate = 1;
    this.consecutiveStalls = 0;
    this.lastSample = null;
    this.onEmit = null;
    this.onDrained = null;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  isDrained(): boolean {
    return this.queue.length === 0;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  getQueueSize(): number {
    return this.queue.length;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  getDrainRate(): number {
    return this.drainRate;
  }

  private pump(): void {
    this.clearPumpTimer();
    if (!this.active || this.onEmit === null) {
      return;
    }
    if (this.queue.length === 0) {
      this.finishDrain();
      return;
    }

    for (let sent = 0; sent < MAX_BURST_FRAMES_PER_TICK && this.queue.length > 0; sent += 1) {
      const head = this.queue[0];
      if (head === undefined) {
        break;
      }
      const emitted = this.onEmit(head);
      if (!emitted) {
        break;
      }
      this.queue.shift();
      this.consecutiveStalls = 0;
    }

    if (!this.active) {
      return;
    }
    if (this.queue.length === 0) {
      this.finishDrain();
      return;
    }
    this.schedulePump();
  }

  private schedulePump(): void {
    if (!this.active || this.pumpTimer !== null) {
      return;
    }
    const intervalMs = this.getFlowProfile().burstIntervalMs;
    this.pumpTimer = this.clock.setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, intervalMs);
  }

  private finishDrain(): void {
    const drained = this.onDrained;
    this.clearPumpTimer();
    this.active = false;
    this.onEmit = null;
    this.onDrained = null;
    drained?.();
  }

  private clearPumpTimer(): void {
    if (this.pumpTimer !== null) {
      this.clock.clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
  }

  private trimExcessBacklog(): void {
    const maxDurationUs = BigInt(Math.max(2 * this.targetBufferMs, 30_000)) * 1_000n;
    while (this.queue.length > 0) {
      const oldest = this.queue[0];
      const latest = this.queue[this.queue.length - 1];
      const overFrameCap = this.queue.length > CATCHUP_FLOW_CONSTANTS.maxQueueFrames;
      const overDuration =
        oldest !== undefined && latest !== undefined && latest.ptsUs - oldest.ptsUs > maxDurationUs;

      if (!overFrameCap && !overDuration) {
        break;
      }

      let firstKeyframeIndex = -1;
      let secondKeyframeIndex = -1;
      for (let i = 0; i < this.queue.length; i += 1) {
        const entry = this.queue[i];
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
        this.queue.splice(0, secondKeyframeIndex);
        continue;
      }
      if (firstKeyframeIndex > 0) {
        this.queue.splice(0, firstKeyframeIndex);
        continue;
      }
      if (overFrameCap) {
        this.queue.shift();
        continue;
      }
      break;
    }
  }
}
