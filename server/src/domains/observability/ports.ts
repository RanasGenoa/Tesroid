import type {
  ClientMetricsSample,
  MetricsSummary,
  TelemetryEventInput,
  TelemetrySessionSummary,
} from "@tesroid/shared";

export interface MetricsServicePort {
  recordSample(sample: ClientMetricsSample): void;
  getSummary(): MetricsSummary;
  getHistory(limit?: number): readonly ClientMetricsSample[];
  clear(): void;
}

export interface TelemetryServicePort {
  initialize(): Promise<void>;
  getCurrentSessionId(): string;
  appendBatch(events: readonly TelemetryEventInput[]): Promise<number>;
  listSessions(): Promise<readonly TelemetrySessionSummary[]>;
  readSessionNdjson(sessionId: string): Promise<string | null>;
  readLatestSessionNdjson(): Promise<{
    readonly sessionId: string;
    readonly content: string;
  } | null>;
  deleteAllSessions(): Promise<void>;
}
