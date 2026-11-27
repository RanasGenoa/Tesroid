import {
  type AlignedDimensions,
  AUDIO_FLAG,
  alignLayoutDimensions,
  CHANNEL_ID,
  decodeAuthFrame,
  decodeClientControlFrame,
  decodeMetricsFrame,
  decodeResizeFrame,
  decodeTouchFrame,
  encodeServerControlFrame,
  expandSetupQualityPreset,
  type HealthResponse,
  isInputAllowed,
  METRICS_LIMITS,
  type PowerActionResult,
  PROTOCOL_TIMING,
  type PublicAppSettings,
  type SettingsUpdateInput,
  type SetupRequestInput,
  type SystemStatusResponse,
  TELEMETRY_LIMITS,
  type TelemetryEventInput,
  toPublicSettings,
  VIDEO_FLAG,
  validateSettingsUpdate,
  validateSetupRequest,
  WS_CLOSE_CODE,
} from "@tesroid/shared";
import type { AuthServicePort } from "../domains/auth/ports.js";
import type { BrowserControlPort } from "../domains/browser/ports.js";
import type { EncodedMediaPacket, EncoderControlPort } from "../domains/encoder/ports.js";
import type { MetricsServicePort, TelemetryServicePort } from "../domains/observability/ports.js";
import type { PowerControllerPort, PrimaryConnectMode } from "../domains/power/ports.js";
import type {
  ClientSessionRecord,
  SessionAuthOutcome,
  SessionConnectionId,
  SessionServicePort,
  SessionTransportPort,
} from "../domains/session/ports.js";
import { SettingsDomainError } from "../domains/settings/errors.js";
import type { SettingsRepository } from "../domains/settings/ports.js";
import type { StreamingControlPort, StreamingLifecyclePort } from "../domains/streaming/ports.js";
import type { Clock, ServerEnvConfig, TimerHandle } from "../infra/index.js";

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

export class ServerCoordinator implements StreamingLifecyclePort {
  private readonly deps: CoordinatorDeps;
  private readonly pendingTransports = new Map<SessionConnectionId, SessionTransportPort>();
  private resizeTimer: TimerHandle | null = null;
  private pendingResize: AlignedDimensions | null = null;
  private resizeQueue: Promise<void> = Promise.resolve();
  private inFlightHoldEnter: Promise<void> | null = null;
  private inFlightHoldExit: Promise<void> | null = null;
  private inFlightInteractiveReset: Promise<void> | null = null;
  private readonly startedAtMonotonicMs: number;
  private lastStatsAtMonotonicMs: number;
  private videoFramesInWindow = 0;
  private videoBytesInWindow = 0;
  private audioPacketsInWindow = 0;
  private serverStatsTimer: TimerHandle | null = null;

