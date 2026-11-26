import path from "node:path";
import {
  createInitialStreamingState,
  type EncoderBackend,
  STREAM_EPOCH_INITIAL,
} from "@tesroid/shared";
import {
  AuthService,
  BcryptPasswordHasher,
  CryptoTokenGenerator,
  LockoutManager,
  SessionTokenStore,
} from "../domains/auth/index.js";
import type {
  AuthServicePort,
  LockoutShutdownHandler,
  PasswordHasher,
  TokenGenerator,
} from "../domains/auth/ports.js";
import type { BrowserControlPort, CdpClientPort, X11InputPort } from "../domains/browser/ports.js";
import type { EncoderControlPort, GpuHardwareProbePort } from "../domains/encoder/ports.js";
import type { MetricsServicePort, TelemetryServicePort } from "../domains/observability/ports.js";
import type { PowerControllerPort } from "../domains/power/ports.js";
import type { SessionServicePort } from "../domains/session/ports.js";
import type { SettingsRepository } from "../domains/settings/ports.js";
import { SettingsService } from "../domains/settings/settings-service.js";
import type { StreamingControlPort } from "../domains/streaming/ports.js";
import {
  type AtomicJsonStore,
  type Clock,
  type JsonlStore,
  NodeAtomicJsonStore,
  NodeProcessExit,
  type ProcessExitPort,
  type ProcessRunner,
  type ProcessTreeController,
  type ServerEnvConfig,
  SystemClock,
} from "../infra/index.js";
import { ServerCoordinator } from "./coordinator.js";

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
  readonly browser?: BrowserControlPort;
  readonly encoder?: EncoderControlPort;
  readonly session?: SessionServicePort;
  readonly streaming?: StreamingControlPort;
  readonly power?: PowerControllerPort;
  readonly metrics?: MetricsServicePort;
  readonly telemetry?: TelemetryServicePort;
  readonly lockoutShutdownHandler?: LockoutShutdownHandler;
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

function unimplemented(): never {
  throw new Error("NOT_IMPLEMENTED");
}

function createPhase2SessionPlaceholder(): SessionServicePort {
  return {
    hasActivePrimaryOrActing: () => false,
    demoteAllStreamingToStandby: () => {},
    promoteStandbyToStreaming: () => {},
    authenticatePrimaryPin: () => unimplemented(),
    authenticateSecondaryPin: () => unimplemented(),
    authenticateToken: () => unimplemented(),
    handleDisconnect: () => unimplemented(),
    getSession: () => null,
    getPrimaryAuthority: () => null,
    getStreamingSecondaries: () => [],
    getAllSessions: () => [],
    recordPrimaryFeedback: () => {},
    getPrimarySyncMetadata: () => ({
      primaryRenderedPts: null,
      primaryFeedbackAgeMs: null,
      primaryTargetBufferMs: 0,
      primaryMode: null,
    }),
    closeAllWithPolicyViolation: () => {},
  };
}

function createPhase2BrowserPlaceholder(): BrowserControlPort {
  return {
    start: () => unimplemented(),
    stop: () => unimplemented(),
    freezeTree: () => unimplemented(),
    resumeTree: () => unimplemented(),
    restartBrowser: () => unimplemented(),
    setMonitoringPaused: () => {},
    getCurrentPageInfo: () => ({ url: null, title: null }),
    navigate: () => unimplemented(),
    goBack: () => unimplemented(),
    goForward: () => unimplemented(),
    reload: () => unimplemented(),
    toggleFullscreen: () => unimplemented(),
    setDisplayScale: async () => {},
    resizeViewport: () => unimplemented(),
    injectTouch: () => unimplemented(),
    injectText: () => unimplemented(),
    injectKey: () => unimplemented(),
  };
}

function createPhase2EncoderPlaceholder(env: ServerEnvConfig): EncoderControlPort {
  const backend: EncoderBackend =
    env.encoderMode === "software" ? "software" : env.encoderMode === "nvenc" ? "nvenc" : "vaapi";
  return {
    ensureDualRunning: () => unimplemented(),
    stopAll: () => unimplemented(),
    advanceEpochAndResetClock: () => STREAM_EPOCH_INITIAL,
    pauseWithTimelineComp: () => unimplemented(),
    clearTimelineComp: () => {},
    getCurrentEpoch: () => STREAM_EPOCH_INITIAL,
    detectBackend: () => unimplemented(),
    getActiveBackend: () => backend,
    getHealthStatus: () => unimplemented(),
    reconfigureDimensions: () => unimplemented(),
    applySettingsUpdate: async () => {},
    restartVideoOnly: () => unimplemented(),
    restartAudioOnly: () => unimplemented(),
    subscribePackets: () => () => {},
  };
}

