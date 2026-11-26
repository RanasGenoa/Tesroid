import type { TelemetryEventInput, TelemetrySessionSummary } from "@tesroid/shared";
import type { Clock, JsonlStore } from "../../infra/index.js";
import type { SettingsRepository } from "../settings/ports.js";
import type { TelemetryServicePort } from "./ports.js";

export interface TelemetryStoreDeps {
  readonly clock: Clock;
  readonly settings: SettingsRepository;
  readonly jsonlStore: JsonlStore;
  readonly logDir: string;
}

// Spec: docs/specs/08-observability.md#3
export function sanitizeTelemetrySessionId(sessionId: string): string | null {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/08-observability.md#2.2
export function isValidTelemetryEvent(value: unknown): value is TelemetryEventInput {
  throw new Error("NOT_IMPLEMENTED");
}

export class TelemetryStore implements TelemetryServicePort {
  // Spec: docs/specs/08-observability.md#2.2
  constructor(deps: TelemetryStoreDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  initialize(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  getCurrentSessionId(): string {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  appendBatch(events: readonly TelemetryEventInput[]): Promise<number> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  listSessions(): Promise<readonly TelemetrySessionSummary[]> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  readSessionNdjson(sessionId: string): Promise<string | null> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  readLatestSessionNdjson(): Promise<{
    readonly sessionId: string;
    readonly content: string;
  } | null> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  deleteAllSessions(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
}
