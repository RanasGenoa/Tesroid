import type { TelemetryCategory } from "@tesroid/shared";
import type { WsTransportPort } from "../transport/ports.js";

export interface TelemetryClientDeps {
  readonly transport: WsTransportPort;
}

export class ClientTelemetryReporter {
  // Spec: docs/specs/08-observability.md#2.2
  constructor(deps: TelemetryClientDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  setEnabled(enabled: boolean): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  isEnabled(): boolean {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  record(category: TelemetryCategory, event: string, data?: Record<string, unknown>): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  recordThrottledSync(event: string, data?: Record<string, unknown>): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  flush(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  dispose(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
