import type { PowerState } from "./power.js";

export const TELEMETRY_CATEGORIES = [
  "av_sync",
  "buffering",
  "decoder",
  "pacer",
  "audio",
  "network",
  "log",
] as const;

export type TelemetryCategory = (typeof TELEMETRY_CATEGORIES)[number];

export const TELEMETRY_LIMITS = {
  maxPayloadBytes: 512 * 1024,
  maxBatchEvents: 500,
  maxSessionFileBytes: 10 * 1024 * 1024,
  maxSessions: 15,
  flushIntervalMs: 1_000,
  syncThrottleMs: 500,
} as const;

export const METRICS_LIMITS = {
  windowMs: 10_000,
  maxHistoryEntries: 360,
  defaultHistoryLimit: 60,
  maxFrameTimeSamples: 1_200,
  serverStatsIntervalMs: 2_000,
} as const;

export interface ClientMetricsSample {
  readonly timestamp: number;
  readonly windowMs: number;
  readonly fps: number;
  readonly minFps: number;
  readonly maxFps: number;
  readonly droppedFrames: number;
  readonly decoderErrors: number;
  readonly totalRenderedFrames: number;
  readonly videoPackets: number;
  readonly videoBytes: number;
  readonly audioPackets: number;
  readonly bitrateKbps: number;
  readonly frameTimeP50Ms: number;
  readonly frameTimeP95Ms: number;
  readonly decodeQueueSize: number;
  readonly rttMs: number;
  readonly avDriftMs: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly dpr: number;
}

export interface ServerMetricsSnapshot {
  readonly timestamp: number;
  readonly encodeFps: number;
  readonly sendBitrateKbps: number;
  readonly audioPps: number;
  readonly powerState: PowerState;
}

export interface MetricsSummary {
  readonly sampleCount: number;
  readonly durationSec: number;
  readonly currentFps: number;
  readonly avgFps: number;
  readonly minFps: number;
  readonly maxFps: number;
  readonly avgRttMs: number;
  readonly maxRttMs: number;
  readonly totalDroppedFrames: number;
  readonly totalDecoderErrors: number;
  readonly avgBitrateKbps: number;
  readonly avgAvDriftMs: number;
  readonly minAvDriftMs: number;
  readonly maxAvDriftMs: number;
  readonly lastUpdated: string | null;
}

export interface TelemetryEventInput {
  readonly category: TelemetryCategory;
  readonly event: string;
  readonly timestamp?: number;
  readonly data?: Record<string, unknown>;
}

export type StoredTelemetryEvent = TelemetryEventInput & {
  readonly sessionId: string;
  readonly serverTimestamp: string;
};

export interface TelemetrySessionSummary {
  readonly sessionId: string;
  readonly sizeBytes: number;
  readonly lineCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
