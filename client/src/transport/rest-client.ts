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
import type { FetchLike, PinVerifyApiResponse, RestApiClientPort, RestApiResult } from "./ports.js";

export interface FetchRestApiClientOptions {
  readonly fetchImpl?: FetchLike;
}

interface RequestOptions {
  readonly body?: unknown;
  readonly includeAuth?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class FetchRestApiClient implements RestApiClientPort {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private token: string | null = null;

  // Spec: docs/specs/01-auth-security.md#2.1
  constructor(baseUrl = "", options?: FetchRestApiClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options?.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  setToken(token: string | null): void {
    this.token = token !== null && token.length > 0 ? token : null;
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  getStatus(): Promise<RestApiResult<SystemStatusResponse>> {
    return this.request<SystemStatusResponse>("GET", "/api/status");
  }

  // Spec: docs/specs/08-observability.md#2.1
  getHealth(): Promise<RestApiResult<HealthResponse>> {
    return this.request<HealthResponse>("GET", "/api/health");
  }

  // Spec: docs/specs/01-auth-security.md#2.3
  completeSetup(input: SetupRequestInput): Promise<RestApiResult<PublicAppSettings>> {
    return this.request<PublicAppSettings>("POST", "/api/setup", { body: input });
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  verifyPin(pin: string): Promise<RestApiResult<PinVerifyApiResponse>> {
    return this.request<PinVerifyApiResponse>("POST", "/api/auth/verify", {
      body: { pin },
    });
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  getSettings(): Promise<RestApiResult<PublicAppSettings>> {
    return this.request<PublicAppSettings>("GET", "/api/settings", { includeAuth: true });
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  updateSettings(patch: SettingsUpdateInput): Promise<RestApiResult<PublicAppSettings>> {
    return this.request<PublicAppSettings>("PUT", "/api/settings", {
      body: patch,
      includeAuth: true,
    });
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  getPowerStatus(): Promise<RestApiResult<PowerStatusSnapshot>> {
    return this.request<PowerStatusSnapshot>("GET", "/api/power/status");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  sleepPower(): Promise<RestApiResult<PowerActionResult>> {
    return this.request<PowerActionResult>("POST", "/api/power/sleep", { includeAuth: true });
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  resumePower(): Promise<RestApiResult<PowerActionResult>> {
    return this.request<PowerActionResult>("POST", "/api/power/resume", { includeAuth: true });
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.2
  restartBrowser(): Promise<RestApiResult<PowerActionResult>> {
    return this.request<PowerActionResult>("POST", "/api/power/restart-browser", {
      includeAuth: true,
    });
  }

  // Spec: docs/specs/03-streaming-transport.md#2.5
  resetStream(): Promise<RestApiResult<PowerActionResult>> {
    return this.request<PowerActionResult>("POST", "/api/stream/reset", { includeAuth: true });
  }

  // Spec: docs/specs/08-observability.md#2.1
  getMetricsSummary(): Promise<RestApiResult<MetricsSummary>> {
    return this.request<MetricsSummary>("GET", "/api/metrics/summary", { includeAuth: true });
  }

  // Spec: docs/specs/08-observability.md#2.1
  getMetricsHistory(limit?: number): Promise<RestApiResult<readonly ClientMetricsSample[]>> {
    const query =
      limit !== undefined && Number.isFinite(limit) ? `?limit=${Math.floor(limit)}` : "";
    return this.request<readonly ClientMetricsSample[]>("GET", `/api/metrics/history${query}`, {
      includeAuth: true,
    });
  }

  // Spec: docs/specs/08-observability.md#2.2
  listTelemetrySessions(): Promise<RestApiResult<readonly TelemetrySessionSummary[]>> {
    return this.request<readonly TelemetrySessionSummary[]>("GET", "/api/telemetry/sessions", {
      includeAuth: true,
    });
  }

  // Spec: docs/specs/08-observability.md#2.2
  deleteTelemetrySessions(): Promise<RestApiResult<{ readonly ok: boolean }>> {
    return this.request<{ readonly ok: boolean }>("DELETE", "/api/telemetry/sessions", {
      includeAuth: true,
    });
  }

  private async request<T>(
    method: string,
    path: string,
    options?: RequestOptions,
  ): Promise<RestApiResult<T>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    let serializedBody: string | undefined;
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      serializedBody = JSON.stringify(options.body);
    }

    if (options?.includeAuth && this.token !== null) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(serializedBody !== undefined ? { body: serializedBody } : {}),
      });
    } catch (error) {
      return {
        ok: false,
        status: 0,
        error: error instanceof Error ? error.message : "Network error",
        code: "NETWORK_ERROR",
      };
    }

    let rawText = "";
    try {
      rawText = await response.text();
    } catch {
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        code: "READ_ERROR",
      };
    }

    let parsed: unknown;
    if (rawText.length > 0) {
      try {
        parsed = JSON.parse(rawText) as unknown;
      } catch {
        parsed = undefined;
      }
    }

    if (response.ok) {
      if (parsed === undefined) {
        return {
          ok: false,
          status: response.status,
          error: "Invalid JSON response",
          code: "INVALID_JSON",
        };
      }
      return {
        ok: true,
        status: response.status,
        data: parsed as T,
      };
    }

    const record = isRecord(parsed) ? parsed : null;
    const error =
      record !== null && typeof record.error === "string" && record.error.length > 0
        ? record.error
        : `HTTP ${response.status}`;
    const code =
      record !== null && typeof record.code === "string" && record.code.length > 0
        ? record.code
        : undefined;

    return {
      ok: false,
      status: response.status,
      error,
      ...(code !== undefined ? { code } : {}),
      ...(parsed !== undefined ? { data: parsed as T } : {}),
    };
  }
}