function createPhase2StreamingPlaceholder(): StreamingControlPort {
  const initialState = createInitialStreamingState();
  return {
    clearBufferAndQueues: () => {},
    broadcastPowerState: () => {},
    onPowerSleep: () => {},
    onPowerHoldEntered: () => {},
    onPowerHoldExited: () => {},
    getState: () => initialState,
    dispatchEvent: () => {},
    ingestEncodedPacket: () => {},
    handlePrimaryFeedback: () => {},
    handleUserInteraction: () => {},
    handleSessionActivated: () => {},
    handleStreamReset: () => {},
    handleSocketRemoved: () => {},
    buildPongPayload: () => unimplemented(),
    broadcastServerStats: () => {},
    dispose: () => {},
  };
}

function createPhase2PowerPlaceholder(clock: Clock): PowerControllerPort {
  return {
    getStatus: () => ({
      state: "STOPPED",
      streamEpoch: STREAM_EPOCH_INITIAL,
      currentUrl: null,
      currentTitle: null,
      updatedAtMs: clock.nowMs(),
    }),
    ensureActive: () => unimplemented(),
    sleep: () => unimplemented(),
    resume: () => unimplemented(),
    restartBrowser: () => unimplemented(),
    enterBufferHold: () => unimplemented(),
    exitBufferHold: () => unimplemented(),
    onPrimaryConnected: () => unimplemented(),
    onPrimaryDisconnected: () => {},
    dispose: () => {},
  };
}

function createPhase2MetricsPlaceholder(): MetricsServicePort {
  return {
    recordSample: () => {},
    getSummary: () => unimplemented(),
    getHistory: () => [],
    clear: () => {},
  };
}

function createPhase2TelemetryPlaceholder(): TelemetryServicePort {
  return {
    initialize: async () => {},
    getCurrentSessionId: () => "",
    appendBatch: () => unimplemented(),
    listSessions: () => unimplemented(),
    readSessionNdjson: () => unimplemented(),
    readLatestSessionNdjson: () => unimplemented(),
    deleteAllSessions: () => unimplemented(),
  };
}

// Spec: docs/architecture.md#1.2
export function createAppContainer(
  env: ServerEnvConfig,
  overrides?: AppContainerOverrides,
): AppContainer {
  const clock = overrides?.clock ?? new SystemClock();
  const jsonStore = overrides?.jsonStore ?? new NodeAtomicJsonStore();
  const processExit = overrides?.processExit ?? new NodeProcessExit();
  const passwordHasher = overrides?.passwordHasher ?? new BcryptPasswordHasher();
  const tokenGenerator = overrides?.tokenGenerator ?? new CryptoTokenGenerator();

  const settings = new SettingsService({
    store: jsonStore,
    filePath: path.join(env.dataDir, "settings.json"),
  });
  const tokenStore = new SessionTokenStore({ clock, tokenGenerator });
  const lockout = new LockoutManager({
    clock,
    store: jsonStore,
    filePath: path.join(env.dataDir, "lockout.json"),
    processExit,
  });

  const session = overrides?.session ?? createPhase2SessionPlaceholder();
  const browser = overrides?.browser ?? createPhase2BrowserPlaceholder();
  const encoder = overrides?.encoder ?? createPhase2EncoderPlaceholder(env);
  const streaming = overrides?.streaming ?? createPhase2StreamingPlaceholder();
  const power = overrides?.power ?? createPhase2PowerPlaceholder(clock);
  const metrics = overrides?.metrics ?? createPhase2MetricsPlaceholder();
  const telemetry = overrides?.telemetry ?? createPhase2TelemetryPlaceholder();

  const shutdownHandler: LockoutShutdownHandler = overrides?.lockoutShutdownHandler ?? {
    onLockoutTriggered: async () => {
      session.closeAllWithPolicyViolation("Security lockout triggered");
    },
  };

  const auth = new AuthService({
    clock,
    settings,
    passwordHasher,
    tokenStore,
    lockout,
    shutdownHandler,
  });

  const coordinator = new ServerCoordinator({
    clock,
    env,
    settings,
    auth,
    session,
    browser,
    encoder,
    streaming,
    power,
    metrics,
    telemetry,
  });

  return {
    env,
    clock,
    settings,
    auth,
    session,
    browser,
    encoder,
    streaming,
    power,
    metrics,
    telemetry,
    coordinator,
    dispose: () => coordinator.dispose(),
  };
}
