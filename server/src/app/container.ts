import path from "node:path";
import type { AlignedDimensions } from "@tesroid/shared";
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
import type { BrowserControlPort, CdpClientPort } from "../domains/browser/ports.js";
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
  NodeCdpClient,
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

// 仕様 06 §2.1: PulseAudio ネイティブソケットは /tmp/pulse-socket に固定。
// イメージへ焼き込む /etc/pulse/tesroid.pa の socket= と必ず一致させること（pulse-socket-consistency テストで機械保証）。
export const PULSE_SOCKET_PATH = "/tmp/pulse-socket";

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

  const pulseSocketPath = PULSE_SOCKET_PATH;
  const cdp = overrides?.cdp ?? new NodeCdpClient();
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
      // GPU 検出はエンコーダ側の責務。Chrome 起動時点の値を遅延取得し、未検出なら起動前に検出を保証する。
      vaapiRenderNodeProvider: async () => {
        const renderNode = encoder.getRenderNode();
        if (renderNode !== null) {
          return renderNode;
        }
        await encoder.detectBackend();
        return encoder.getRenderNode();
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

  let coordinatorRef: ServerCoordinator | undefined;
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
      lifecycle: {
        requestBufferHold: async () => {
          await coordinatorRef?.requestBufferHold();
        },
        requestExitBufferHold: async (reason, atMs) => {
          await coordinatorRef?.requestExitBufferHold(reason, atMs);
        },
        requestInteractiveEpochReset: async (atMs) => {
          await coordinatorRef?.requestInteractiveEpochReset(atMs);
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
          void powerServiceRef?.handleAutoSleepExpired().catch(() => undefined);
        },
        onHoldExpired: () => {
          void powerServiceRef?.handleHoldExpired().catch(() => undefined);
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
  coordinatorRef = coordinator;

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
      await coordinator.dispose();
      session.dispose();
      await Promise.allSettled([
        Promise.resolve().then(() => encoder.stopAll()),
        Promise.resolve().then(() => browser.stop()),
      ]);
    },
  };
}
