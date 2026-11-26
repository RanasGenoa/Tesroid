import type {
  HealthResponse,
  PowerActionResult,
  PublicAppSettings,
  SettingsUpdateInput,
  SetupRequestInput,
  SystemStatusResponse,
} from "@tesroid/shared";
import type { AuthServicePort } from "../domains/auth/ports.js";
import type { BrowserControlPort } from "../domains/browser/ports.js";
import type { EncoderControlPort } from "../domains/encoder/ports.js";
import type { MetricsServicePort, TelemetryServicePort } from "../domains/observability/ports.js";
import type { PowerControllerPort } from "../domains/power/ports.js";
import type {
  SessionConnectionId,
  SessionServicePort,
  SessionTransportPort,
} from "../domains/session/ports.js";
import type { SettingsRepository } from "../domains/settings/ports.js";
import type { StreamingControlPort } from "../domains/streaming/ports.js";
import type { Clock, ServerEnvConfig } from "../infra/index.js";

export interface CoordinatorDeps {
  readonly clock: Clock;
  readonly env: ServerEnvConfig;
  readonly settings: SettingsRepository;
  readonly auth: AuthServicePort;
  readonly session: SessionServicePort;
  readonly browser: BrowserControlPort;
  readonly encoder: EncoderControlPort;
  readonly streaming: StreamingControlPort;
  readonly power: PowerControllerPort;
  readonly metrics: MetricsServicePort;
  readonly telemetry: TelemetryServicePort;
}

export class ServerCoordinator {
  // Spec: docs/architecture.md#1.2
  constructor(deps: CoordinatorDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  initialize(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  getSystemStatus(): SystemStatusResponse {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.3
  completeSetup(input: SetupRequestInput): Promise<PublicAppSettings> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  updateSettings(patch: SettingsUpdateInput): Promise<PublicAppSettings> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.5
  resetStream(): Promise<PowerActionResult> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  handleWsOpen(transport: SessionTransportPort): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  handleWsBinaryMessage(connectionId: SessionConnectionId, payload: Uint8Array): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  handleWsClose(connectionId: SessionConnectionId, closeCode: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  getHealthStatus(): HealthResponse {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  dispose(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
}
