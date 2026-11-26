import {
  alignLayoutDimensions,
  CHANNEL_ID,
  decodeAuthFrame,
  decodeClientControlFrame,
  decodeResizeFrame,
  decodeTouchFrame,
  encodeServerControlFrame,
  expandSetupQualityPreset,
  type HealthResponse,
  type PowerActionResult,
  type PrimaryPlaybackMode,
  type PublicAppSettings,
  type SettingsUpdateInput,
  type SetupRequestInput,
  type SystemStatusResponse,
  toPublicSettings,
  validateSettingsUpdate,
  validateSetupRequest,
  WS_CLOSE_CODE,
} from "@tesroid/shared";
import type { AuthServicePort } from "../domains/auth/ports.js";
import type { BrowserControlPort } from "../domains/browser/ports.js";
import type { EncoderControlPort } from "../domains/encoder/ports.js";
import type { MetricsServicePort, TelemetryServicePort } from "../domains/observability/ports.js";
import type { PowerControllerPort } from "../domains/power/ports.js";
import type {
  ClientSessionRecord,
  SessionAuthOutcome,
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
  private readonly pendingTransports = new Map<SessionConnectionId, SessionTransportPort>();

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
  async resetStream(): Promise<PowerActionResult> {
    const state = this.deps.power.getStatus().state;
    if (state === "BUFFER_HOLD") {
      const result = await this.deps.power.exitBufferHold("RESET");
      this.deps.streaming.handleStreamReset(result.streamEpoch);
      return result;
    }
    if (state === "STOPPED" || state === "SLEEP_PAUSED") {
      const result = await this.deps.power.ensureActive();
      this.deps.streaming.handleStreamReset(result.streamEpoch);
      return result;
    }

    await this.deps.encoder.stopAll();
    this.deps.encoder.clearTimelineComp();
    this.deps.streaming.clearBufferAndQueues();
    const newEpoch = this.deps.encoder.advanceEpochAndResetClock();
    await this.deps.encoder.ensureDualRunning();
    this.deps.streaming.handleStreamReset(newEpoch);
    const nextState = this.deps.power.getStatus().state;
    this.deps.streaming.broadcastPowerState(nextState, newEpoch);
    return {
      ok: true,
      state: nextState,
      streamEpoch: newEpoch,
    };
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  handleWsOpen(transport: SessionTransportPort): void {
    this.pendingTransports.set(transport.id, transport);
    transport.sendBinary(
      encodeServerControlFrame({
        type: "AUTH_REQUIRED",
        isSetupCompleted: this.deps.settings.getCurrent().isSetupCompleted,
      }),
    );
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  async handleWsBinaryMessage(
    connectionId: SessionConnectionId,
    payload: Uint8Array,
  ): Promise<void> {
    if (payload.byteLength === 0) {
      return;
    }
    const channel = payload[0];

    if (channel === CHANNEL_ID.AUTH) {
      await this.handleWsAuthMessage(connectionId, payload);
      return;
    }

    const session = this.deps.session.getSession(connectionId);
    if (session === null) {
      const pending = this.pendingTransports.get(connectionId);
      if (pending !== undefined) {
        pending.sendBinary(
          encodeServerControlFrame({
            type: "AUTH_REQUIRED",
            isSetupCompleted: this.deps.settings.getCurrent().isSetupCompleted,
          }),
        );
      }
      return;
    }

    const isPrimaryAuthority = session.role === "PRIMARY" || session.role === "ACTING_PRIMARY";
    const isStandby = session.role === "SECONDARY_STANDBY";

    switch (channel) {
      case CHANNEL_ID.RESIZE: {
        if (!isPrimaryAuthority) {
          return;
        }
        try {
          const frame = decodeResizeFrame(payload);
          const aligned = alignLayoutDimensions({
            width: frame.width,
            height: frame.height,
            dpr: frame.dprX100 > 0 ? frame.dprX100 / 100 : undefined,
            maxSize: this.deps.settings.getCurrent().stream.maxSize,
          });
          await this.deps.browser.resizeViewport(aligned);
          await this.deps.encoder.reconfigureDimensions(aligned);
        } catch {
          // Ignore malformed resize frames or transient resize errors.
        }
        return;
      }
      case CHANNEL_ID.TOUCH: {
        if (isStandby) {
          return;
        }
        try {
          const frame = decodeTouchFrame(payload);
          this.deps.streaming.handleUserInteraction(this.deps.clock.nowMs());
          await this.deps.browser.injectTouch(frame);
        } catch {
          // Ignore malformed touch frames or transient input errors.
        }
        return;
      }
      case CHANNEL_ID.CONTROL_COMMAND: {
        await this.handleAuthenticatedControlMessage(
          session,
          payload,
          isPrimaryAuthority,
          isStandby,
        );
        return;
      }
      default:
        return;
    }
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  handleWsClose(connectionId: SessionConnectionId, closeCode: number): void {
    this.pendingTransports.delete(connectionId);
    if (this.deps.session.getSession(connectionId) === null) {
      return;
    }
    const outcome = this.deps.session.handleDisconnect(connectionId, closeCode);
    this.deps.streaming.handleSocketRemoved(connectionId);
    if (outcome.allPrimariesAbsent) {
      this.deps.power.onPrimaryDisconnected();
    }
  }

  // Spec: docs/specs/08-observability.md#2.1
  getHealthStatus(): HealthResponse {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  async dispose(): Promise<void> {
    this.deps.auth.stopTokenSweep();
    this.deps.power.dispose();
    this.deps.streaming.dispose();
    this.pendingTransports.clear();
  }

  private async handleWsAuthMessage(
    connectionId: SessionConnectionId,
    payload: Uint8Array,
  ): Promise<void> {
    const transport =
      this.pendingTransports.get(connectionId) ??
      this.deps.session.getSession(connectionId)?.transport;
    if (transport === undefined) {
      return;
    }

    let authPayload: ReturnType<typeof decodeAuthFrame>;
    try {
      authPayload = decodeAuthFrame(payload);
    } catch {
      return;
    }

    const powerState = this.deps.power.getStatus().state;
    const pipelineRunning =
      powerState === "ACTIVE" || powerState === "BUFFER_HOLD" || powerState === "STARTING";

    let outcome: SessionAuthOutcome;
    switch (authPayload.kind) {
      case "PRIMARY_PIN":
        outcome = await this.deps.session.authenticatePrimaryPin(transport, authPayload.pin);
        break;
      case "SECONDARY_PIN":
        outcome = await this.deps.session.authenticateSecondaryPin(transport, authPayload.pin);
        break;
      case "TOKEN":
        outcome = await this.deps.session.authenticateToken(
          transport,
          authPayload.token,
          pipelineRunning,
        );
        break;
    }

    if (!outcome.ok) {
      if (outcome.closeCode !== WS_CLOSE_CODE.SESSION_CONFLICT) {
        transport.sendBinary(
          encodeServerControlFrame({
            type: "AUTH_FAILED",
            reason: outcome.reason,
            remainingAttempts: outcome.remainingAttempts ?? 0,
          }),
        );
      }
      return;
    }

    this.pendingTransports.delete(connectionId);

    if (outcome.requiresDualEncoderReset) {
      await this.deps.encoder.stopAll();
      this.deps.encoder.clearTimelineComp();
      this.deps.streaming.clearBufferAndQueues();
      const newEpoch = this.deps.encoder.advanceEpochAndResetClock();
      await this.deps.encoder.ensureDualRunning();
      this.deps.streaming.handleStreamReset(newEpoch);
      if (outcome.demotedActingPrimaryId !== undefined) {
        const demoted = this.deps.session.getSession(outcome.demotedActingPrimaryId);
        demoted?.transport.sendBinary(
          encodeServerControlFrame({
            type: "SESSION_ROLE_CHANGED",
            role: "SECONDARY_STREAMING",
            streamEpoch: newEpoch,
          }),
        );
      }
    }

    if (outcome.session.role === "PRIMARY" || outcome.session.role === "ACTING_PRIMARY") {
      await this.deps.power.onPrimaryConnected();
    }

    const activeEpoch = this.deps.encoder.getCurrentEpoch();
    const currentPowerState = this.deps.power.getStatus().state;
    outcome.session.transport.sendBinary(
      encodeServerControlFrame({
        type: "AUTH_OK",
        role: outcome.session.role,
        token: outcome.session.token,
        streamEpoch: activeEpoch,
        settings: toPublicSettings(this.deps.settings.getCurrent()),
        powerState: currentPowerState,
      }),
    );

    if (outcome.session.role !== "SECONDARY_STANDBY") {
      this.deps.streaming.handleSessionActivated(outcome.session.id, activeEpoch, null);
    }
  }

  private async handleAuthenticatedControlMessage(
    session: ClientSessionRecord,
    payload: Uint8Array,
    isPrimaryAuthority: boolean,
    isStandby: boolean,
  ): Promise<void> {
    let command: ReturnType<typeof decodeClientControlFrame>;
    try {
      command = decodeClientControlFrame(payload);
    } catch {
      return;
    }

    switch (command.type) {
      case "PING": {
        session.transport.sendBinary(
          this.deps.streaming.buildPongPayload(command.clientTimestampMs),
        );
        return;
      }
      case "DISCONNECT": {
        this.handleWsClose(session.id, WS_CLOSE_CODE.NORMAL);
        session.transport.close(WS_CLOSE_CODE.NORMAL, "Client requested disconnect");
        return;
      }
      default:
        break;
    }

    if (isStandby) {
      return;
    }

    switch (command.type) {
      case "PLAYBACK_FEEDBACK": {
        if (!isPrimaryAuthority) {
          return;
        }
        const powerState = this.deps.power.getStatus().state;
        const streamingKind = this.deps.streaming.getState().kind;
        const mode: PrimaryPlaybackMode =
          powerState === "BUFFER_HOLD"
            ? "BUFFER_HOLD"
            : streamingKind === "STANDBY"
              ? "LIVE"
              : streamingKind;
        this.deps.session.recordPrimaryFeedback(
          session.id,
          command.renderedPtsUs,
          this.deps.settings.getCurrent().stream.targetBufferMs,
          mode,
        );
        this.deps.streaming.handlePrimaryFeedback(
          session.id,
          command.streamEpoch,
          command.renderedPtsUs,
          command.videoBufferedMs,
          command.audioBufferedMs,
        );
        return;
      }
      case "PAUSE_BROWSER": {
        if (!isPrimaryAuthority) {
          return;
        }
        await this.deps.power.sleep();
        return;
      }
      case "RESUME_BROWSER": {
        if (!isPrimaryAuthority) {
          return;
        }
        await this.deps.power.resume();
        return;
      }
      case "RESTART_BROWSER": {
        if (!isPrimaryAuthority) {
          return;
        }
        await this.deps.power.restartBrowser();
        return;
      }
      case "NAVIGATE": {
        try {
          this.deps.streaming.handleUserInteraction(this.deps.clock.nowMs());
          await this.deps.browser.navigate(command.url);
        } catch {
          // Ignore transient browser navigation errors.
        }
        return;
      }
      case "HISTORY_BACK": {
        try {
          this.deps.streaming.handleUserInteraction(this.deps.clock.nowMs());
          await this.deps.browser.goBack();
        } catch {
          // Ignore transient browser history errors.
        }
        return;
      }
      case "HISTORY_FORWARD": {
        try {
          this.deps.streaming.handleUserInteraction(this.deps.clock.nowMs());
          await this.deps.browser.goForward();
        } catch {
          // Ignore transient browser history errors.
        }
        return;
      }
      case "RELOAD": {
        try {
          this.deps.streaming.handleUserInteraction(this.deps.clock.nowMs());
          await this.deps.browser.reload();
        } catch {
          // Ignore transient browser reload errors.
        }
        return;
      }
      case "TOGGLE_FULLSCREEN": {
        try {
          this.deps.streaming.handleUserInteraction(this.deps.clock.nowMs());
          await this.deps.browser.toggleFullscreen();
        } catch {
          // Ignore transient fullscreen toggle errors.
        }
        return;
      }
      case "SET_ZOOM": {
        try {
          await this.deps.browser.setDisplayScale(command.scale);
        } catch {
          // Ignore transient zoom errors.
        }
        return;
      }
      case "INPUT_TEXT": {
        try {
          this.deps.streaming.handleUserInteraction(this.deps.clock.nowMs());
          await this.deps.browser.injectText(command.text);
        } catch {
          // Ignore transient text input errors.
        }
        return;
      }
      case "INPUT_KEY": {
        try {
          this.deps.streaming.handleUserInteraction(this.deps.clock.nowMs());
          await this.deps.browser.injectKey(command.key);
        } catch {
          // Ignore transient key input errors.
        }
        return;
      }
    }
  }
}
