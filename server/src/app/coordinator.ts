import {
  expandSetupQualityPreset,
  type HealthResponse,
  type PowerActionResult,
  type PublicAppSettings,
  type SettingsUpdateInput,
  type SetupRequestInput,
  type SystemStatusResponse,
  toPublicSettings,
  validateSettingsUpdate,
  validateSetupRequest,
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
import { SettingsDomainError } from "../domains/settings/errors.js";
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
  private readonly deps: CoordinatorDeps;

  // Spec: docs/architecture.md#1.2
  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  async initialize(): Promise<void> {
    await this.deps.auth.assertNotLockedAtStartup();
    await this.deps.settings.load();
    this.deps.auth.startTokenSweep();
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  getSystemStatus(): SystemStatusResponse {
    const currentSettings = this.deps.settings.getCurrent();
    const lockout = this.deps.auth.getLockoutStatus();
    return {
      isSetupCompleted: currentSettings.isSetupCompleted,
      hasActiveSession: this.deps.session.hasActivePrimaryOrActing(),
      powerState: this.deps.power.getStatus().state,
      consecutiveFailures: lockout.consecutiveFailures,
      isLocked: lockout.isLocked,
      remainingAttempts: lockout.remainingAttempts,
      locale: this.deps.env.locale,
    };
  }

  // Spec: docs/specs/01-auth-security.md#2.3
  async completeSetup(input: SetupRequestInput): Promise<PublicAppSettings> {
    if (this.deps.settings.getCurrent().isSetupCompleted) {
      throw new SettingsDomainError(
        "SETUP_ALREADY_COMPLETED",
        "Initial setup is already completed",
        403,
      );
    }

    const validation = validateSetupRequest(input);
    if (!validation.ok) {
      throw new SettingsDomainError("INVALID_SETUP_INPUT", validation.message, 400);
    }

    const pinHash = await this.deps.auth.hashPin(validation.value.pin);
    const streamPatch =
      validation.value.qualityPreset !== null
        ? expandSetupQualityPreset(
            validation.value.qualityPreset,
            this.deps.encoder.getActiveBackend(),
          )
        : undefined;

    const saved = await this.deps.settings.completeSetup({
      pinHash,
      timezone: validation.value.timezone,
      streamPatch,
    });
    await this.deps.auth.resetLockout();

    // Isolate live-apply failures so persisted setup completion still returns HTTP 200.
    try {
      await this.deps.browser.setDisplayScale(saved.stream.displayScale);
    } catch {
      // Isolated per Spec 01 §2.3.
    }
    try {
      await this.deps.encoder.applySettingsUpdate({
        videoChanged: true,
        audioChanged: true,
        dimensionsChanged: true,
      });
    } catch {
      // Isolated per Spec 01 §2.3.
    }

    return toPublicSettings(saved);
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  async updateSettings(patch: SettingsUpdateInput): Promise<PublicAppSettings> {
    const prev = this.deps.settings.getCurrent();
    const backend = this.deps.encoder.getActiveBackend();
    const validation = validateSettingsUpdate(patch, backend);
    if (!validation.ok) {
      if (validation.code === "DUPLICATE_FAVORITE_URL") {
        throw new SettingsDomainError("DUPLICATE_FAVORITE_URL", validation.message, 400);
      }
      if (
        validation.code === "INVALID_FAVORITE" ||
        validation.code === "FAVORITES_LIMIT_EXCEEDED" ||
        validation.code === "INVALID_URL_SCHEME"
      ) {
        throw new SettingsDomainError("INVALID_FAVORITE", validation.message, 400);
      }
      throw new SettingsDomainError("INVALID_SETTINGS_UPDATE", validation.message, 400);
    }

    const pinHash =
      validation.value.pin !== undefined
        ? await this.deps.auth.hashPin(validation.value.pin)
        : undefined;
    const saved = await this.deps.settings.updateSettings(validation.value, {
      backend,
      pinHash,
    });

    if (pinHash !== undefined) {
      await this.deps.auth.resetLockout();
      this.deps.auth.revokeAllTokens();
    }

    if (saved.stream.displayScale !== prev.stream.displayScale) {
      try {
        await this.deps.browser.setDisplayScale(saved.stream.displayScale);
      } catch {
        // Live browser zoom failure must not roll back persisted settings.
      }
    }

    const dimensionsChanged =
      saved.stream.maxSize !== prev.stream.maxSize ||
      saved.stream.clientProfile.active !== prev.stream.clientProfile.active ||
      saved.stream.clientProfile.custom.scale !== prev.stream.clientProfile.custom.scale;
    const videoChanged =
      dimensionsChanged ||
      saved.stream.fps !== prev.stream.fps ||
      saved.stream.videoBitrate !== prev.stream.videoBitrate ||
      saved.stream.preset !== prev.stream.preset ||
      saved.stream.x264Preset !== prev.stream.x264Preset ||
      saved.stream.vaapi.compressionLevel !== prev.stream.vaapi.compressionLevel ||
      saved.stream.vaapi.lowPower !== prev.stream.vaapi.lowPower ||
      saved.stream.vaapi.gpuColorConvert !== prev.stream.vaapi.gpuColorConvert;
    const audioChanged = saved.stream.audioBitrate !== prev.stream.audioBitrate;

    if (videoChanged || audioChanged || dimensionsChanged) {
      try {
        await this.deps.encoder.applySettingsUpdate({
          videoChanged,
          audioChanged,
          dimensionsChanged,
        });
      } catch {
        // Live encoder reconfiguration failure must not roll back persisted settings.
      }
    }

    return toPublicSettings(saved);
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
  async dispose(): Promise<void> {
    this.deps.auth.stopTokenSweep();
  }
}