  // Spec: docs/architecture.md#1.2
  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
    const nowMono = deps.clock.monotonicMs();
    this.startedAtMonotonicMs = nowMono;
    this.lastStatsAtMonotonicMs = nowMono;
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  async initialize(): Promise<void> {
    await this.deps.auth.assertNotLockedAtStartup();
    await this.deps.settings.load();
    await this.deps.telemetry.initialize();
    this.deps.auth.startTokenSweep();
    this.startServerStatsTimer();
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

  // Spec: docs/specs/03-streaming-transport.md#2.4
  requestBufferHold(): Promise<void> {
    if (this.inFlightHoldEnter !== null) {
      return this.inFlightHoldEnter;
    }
    const run = this.deps.power
      .enterBufferHold()
      .then(() => undefined)
      .finally(() => {
        if (this.inFlightHoldEnter === run) {
          this.inFlightHoldEnter = null;
        }
      });
    this.inFlightHoldEnter = run;
    return run;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  requestExitBufferHold(
    reason: "DRAINED" | "INTERACTION" | "LIVE_FALLBACK",
    atMs?: number,
  ): Promise<void> {
    if (this.inFlightHoldExit !== null) {
      return this.inFlightHoldExit;
    }
    const run = this.deps.power
      .exitBufferHold(reason, atMs)
      .then(() => undefined)
      .finally(() => {
        if (this.inFlightHoldExit === run) {
          this.inFlightHoldExit = null;
        }
      });
    this.inFlightHoldExit = run;
    return run;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.2
  requestInteractiveEpochReset(atMs: number): Promise<void> {
    if (this.inFlightInteractiveReset !== null) {
      return this.inFlightInteractiveReset;
    }
    const run = (async () => {
      const newEpoch = await this.resetDualEncoderPipeline();
      this.deps.streaming.completeInteractiveEpochReset(atMs, newEpoch);
    })().finally(() => {
      if (this.inFlightInteractiveReset === run) {
        this.inFlightInteractiveReset = null;
      }
    });
    this.inFlightInteractiveReset = run;
    return run;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.5
  async resetStream(): Promise<PowerActionResult> {
    const state = this.deps.power.getStatus().state;
    if (state === "BUFFER_HOLD") {
      return this.deps.power.exitBufferHold("RESET");
    }
    if (state === "STOPPED" || state === "SLEEP_PAUSED") {
      return this.deps.power.ensureActive();
    }

    const newEpoch = await this.resetDualEncoderPipeline();
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
          this.scheduleResize(aligned);
        } catch {
          // Ignore malformed resize frames.
        }
        return;
      }
      case CHANNEL_ID.TOUCH: {
        if (isStandby) {
          return;
        }
        let frame: ReturnType<typeof decodeTouchFrame>;
        try {
          frame = decodeTouchFrame(payload);
        } catch {
          return;
        }
        await this.runInteractiveAction(() => this.deps.browser.injectTouch(frame));
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
      case CHANNEL_ID.METRICS: {
        try {
          const sample = decodeMetricsFrame(payload);
          this.deps.metrics.recordSample(sample);
        } catch {
          // Ignore malformed metrics frames.
        }
        return;
      }
      case CHANNEL_ID.TELEMETRY: {
        if (!this.deps.settings.getCurrent().stream.telemetryEnabled) {
          return;
        }
        if (payload.byteLength > TELEMETRY_LIMITS.maxPayloadBytes) {
          return;
        }
        await this.handleTelemetryPayload(payload.subarray(1));
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
  recordEncodedPacket(packet: EncodedMediaPacket): void {
    if (packet.mediaType === "video") {
      this.videoBytesInWindow += packet.payload.byteLength;
      if ((packet.flags & VIDEO_FLAG.CONFIG) === 0) {
        this.videoFramesInWindow += 1;
      }
      return;
    }
    if ((packet.flags & AUDIO_FLAG.CONFIG) === 0) {
      this.audioPacketsInWindow += 1;
    }
  }

  // Spec: docs/specs/08-observability.md#2.1
  getHealthStatus(): HealthResponse {
    const powerState = this.deps.power.getStatus().state;
    const uptimeSec = Math.max(
      0,
      Math.floor((this.deps.clock.monotonicMs() - this.startedAtMonotonicMs) / 1_000),
    );
    return {
      ok: powerState !== "ERROR",
      uptimeSec,
      timestamp: new Date(this.deps.clock.nowMs()).toISOString(),
      powerState,
      encoder: this.deps.encoder.getHealthStatus(),
    };
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.4
  async dispose(): Promise<void> {
    if (this.resizeTimer !== null) {
      this.deps.clock.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    if (this.serverStatsTimer !== null) {
      this.deps.clock.clearInterval(this.serverStatsTimer);
      this.serverStatsTimer = null;
    }
    this.pendingResize = null;
    this.deps.auth.stopTokenSweep();
    this.deps.power.dispose();
    this.deps.streaming.dispose();
    this.pendingTransports.clear();
  }

  private startServerStatsTimer(): void {
    if (this.serverStatsTimer !== null) {
      this.deps.clock.clearInterval(this.serverStatsTimer);
    }
    this.lastStatsAtMonotonicMs = this.deps.clock.monotonicMs();
    this.serverStatsTimer = this.deps.clock.setInterval(() => {
      const nowMonoMs = this.deps.clock.monotonicMs();
      const elapsedSec = Math.max(0.001, (nowMonoMs - this.lastStatsAtMonotonicMs) / 1_000);
      const encodeFps = Math.round((this.videoFramesInWindow / elapsedSec) * 10) / 10;
      const sendBitrateKbps = Math.round((this.videoBytesInWindow * 8) / (elapsedSec * 1_000));
      const audioPps = Math.round((this.audioPacketsInWindow / elapsedSec) * 10) / 10;

      this.videoFramesInWindow = 0;
      this.videoBytesInWindow = 0;
      this.audioPacketsInWindow = 0;
      this.lastStatsAtMonotonicMs = nowMonoMs;

      if (this.deps.session.getAllSessions().length === 0) {
        return;
      }

      this.deps.streaming.broadcastServerStats({
        encodeFps,
        sendBitrateKbps,
        audioPps,
        powerState: this.deps.power.getStatus().state,
      });
    }, METRICS_LIMITS.serverStatsIntervalMs);
  }

  private async handleTelemetryPayload(payload: Uint8Array): Promise<void> {
    if (payload.byteLength === 0) {
      return;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      const parsed: unknown = JSON.parse(text);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        !("events" in parsed) ||
        !Array.isArray((parsed as { readonly events?: unknown }).events)
      ) {
        return;
      }
      const events = (parsed as { readonly events: readonly TelemetryEventInput[] }).events;
      await this.deps.telemetry.appendBatch(events);
    } catch {
      // Ignore malformed telemetry frames.
    }
  }

  private async resetDualEncoderPipeline(): Promise<number> {
    await this.deps.encoder.stopAll();
    this.deps.encoder.clearTimelineComp();
    this.deps.streaming.clearBufferAndQueues();
    const newEpoch = this.deps.encoder.advanceEpochAndResetClock();
    this.deps.session.clearPrimaryFeedback();
    await this.deps.encoder.ensureDualRunning();
    return newEpoch;
  }

  private async runInteractiveAction(action: () => Promise<void>): Promise<void> {
    if (!isInputAllowed(this.deps.streaming.getState())) {
      return;
    }
    try {
      await this.deps.streaming.handleUserInteraction(this.deps.clock.nowMs());
      await action();
    } catch {
      // Ignore transient browser input or navigation errors.
    }
  }

  private scheduleResize(aligned: AlignedDimensions): void {
    this.pendingResize = aligned;
    if (this.resizeTimer !== null) {
      this.deps.clock.clearTimeout(this.resizeTimer);
    }
    this.resizeTimer = this.deps.clock.setTimeout(() => {
      this.resizeTimer = null;
      const next = this.pendingResize;
      this.pendingResize = null;
      if (next !== null) {
        void this.enqueueResize(next).catch(() => undefined);
      }
    }, PROTOCOL_TIMING.serverResizeDebounceMs);
  }

  private enqueueResize(aligned: AlignedDimensions): Promise<void> {
    const run = this.resizeQueue.then(async () => {
      await this.deps.browser.resizeViewport(aligned);
      this.deps.streaming.clearBufferAndQueues();
      const newEpoch = this.deps.encoder.advanceEpochAndResetClock();
      this.deps.session.clearPrimaryFeedback();
      await this.deps.encoder.reconfigureDimensions(aligned);
      this.deps.streaming.handleStreamReset(newEpoch);
    });
    this.resizeQueue = run.catch(() => undefined);
    return run;
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
      const newEpoch = await this.resetDualEncoderPipeline();
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

    const isPrimaryAuthorityRole =
      outcome.session.role === "PRIMARY" || outcome.session.role === "ACTING_PRIMARY";
    const preserveBufferHold =
      authPayload.kind === "TOKEN" &&
      isPrimaryAuthorityRole &&
      !outcome.requiresDualEncoderReset &&
      outcome.displacedSessionId === undefined;
    const connectMode: PrimaryConnectMode = preserveBufferHold ? "RECONNECT" : "NEW_SESSION";

    if (isPrimaryAuthorityRole) {
      await this.deps.power.onPrimaryConnected(connectMode);
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
      const lastAckPtsUs = preserveBufferHold
        ? this.deps.session.getPrimaryConfirmedPtsUs(activeEpoch)
        : null;
      this.deps.streaming.handleSessionActivated(outcome.session.id, activeEpoch, lastAckPtsUs);
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
      case "NAVIGATE":
        await this.runInteractiveAction(() => this.deps.browser.navigate(command.url));
        return;
      case "HISTORY_BACK":
        await this.runInteractiveAction(() => this.deps.browser.goBack());
        return;
      case "HISTORY_FORWARD":
        await this.runInteractiveAction(() => this.deps.browser.goForward());
        return;
      case "RELOAD":
        await this.runInteractiveAction(() => this.deps.browser.reload());
        return;
      case "TOGGLE_FULLSCREEN":
        await this.runInteractiveAction(() => this.deps.browser.toggleFullscreen());
        return;
      case "SET_ZOOM": {
        try {
          await this.deps.browser.setDisplayScale(command.scale);
        } catch {
          // Ignore transient zoom errors.
        }
        return;
      }
      case "INPUT_TEXT":
        await this.runInteractiveAction(() => this.deps.browser.injectText(command.text));
        return;
      case "INPUT_KEY":
        await this.runInteractiveAction(() => this.deps.browser.injectKey(command.key));
        return;
    }
  }
}
