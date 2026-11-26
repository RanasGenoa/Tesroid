import type { AuthServicePort, PasswordHasher, TokenGenerator } from "../domains/auth/ports.js";
import type { BrowserControlPort, CdpClientPort, X11InputPort } from "../domains/browser/ports.js";
import type { EncoderControlPort, GpuHardwareProbePort } from "../domains/encoder/ports.js";
import type { MetricsServicePort, TelemetryServicePort } from "../domains/observability/ports.js";
import type { PowerControllerPort } from "../domains/power/ports.js";
import type { SessionServicePort } from "../domains/session/ports.js";
import type { SettingsRepository } from "../domains/settings/ports.js";
import type { StreamingControlPort } from "../domains/streaming/ports.js";
import type {
  AtomicJsonStore,
  Clock,
  JsonlStore,
  ProcessExitPort,
  ProcessRunner,
  ProcessTreeController,
  ServerEnvConfig,
} from "../infra/index.js";
import type { ServerCoordinator } from "./coordinator.js";

export interface AppContainerOverrides {
  readonly clock?: Clock;
  readonly jsonStore?: AtomicJsonStore;
  readonly jsonlStore?: JsonlStore;
  readonly processRunner?: ProcessRunner;
  readonly processTree?: ProcessTreeController;
  readonly processExit?: ProcessExitPort;
  readonly cdp?: CdpClientPort;
  readonly x11?: X11InputPort;
  readonly gpuProbe?: GpuHardwareProbePort;
  readonly passwordHasher?: PasswordHasher;
  readonly tokenGenerator?: TokenGenerator;
}

export interface AppContainer {
  readonly env: ServerEnvConfig;
  readonly clock: Clock;
  readonly settings: SettingsRepository;
  readonly auth: AuthServicePort;
  readonly session: SessionServicePort;
  readonly browser: BrowserControlPort;
  readonly encoder: EncoderControlPort;
  readonly streaming: StreamingControlPort;
  readonly power: PowerControllerPort;
  readonly metrics: MetricsServicePort;
  readonly telemetry: TelemetryServicePort;
  readonly coordinator: ServerCoordinator;
  dispose(): Promise<void>;
}

// Spec: docs/architecture.md#1.2
export function createAppContainer(
  env: ServerEnvConfig,
  overrides?: AppContainerOverrides,
): AppContainer {
  throw new Error("NOT_IMPLEMENTED");
}
