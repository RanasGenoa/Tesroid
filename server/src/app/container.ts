import path from "node:path";
import type { AlignedDimensions, SpecialKey } from "@tesroid/shared";
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
import { BrowserInputRouter, BrowserService } from "../domains/browser/index.js";
import type {
  BrowserControlPort,
  BrowserPageInfo,
  CdpClientPort,
} from "../domains/browser/ports.js";
import { EncoderService, NodeGpuHardwareProbe } from "../domains/encoder/index.js";
import type { EncoderControlPort, GpuHardwareProbePort } from "../domains/encoder/ports.js";
import { MetricsRingBuffer, TelemetryStore } from "../domains/observability/index.js";
import type { MetricsServicePort, TelemetryServicePort } from "../domains/observability/ports.js";
import { PowerService, PowerTimers } from "../domains/power/index.js";
import type { PowerControllerPort } from "../domains/power/ports.js";
import { SessionRegistry, SessionService } from "../domains/session/index.js";
import type { SessionServicePort } from "../domains/session/ports.js";
import type { SettingsRepository } from "../domains/settings/ports.js";
import { SettingsService } from "../domains/settings/settings-service.js";
import { CatchupPacer, MediaRingBuffer, StreamingController } from "../domains/streaming/index.js";
import type { StreamingControlPort } from "../domains/streaming/ports.js";
import {
  type AtomicJsonStore,
  type Clock,
  type JsonlStore,
  NodeAtomicJsonStore,
  NodeJsonlStore,
  NodeProcessExit,
  NodeProcessRunner,
  NodeProcessTreeController,
  type ProcessExitPort,
  type ProcessRunner,
  type ProcessTreeController,
  type ServerEnvConfig,
  SystemClock,
} from "../infra/index.js";
import { ServerCoordinator } from "./coordinator.js";

const DEFAULT_BROWSER_VIEWPORT: AlignedDimensions = { width: 1280, height: 720 };
const DEFAULT_CDP_PORT = 9222;

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

function createDisconnectedCdpFallback(): CdpClientPort {
  return {
    connect: async () => {
      throw new Error("CDP client adapter not configured");
    },
    disconnect: async () => {},
    isConnected: () => false,
    dispatchTouchEvent: async () => {},
    insertText: async () => {},
    dispatchKey: async (_key: SpecialKey) => {},
    navigate: async () => {},
    goBack: async () => {},
    goForward: async () => {},
    reload: async () => {},
    setViewportSize: async () => {},
    evaluate: async <T = unknown>() => undefined as T,
    addScriptToEvaluateOnNewDocument: async () => {},
    getPageInfo: async (): Promise<BrowserPageInfo> => ({ url: null, title: null }),
  };
}

// Spec: docs/architecture.md#1.2
export function createAppContainer(
  env: ServerEnvConfig,
  overrides?: AppContainerOverrides,
): AppContainer {
  const clock = overrides?.clock ?? new SystemClock();
  const jsonStore = overrides?.jsonStore ?? new NodeAtomicJsonStore();
  const jsonlStore = overrides?.jsonlStore ?? new NodeJsonlStore();
  const processRunner = overrides?.processRunner ?? new NodeProcessRunner();
  const processTree = overrides?.processTree ?? new NodeProcessTreeController({ processRunner });
  const processExit = overrides?.processExit ?? new NodeProcessExit();
  const gpuProbe = overrides?.gpuProbe ?? new NodeGpuHardwareProbe({ processRunner });
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

  const pulseSocketPath = path.join(env.dataDir, "pulse-native");
  const cdp = overrides?.cdp ?? createDisconnectedCdpFallback();
  const browser =
    overrides?.browser ??
    new BrowserService({
      clock,
      settings,
      processRunner,
      processTree,
      cdp,
      inputRouter: new BrowserInputRouter({ clock, cdp }),
      config: {
        display: env.display,
        locale: env.locale,
        userDataDir: path.join(env.dataDir, "chrome-profile"),
        pulseSocketPath,
        cdpPort: DEFAULT_CDP_PORT,
        viewport: DEFAULT_BROWSER_VIEWPORT,
      },
    });

  const encoder =
    overrides?.encoder ??
    new EncoderService({
      clock,
      settings,
      processRunner,
      gpuProbe,
      mode: env.encoderMode,
      display: env.display,
      pulseSocketPath,
      explicitVaapiDevice: env.vaapiDevice,
      explicitVaapiDriver: env.libvaDriverName,
    });

  const metrics = overrides?.metrics ?? new MetricsRingBuffer();
  const telemetry =
    overrides?.telemetry ??
    new TelemetryStore({
      clock,
      settings,
      jsonlStore,
      logDir: env.telemetryLogDir,
    });

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

  const streaming: StreamingControlPort =
    overrides?.streaming ??
    new StreamingController({
      clock,
      settings,
      session,
      ringBuffer: new MediaRingBuffer({
        maxSeconds: env.playbackBufferSeconds,
        maxBytes: env.playbackBufferMaxBytes,
      }),
      catchupPacer: new CatchupPacer({ clock }),
      powerHooks: {
        requestHold: async () => {
          await powerRef?.enterBufferHold();
        },
        requestResumeFromHold: async (reason) => {
          await powerRef?.exitBufferHold(reason);
        },
      },
      encoderHooks: {
        advanceEpochAndReset: async () => {
          const newEpoch = encoder.advanceEpochAndResetClock();
          session.clearPrimaryFeedback();
          await encoder.stopAll();
          encoder.clearTimelineComp();
          await encoder.ensureDualRunning();
          return newEpoch;
        },
      },
      idleToBufferSeconds: env.idleToBufferSeconds,
    });

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

  const unsubscribePackets = encoder.subscribePackets((packet) => {
    streaming.ingestEncodedPacket(packet);
    coordinator.recordEncodedPacket(packet);
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
