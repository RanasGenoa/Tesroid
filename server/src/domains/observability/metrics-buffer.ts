import { type ClientMetricsSample, METRICS_LIMITS, type MetricsSummary } from "@tesroid/shared";
import type { MetricsServicePort } from "./ports.js";

const EMPTY_SUMMARY: MetricsSummary = {
  sampleCount: 0,
  durationSec: 0,
  currentFps: 0,
  avgFps: 0,
  minFps: 0,
  maxFps: 0,
  avgRttMs: 0,
  maxRttMs: 0,
  totalDroppedFrames: 0,
  totalDecoderErrors: 0,
  avgBitrateKbps: 0,
  avgAvDriftMs: 0,
  minAvDriftMs: 0,
  maxAvDriftMs: 0,
  lastUpdated: null,
};

export class MetricsRingBuffer implements MetricsServicePort {
  private readonly maxEntries: number;
  private readonly samples: ClientMetricsSample[] = [];

  // Spec: docs/specs/08-observability.md#2.1
  constructor(maxEntries: number = METRICS_LIMITS.maxHistoryEntries) {
    this.maxEntries =
      Number.isInteger(maxEntries) && maxEntries >= 1
        ? maxEntries
        : METRICS_LIMITS.maxHistoryEntries;
  }

  // Spec: docs/specs/08-observability.md#2.1
  recordSample(sample: ClientMetricsSample): void {
    this.samples.push({ ...sample });
    if (this.samples.length > this.maxEntries) {
      this.samples.shift();
    }
  }

  // Spec: docs/specs/08-observability.md#2.1
  getSummary(): MetricsSummary {
    const count = this.samples.length;
    if (count === 0) {
      return EMPTY_SUMMARY;
    }

    const latest = this.samples[count - 1];
    if (latest === undefined) {
      return EMPTY_SUMMARY;
    }

    let totalWindowMs = 0;
    let sumFps = 0;
    let minFps = Number.POSITIVE_INFINITY;
    let maxFps = Number.NEGATIVE_INFINITY;
    let sumRttMs = 0;
    let maxRttMs = Number.NEGATIVE_INFINITY;
    let totalDroppedFrames = 0;
    let totalDecoderErrors = 0;
    let sumBitrateKbps = 0;
    let sumAvDriftMs = 0;
    let minAvDriftMs = Number.POSITIVE_INFINITY;
    let maxAvDriftMs = Number.NEGATIVE_INFINITY;

    for (const sample of this.samples) {
      totalWindowMs += Math.max(0, sample.windowMs);
      sumFps += sample.fps;
      if (sample.minFps < minFps) {
        minFps = sample.minFps;
      }
      if (sample.maxFps > maxFps) {
        maxFps = sample.maxFps;
      }
      sumRttMs += sample.rttMs;
      if (sample.rttMs > maxRttMs) {
        maxRttMs = sample.rttMs;
      }
      totalDroppedFrames += sample.droppedFrames;
      totalDecoderErrors += sample.decoderErrors;
      sumBitrateKbps += sample.bitrateKbps;
      sumAvDriftMs += sample.avDriftMs;
      if (sample.avDriftMs < minAvDriftMs) {
        minAvDriftMs = sample.avDriftMs;
      }
      if (sample.avDriftMs > maxAvDriftMs) {
        maxAvDriftMs = sample.avDriftMs;
      }
    }

    return {
      sampleCount: count,
      durationSec: totalWindowMs / 1_000,
      currentFps: latest.fps,
      avgFps: sumFps / count,
      minFps,
      maxFps,
      avgRttMs: sumRttMs / count,
      maxRttMs,
      totalDroppedFrames,
      totalDecoderErrors,
      avgBitrateKbps: sumBitrateKbps / count,
      avgAvDriftMs: sumAvDriftMs / count,
      minAvDriftMs,
      maxAvDriftMs,
      lastUpdated: new Date(latest.timestamp).toISOString(),
    };
  }

  // Spec: docs/specs/08-observability.md#2.1
  getHistory(limit?: number): readonly ClientMetricsSample[] {
    const sanitized =
      limit === undefined || !Number.isFinite(limit) || limit < 1
        ? METRICS_LIMITS.defaultHistoryLimit
        : Math.min(this.maxEntries, Math.floor(limit));
    return this.samples.slice(-sanitized).map((sample) => ({ ...sample }));
  }

  // Spec: docs/specs/08-observability.md#2.1
  clear(): void {
    this.samples.length = 0;
  }
}
