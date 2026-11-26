import type { ClientMetricsSample, MetricsSummary } from "@tesroid/shared";
import type { MetricsServicePort } from "./ports.js";

export class MetricsRingBuffer implements MetricsServicePort {
  // Spec: docs/specs/08-observability.md#2.1
  recordSample(sample: ClientMetricsSample): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  getSummary(): MetricsSummary {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  getHistory(limit?: number): readonly ClientMetricsSample[] {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  clear(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
