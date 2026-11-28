import {
  type ClientMetricsSample,
  encodeMetricsFrame,
  METRICS_LIMITS,
  PROTOCOL_TIMING,
} from "@tesroid/shared";
import {
  type ClientClock,
  type ClientTimerHandle,
  createBrowserClock,
  type WsTransportPort,
} from "../transport/ports.js";

export interface MetricsCollectorDeps {
  readonly transport: WsTransportPort;
  readonly clock?: ClientClock;
}

export const RTT_CONSTANTS = {
  ewmaAlpha: 0.3,
  minHistorySize: 8,
} as const;

export interface RttTrackerState {
  readonly ewmaRttMs: number | null;
  readonly minHistory: readonly number[];
  readonly lastValidAtMs: number | null;
}

// Spec: docs/specs/08-observability.md#2.1
export function computePercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (finiteValues.length === 0) {
    return 0;
  }
  const sorted = [...finiteValues].sort((a, b) => a - b);
  const clampedPercentile = Math.min(100, Math.max(0, percentile));
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((clampedPercentile / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

// Spec: docs/specs/03-streaming-transport.md#2.6
export function createRttTrackerState(): RttTrackerState {
  return {
    ewmaRttMs: null,
    minHistory: [],
    lastValidAtMs: null,
  };
}

// Spec: docs/specs/03-streaming-transport.md#2.6
export function recordRttMeasurement(
  state: RttTrackerState,
  rawRttMs: number,
  isLiveZeroQueue: boolean,
  nowMs: number,
): RttTrackerState {
  const isStale =
    state.lastValidAtMs !== null && nowMs - state.lastValidAtMs > PROTOCOL_TIMING.rttStaleTimeoutMs;
  const baseState = isStale ? createRttTrackerState() : state;

  if (!isLiveZeroQueue || !Number.isFinite(rawRttMs) || rawRttMs < 0) {
    return baseState;
  }

  const nextEwma =
    baseState.ewmaRttMs === null
      ? rawRttMs
      : (1 - RTT_CONSTANTS.ewmaAlpha) * baseState.ewmaRttMs + RTT_CONSTANTS.ewmaAlpha * rawRttMs;
  const nextHistory = [...baseState.minHistory, rawRttMs].slice(-RTT_CONSTANTS.minHistorySize);

  return {
    ewmaRttMs: nextEwma,
    minHistory: nextHistory,
    lastValidAtMs: nowMs,
  };
}

// Spec: docs/specs/03-streaming-transport.md#2.6
export function readEffectiveRttMs(state: RttTrackerState, nowMs: number): number {
  if (state.ewmaRttMs === null || state.lastValidAtMs === null) {
    return 0;
  }
  if (nowMs - state.lastValidAtMs > PROTOCOL_TIMING.rttStaleTimeoutMs) {
    return 0;
  }
  // 実効 RTT は最小値履歴窓 8 の最小値（輻輳スパイクを除外した回線基準値）。EWMA は内部平滑化のみに留める。
  if (state.minHistory.length > 0) {
    return Math.min(...state.minHistory);
  }
  return state.ewmaRttMs;
}

export class ClientMetricsCollector {
  private readonly deps: MetricsCollectorDeps;
  private readonly clock: ClientClock;

  private running = false;
  private flushTimer: ClientTimerHandle | null = null;
  private windowStartMs = 0;

  private renderedInWindow = 0;
  private totalRenderedFrames = 0;
  private droppedFrames = 0;
  private decoderErrors = 0;
  private videoPackets = 0;
  private videoBytes = 0;
  private audioPackets = 0;
  private frameTimes: number[] = [];
  private readonly secondBuckets = new Map<number, number>();

  private decodeQueueSize = 0;
  private avDriftMs = 0;
  private displayWidth = 0;
  private displayHeight = 0;
  private dpr = 1;
  private rttState: RttTrackerState = createRttTrackerState();

  // Spec: docs/specs/08-observability.md#2.1
  constructor(deps: MetricsCollectorDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? createBrowserClock();
    this.windowStartMs = this.clock.nowMs();
  }

  // Spec: docs/specs/08-observability.md#2.1
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.windowStartMs = this.clock.nowMs();
    this.armFlushTimer();
  }

  // Spec: docs/specs/08-observability.md#2.1
  stop(): void {
    this.running = false;
    if (this.flushTimer !== null) {
      this.clock.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // Spec: docs/specs/08-observability.md#2.1
  recordFrameRendered(renderDurationMs: number): void {
    this.renderedInWindow += 1;
    this.totalRenderedFrames += 1;
    const elapsedMs = Math.max(0, this.clock.nowMs() - this.windowStartMs);
    const secondBucket = Math.floor(elapsedMs / 1_000);
    this.secondBuckets.set(secondBucket, (this.secondBuckets.get(secondBucket) ?? 0) + 1);

    if (
      Number.isFinite(renderDurationMs) &&
      renderDurationMs >= 0 &&
      this.frameTimes.length < METRICS_LIMITS.maxFrameTimeSamples
    ) {
      this.frameTimes.push(renderDurationMs);
    }
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  recordDroppedFrames(count: number): void {
    if (Number.isFinite(count) && count > 0) {
      this.droppedFrames += count;
    }
  }

  // Spec: docs/specs/08-observability.md#2.1
  recordDecoderError(): void {
    this.decoderErrors += 1;
  }

  // Spec: docs/specs/08-observability.md#2.1
  recordVideoPacket(byteLength: number): void {
    this.videoPackets += 1;
    if (Number.isFinite(byteLength) && byteLength > 0) {
      this.videoBytes += byteLength;
    }
  }

  // Spec: docs/specs/08-observability.md#2.1
  recordAudioPacket(): void {
    this.audioPackets += 1;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.6
  recordRttSample(rawRttMs: number, isLiveZeroQueue: boolean): void {
    this.rttState = recordRttMeasurement(
      this.rttState,
      rawRttMs,
      isLiveZeroQueue,
      this.clock.nowMs(),
    );
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  setAvDriftMs(driftMs: number): void {
    if (Number.isFinite(driftMs)) {
      this.avDriftMs = driftMs;
    }
  }

  // Spec: docs/specs/08-observability.md#2.1
  setDecodeQueueSize(size: number): void {
    if (Number.isFinite(size) && size >= 0) {
      this.decodeQueueSize = size;
    }
  }

  // Spec: docs/specs/08-observability.md#2.1
  setViewportMetrics(width: number, height: number, dpr: number): void {
    if (Number.isFinite(width) && width >= 0) {
      this.displayWidth = width;
    }
    if (Number.isFinite(height) && height >= 0) {
      this.displayHeight = height;
    }
    if (Number.isFinite(dpr) && dpr > 0) {
      this.dpr = dpr;
    }
  }

  // Spec: docs/specs/03-streaming-transport.md#2.6
  getEffectiveRttMs(): number {
    const nowMs = this.clock.nowMs();
    const effective = readEffectiveRttMs(this.rttState, nowMs);
    if (effective === 0 && this.rttState.lastValidAtMs !== null) {
      this.rttState = createRttTrackerState();
    }
    return effective;
  }

  // Spec: docs/specs/08-observability.md#2.1
  flushWindow(): void {
    const nowMs = this.clock.nowMs();
    const windowMs = Math.max(0, nowMs - this.windowStartMs);
    const elapsedSec = windowMs / 1_000;
    const fps = elapsedSec > 0 ? this.renderedInWindow / elapsedSec : 0;

    let minFps = fps;
    let maxFps = fps;
    if (this.renderedInWindow === 0) {
      minFps = 0;
      maxFps = 0;
    } else if (this.secondBuckets.size > 1) {
      let bucketMin = Number.POSITIVE_INFINITY;
      let bucketMax = Number.NEGATIVE_INFINITY;
      for (const bucketCount of this.secondBuckets.values()) {
        if (bucketCount < bucketMin) {
          bucketMin = bucketCount;
        }
        if (bucketCount > bucketMax) {
          bucketMax = bucketCount;
        }
      }
      minFps = Math.min(fps, bucketMin);
      maxFps = Math.max(fps, bucketMax);
    }

    const bitrateKbps = elapsedSec > 0 ? (this.videoBytes * 8) / (elapsedSec * 1_000) : 0;

    const sample: ClientMetricsSample = {
      timestamp: nowMs,
      windowMs,
      fps,
      minFps,
      maxFps,
      droppedFrames: this.droppedFrames,
      decoderErrors: this.decoderErrors,
      totalRenderedFrames: this.totalRenderedFrames,
      videoPackets: this.videoPackets,
      videoBytes: this.videoBytes,
      audioPackets: this.audioPackets,
      bitrateKbps,
      frameTimeP50Ms: computePercentile(this.frameTimes, 50),
      frameTimeP95Ms: computePercentile(this.frameTimes, 95),
      decodeQueueSize: this.decodeQueueSize,
      rttMs: this.getEffectiveRttMs(),
      avDriftMs: this.avDriftMs,
      displayWidth: this.displayWidth,
      displayHeight: this.displayHeight,
      dpr: this.dpr,
    };

    this.windowStartMs = nowMs;
    this.renderedInWindow = 0;
    this.droppedFrames = 0;
    this.decoderErrors = 0;
    this.videoPackets = 0;
    this.videoBytes = 0;
    this.audioPackets = 0;
    this.frameTimes = [];
    this.secondBuckets.clear();

    const frame = encodeMetricsFrame(sample);
    this.deps.transport.sendBinary(frame);
  }

  private armFlushTimer(): void {
    if (!this.running) {
      return;
    }
    this.flushTimer = this.clock.setTimeout(() => {
      this.flushTimer = null;
      if (!this.running) {
        return;
      }
      this.flushWindow();
      this.armFlushTimer();
    }, METRICS_LIMITS.windowMs);
  }
}
