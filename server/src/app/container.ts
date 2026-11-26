import path from "node:path";
import {
  CHANNEL_ID,
  createInitialStreamingState,
  type EncoderBackend,
  encodeMediaFrame,
  encodeServerControlFrame,
  type PowerState,
  STREAM_EPOCH_INITIAL,
  transitionStreamingState,
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
import type { BrowserControlPort, CdpClientPort } from "../domains/browser/ports.js";
import type { EncoderControlPort, GpuHardwareProbePort } from "../domains/encoder/ports.js";
import type { MetricsServicePort, TelemetryServicePort } from "../domains/observability/ports.js";
import { PowerService, PowerTimers } from "../domains/power/index.js";
import type { PowerControllerPort } from "../domains/power/ports.js";
import { SessionRegistry, SessionService } from "../domains/session/index.js";
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

function createPhase3StreamingAdapter(
  clock: Clock,
  session: SessionServicePort,
): StreamingControlPort {
  let state = createInitialStreamingState();
  let latestMediaPtsUs = 0n;

  return {
    clearBufferAndQueues: () => {
      latestMediaPtsUs = 0n;
    },
    broadcastPowerState: (powerState: PowerState, streamEpoch: number) => {
      const frame = encodeServerControlFrame({
        type: "BROWSER_STATUS",
        powerState,
        streamEpoch,
      });
      for (const client of session.getAllSessions()) {
        client.transport.sendBinary(frame);
      }
    },
    onPowerSleep: () => {
      state = transitionStreamingState(state, { type: "POWER_SLEEP" }).nextState;
    },
    onPowerHoldEntered: (atMs: number, targetBufferMs: number) => {
      state = transitionStreamingState(state, {
        type: "HOLD_THRESHOLD_REACHED",
        atMs,
        targetBufferMs,
      }).nextState;
    },
    onPowerHoldExited: (newStreamEpoch: number) => {
      state = transitionStreamingState(state, {
        type: "HOLD_DRAINED",
        newStreamEpoch,
      }).nextState;
    },
    getState: () => state,
    dispatchEvent: (event) => {
      state = transitionStreamingState(state, event).nextState;
    },
    ingestEncodedPacket: (packet) => {
      if (packet.ptsUs > latestMediaPtsUs) {
        latestMediaPtsUs = packet.ptsUs;
      }
      const frame = encodeMediaFrame({
        channel: packet.mediaType === "video" ? CHANNEL_ID.VIDEO : CHANNEL_ID.AUDIO,
        flags: packet.flags,
        streamEpoch: packet.streamEpoch,
        ptsUs: packet.ptsUs,
        payload: packet.payload,
      });
      const primary = session.getPrimaryAuthority();
      if (primary !== null) {
        primary.transport.sendBinary(frame);
      }
      if (packet.mediaType === "video") {
        for (const secondary of session.getStreamingSecondaries()) {
          secondary.transport.sendBinary(frame);
        }
      }
    },
    handlePrimaryFeedback: () => {},
    handleUserInteraction: (atMs: number) => {
      state = transitionStreamingState(state, {
        type: "USER_INTERACTION",
        atMs,
        newStreamEpoch: state.streamEpoch,
      }).nextState;
    },
    handleSessionActivated: (_sessionId, streamEpoch) => {
      state = transitionStreamingState(state, {
        type: "SESSION_ACTIVATED",
        streamEpoch,
      }).nextState;
    },
    handleStreamReset: (newStreamEpoch: number) => {
      state = transitionStreamingState(state, {
        type: "STREAM_RESET",
        newStreamEpoch,
      }).nextState;
    },
    handleSocketRemoved: () => {},
    buildPongPayload: (clientTimestampMs: number) => {
      const sync = session.getPrimarySyncMetadata();
      return encodeServerControlFrame({
        type: "PONG",
        clientTimestampMs,
        serverTimestampMs: clock.nowMs(),
        latestMediaPtsUs: Number(latestMediaPtsUs),
        mode: sync.primaryMode,
        serverRemainingBufferMs: 0,
        primaryRenderedPts: sync.primaryRenderedPts,
        primaryFeedbackAgeMs: sync.primaryFeedbackAgeMs,
        primaryTargetBufferMs: sync.primaryTargetBufferMs,
        primaryMode: sync.primaryMode,
      });
    },
    broadcastServerStats: () => {},
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

  const browser = overrides?.browser ?? createPhase2BrowserPlaceholder();
  const encoder = overrides?.encoder ?? createPhase2EncoderPlaceholder(env);
  const metrics = overrides?.metrics ?? createPhase2MetricsPlaceholder();
  const telemetry = overrides?.telemetry ?? createPhase2TelemetryPlaceholder();

  let sessionRef: SessionServicePort | undefined;
  const shutdownHandler: LockoutShutdownHandler = overrides?.lockoutShutdownHandler ?? {
    onLockoutTriggered: async () => {
      sessionRef?.closeAllWithPolicyViolation("Security lockout triggered");
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

  let sessionRegistry: SessionRegistry | undefined;
  let powerRef: PowerControllerPort | undefined;
  let sessionServiceRef: SessionService | undefined;

  const session: SessionServicePort =
    overrides?.session ??
    (() => {
      const registry = new SessionRegistry({
        clock,
        onGraceExpired: () => {
          sessionServiceRef?.handleReloadGraceExpired();
        },
      });
      sessionRegistry = registry;
      const service = new SessionService({
        clock,
        auth,
        settings,
        registry,
        callbacks: {
          getStreamEpoch: () => encoder.getCurrentEpoch(),
          onReloadGraceExpiredWithoutSecondary: () => {
            powerRef?.onPrimaryDisconnected();
          },
        },
      });
      sessionServiceRef = service;
      return service;
    })();
  sessionRef = session;

  const streaming = overrides?.streaming ?? createPhase3StreamingAdapter(clock, session);

  let powerServiceRef: PowerService | undefined;
  const power: PowerControllerPort =
    overrides?.power ??
    (() => {
      const timers = new PowerTimers({
        clock,
        onAutoSleepExpired: () => {
          void powerServiceRef?.handleAutoSleepExpired();
        },
        onHoldExpired: () => {
          void powerServiceRef?.handleHoldExpired();
        },
      });
      const service = new PowerService({
        clock,
        settings,
        browser,
        encoder,
        streaming,
        session,
        timers,
        holdExpireMinutes: env.bufferHoldExpireMinutes,
      });
      powerServiceRef = service;
      return service;
    })();
  powerRef = power;

  const unsubscribePackets = encoder.subscribePackets((packet) => {
    streaming.ingestEncodedPacket(packet);
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
    dispose: async () => {
      unsubscribePackets();
      sessionRegistry?.dispose();
      await coordinator.dispose();
    },
  };
}
