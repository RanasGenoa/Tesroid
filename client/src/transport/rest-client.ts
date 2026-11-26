import type {
  ClientMetricsSample,
  HealthResponse,
  MetricsSummary,
  PowerActionResult,
  PowerStatusSnapshot,
  PublicAppSettings,
  SettingsUpdateInput,
  SetupRequestInput,
  SystemStatusResponse,
  TelemetrySessionSummary,
} from "@tesroid/shared";
import type { PinVerifyApiResponse, RestApiClientPort, RestApiResult } from "./ports.js";

export class FetchRestApiClient implements RestApiClientPort {
  // Spec: docs/specs/01-auth-security.md#2.1
  constructor(baseUrl?: string) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  setToken(token: string | null): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  getStatus(): Promise<RestApiResult<SystemStatusResponse>> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  getHealth(): Promise<RestApiResult<HealthResponse>> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.3
  completeSetup(input: SetupRequestInput): Promise<RestApiResult<PublicAppSettings>> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  verifyPin(pin: string): Promise<RestApiResult<PinVerifyApiResponse>> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  getSettings(): Promise<RestApiResult<PublicAppSettings>> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  updateSettings(patch: SettingsUpdateInput): Promise<RestApiResult<PublicAppSettings>> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  getPowerStatus(): Promise<RestApiResult<PowerStatusSnapshot>> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  sleepPower(): Promise<RestApiResult<PowerActionResult>> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  resumePower(): Promise<RestApiResult<PowerActionResult>> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  restartBrowser(): Promise<RestApiResult<PowerActionResult>> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.5
  resetStream(): Promise<RestApiResult<PowerActionResult>> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  getMetricsSummary(): Promise<RestApiResult<MetricsSummary>> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  getMetricsHistory(limit?: number): Promise<RestApiResult<readonly ClientMetricsSample[]>> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  listTelemetrySessions(): Promise<RestApiResult<readonly TelemetrySessionSummary[]>> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  deleteTelemetrySessions(): Promise<RestApiResult<{ readonly ok: boolean }>> {
    throw new Error("NOT_IMPLEMENTED");
  }
}
