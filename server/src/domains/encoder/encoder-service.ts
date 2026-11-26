import {
  type AlignedDimensions,
  AUDIO_FLAG,
  alignEncodeDimensions,
  type EncoderBackend,
  type EncoderHealthStatus,
  type EncoderMode,
  LAYOUT_ALIGNMENT,
  nextStreamEpoch,
  resolveClientProfile,
  STREAM_BOUNDS,
  STREAM_EPOCH_INITIAL,
  type StreamSettings,
  snapFpsToAllowed,
  VIDEO_FLAG,
} from "@tesroid/shared";
import type { Clock, ManagedProcess, ProcessRunner, TimerHandle } from "../../infra/index.js";
import type { SettingsRepository } from "../settings/ports.js";
import {
  buildAudioFfmpegArgs,
  buildEncoderProcessEnv,
  buildVideoFfmpegArgs,
} from "./ffmpeg-args.js";
import {
  computeNextFallbackStep,
  detectBestEncoderBackend,
  ENCODER_WATCHDOG_CONSTANTS,
  type FallbackLadderState,
  getEncoderRetryDelayMs,
} from "./gpu-detector.js";
import { H264AvccParser } from "./h264-avcc-parser.js";
import { OggOpusParser } from "./ogg-opus-parser.js";
import type {
  EncoderControlPort,
  EncoderPacketListener,
  GpuHardwareProbePort,
  GpuProbeResult,
} from "./ports.js";

const DEFAULT_LAYOUT_DIMENSIONS: AlignedDimensions = { width: 1280, height: 720 };
const OPUS_FRAME_DURATION_US = 20_000n;

export interface EncoderServiceDeps {
  readonly clock: Clock;
  readonly settings: SettingsRepository;
  readonly processRunner: ProcessRunner;
  readonly gpuProbe: GpuHardwareProbePort;
  readonly mode: EncoderMode;
  readonly display: string;
  readonly pulseSocketPath: string;
  readonly explicitVaapiDevice: string | null;
  readonly explicitVaapiDriver: string | null;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}

function clampCaptureToMaxSize(layout: AlignedDimensions, maxSize: number): AlignedDimensions {
  const effectiveMaxSize = Math.min(
    STREAM_BOUNDS.maxSize.max,
    Math.max(STREAM_BOUNDS.maxSize.min, Math.round(maxSize)),
  );
  const maxHeight = Math.min(LAYOUT_ALIGNMENT.maxHeightCap, effectiveMaxSize);
  if (layout.width <= effectiveMaxSize && layout.height <= maxHeight) {
    return { width: layout.width, height: layout.height };
  }

  const ratio = Math.min(effectiveMaxSize / layout.width, maxHeight / layout.height);
  const width =
    Math.max(LAYOUT_ALIGNMENT.minWidth, Math.round(layout.width * ratio)) &
    ~(LAYOUT_ALIGNMENT.widthMultiple - 1);
  const height =
    Math.max(LAYOUT_ALIGNMENT.minHeight, Math.round(layout.height * ratio)) &
    ~(LAYOUT_ALIGNMENT.heightMultiple - 1);
  return { width, height };
}

function initialBackendForMode(mode: EncoderMode): EncoderBackend {
  if (mode === "nvenc") {
    return "nvenc";
  }
  if (mode === "vaapi") {
    return "vaapi";
  }
  return "software";
}

export class EncoderService implements EncoderControlPort {
  private readonly deps: EncoderServiceDeps;
  private readonly baseEnv: Readonly<Record<string, string | undefined>>;
  private readonly h264Parser = new H264AvccParser();
  private readonly opusParser = new OggOpusParser();
  private readonly listeners = new Set<EncoderPacketListener>();

  private backendDetected = false;
  private activeBackend: EncoderBackend;
  private vaapiDevice: string | null;
  private vaapiDriver: string | null;
  private vaapiFallbackCache: GpuProbeResult | null = null;
  private fallbackState: FallbackLadderState;
  private lastFallbackReason: string | null = null;
  private lastFallbackAt: string | null = null;

  private streamEpoch = STREAM_EPOCH_INITIAL;
  private masterClockStartMs: number | null = null;
  private timelineCompMs = 0;
  private holdPausedAtMs: number | null = null;
  private lastVideoPtsUs = 0n;
  private audioBasePtsUs: bigint | null = null;
  private audioFrameCount = 0;

  private baseLayoutDimensions: AlignedDimensions = { ...DEFAULT_LAYOUT_DIMENSIONS };
  private activeCaptureDimensions: AlignedDimensions;
  private activeEncodeDimensions: AlignedDimensions;

  private videoProc: ManagedProcess | null = null;
  private audioProc: ManagedProcess | null = null;
  private intentionallyStopped = true;
  private pausedForHold = false;
  private restartingVideo = false;
  private restartingAudio = false;
  private videoStartedAtMs = 0;
  private videoReceivedFrame = false;

  private videoWatchdogTimer: TimerHandle | null = null;
  private videoRetryTimer: TimerHandle | null = null;
  private audioRetryTimer: TimerHandle | null = null;

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  constructor(deps: EncoderServiceDeps) {
    this.deps = deps;
    this.baseEnv = deps.baseEnv ?? process.env;
    this.activeBackend = initialBackendForMode(deps.mode);
    this.vaapiDevice = deps.explicitVaapiDevice;
    this.vaapiDriver = deps.explicitVaapiDriver;

    const initialStream = deps.settings.getCurrent().stream;
    this.fallbackState = {
      mode: deps.mode,
      backend: this.activeBackend,
      vaapiLowPower: initialStream.vaapi.lowPower,
      gpuColorConvert: initialStream.vaapi.gpuColorConvert,
      retryAttempt: 0,
    };

    const resolved = this.computeDimensionsAndFps(this.baseLayoutDimensions, initialStream);
    this.activeCaptureDimensions = resolved.capture;
    this.activeEncodeDimensions = resolved.encode;
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.2
  async detectBackend(): Promise<GpuProbeResult> {
    const result = await detectBestEncoderBackend(
      this.deps.mode,
      this.deps.gpuProbe,
      this.deps.explicitVaapiDevice,
      this.deps.explicitVaapiDriver,
    );

    this.backendDetected = true;
    this.activeBackend = result.backend;
    this.vaapiDevice = result.vaapiDevice;
    this.vaapiDriver = result.vaapiDriver;
    if (result.backend === "vaapi") {
      this.vaapiFallbackCache = result;
    }

    const stream = this.deps.settings.getCurrent().stream;
    this.fallbackState = {
      mode: this.deps.mode,
      backend: result.backend,
      vaapiLowPower: stream.vaapi.lowPower,
      gpuColorConvert: stream.vaapi.gpuColorConvert,
      retryAttempt: 0,
    };

    return result;
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.2
  getActiveBackend(): EncoderBackend {
    return this.activeBackend;
  }

  // Spec: docs/specs/08-observability.md#2.1
  getHealthStatus(): EncoderHealthStatus {
    const stream = this.deps.settings.getCurrent().stream;
    return {
      running: this.videoProc !== null && this.audioProc !== null,
      backend: this.activeBackend,
      mode: this.deps.mode,
      compressionLevel: this.activeBackend === "vaapi" ? stream.vaapi.compressionLevel : null,
      x264Preset: this.activeBackend === "software" ? stream.x264Preset : null,
      vaapiDriver: this.activeBackend === "vaapi" ? this.vaapiDriver : null,
      lastFallbackReason: this.lastFallbackReason,
      lastFallbackAt: this.lastFallbackAt,
      captureResolution: { ...this.activeCaptureDimensions },
      encodeResolution: { ...this.activeEncodeDimensions },
    };
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  async ensureDualRunning(): Promise<void> {
    if (!this.backendDetected) {
      await this.detectBackend();
    }

    this.intentionallyStopped = false;
    this.pausedForHold = false;
    this.clearVideoRetryTimer();
    this.clearAudioRetryTimer();

    if (this.masterClockStartMs === null) {
      this.masterClockStartMs = this.deps.clock.monotonicMs();
    }
    if (this.holdPausedAtMs !== null) {
      this.timelineCompMs += Math.max(0, this.deps.clock.monotonicMs() - this.holdPausedAtMs);
      this.holdPausedAtMs = null;
    }

    const stream = this.deps.settings.getCurrent().stream;
    const plan = this.computeDimensionsAndFps(this.baseLayoutDimensions, stream);
    this.activeCaptureDimensions = plan.capture;
    this.activeEncodeDimensions = plan.encode;

    if (this.videoProc === null) {
      this.spawnVideoProcess(plan.capture, plan.encode, plan.effectiveSettings);
    }
    if (this.audioProc === null) {
      this.spawnAudioProcess(stream.audioBitrate);
    }
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  async stopAll(): Promise<void> {
    this.intentionallyStopped = true;
    this.pausedForHold = false;
    this.clearAllTimers();

    const video = this.videoProc;
    const audio = this.audioProc;
    this.videoProc = null;
    this.audioProc = null;

    await Promise.all([this.terminateProcess(video), this.terminateProcess(audio)]);
    this.h264Parser.reset();
    this.opusParser.reset();
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  advanceEpochAndResetClock(): number {
    this.streamEpoch = nextStreamEpoch(this.streamEpoch);
    if (this.holdPausedAtMs !== null) {
      this.timelineCompMs += Math.max(0, this.deps.clock.monotonicMs() - this.holdPausedAtMs);
      this.holdPausedAtMs = null;
      this.audioBasePtsUs = null;
      this.audioFrameCount = 0;
    } else {
      this.masterClockStartMs = this.deps.clock.monotonicMs();
      this.timelineCompMs = 0;
      this.lastVideoPtsUs = 0n;
      this.audioBasePtsUs = null;
      this.audioFrameCount = 0;
    }
    return this.streamEpoch;
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  async pauseWithTimelineComp(): Promise<void> {
    if (this.holdPausedAtMs === null) {
      this.holdPausedAtMs = this.deps.clock.monotonicMs();
    }
    this.pausedForHold = true;
    this.clearAllTimers();

    const video = this.videoProc;
    const audio = this.audioProc;
    this.videoProc = null;
    this.audioProc = null;

    await Promise.all([this.terminateProcess(video), this.terminateProcess(audio)]);
    this.h264Parser.reset();
    this.opusParser.reset();
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  clearTimelineComp(): void {
    this.holdPausedAtMs = null;
    this.timelineCompMs = 0;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  getCurrentEpoch(): number {
    return this.streamEpoch;
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.4
  async reconfigureDimensions(layoutDimensions: AlignedDimensions): Promise<void> {
    this.baseLayoutDimensions = { ...layoutDimensions };
    const stream = this.deps.settings.getCurrent().stream;
    const plan = this.computeDimensionsAndFps(this.baseLayoutDimensions, stream);

    if (this.videoProc === null || this.intentionallyStopped || this.pausedForHold) {
      this.activeCaptureDimensions = plan.capture;
      this.activeEncodeDimensions = plan.encode;
      return;
    }

    await this.restartVideoWithPlan(plan.capture, plan.encode, plan.effectiveSettings);
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  async applySettingsUpdate(options: {
    readonly videoChanged: boolean;
    readonly audioChanged: boolean;
    readonly dimensionsChanged: boolean;
  }): Promise<void> {
    const stream = this.deps.settings.getCurrent().stream;
    const plan = this.computeDimensionsAndFps(this.baseLayoutDimensions, stream);

    if (options.videoChanged || options.dimensionsChanged) {
      this.fallbackState = {
        ...this.fallbackState,
        vaapiLowPower: stream.vaapi.lowPower,
        gpuColorConvert: stream.vaapi.gpuColorConvert,
      };
      if (this.videoProc !== null && !this.intentionallyStopped && !this.pausedForHold) {
        await this.restartVideoWithPlan(plan.capture, plan.encode, plan.effectiveSettings);
      } else {
        this.activeCaptureDimensions = plan.capture;
        this.activeEncodeDimensions = plan.encode;
      }
    }

    if (
      options.audioChanged &&
      this.audioProc !== null &&
      !this.intentionallyStopped &&
      !this.pausedForHold
    ) {
      await this.restartAudioOnly();
    }
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  async restartVideoOnly(): Promise<void> {
    if (this.intentionallyStopped || this.pausedForHold) {
      return;
    }
    if (!this.backendDetected) {
      await this.detectBackend();
    }
    const stream = this.deps.settings.getCurrent().stream;
    const plan = this.computeDimensionsAndFps(this.baseLayoutDimensions, stream);
    await this.restartVideoWithPlan(plan.capture, plan.encode, plan.effectiveSettings);
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  async restartAudioOnly(): Promise<void> {
    if (this.intentionallyStopped || this.pausedForHold) {
      return;
    }
    this.clearAudioRetryTimer();
    this.restartingAudio = true;
    try {
      const prevAudio = this.audioProc;
      this.audioProc = null;
      const hadPrev = prevAudio !== null;
      await this.terminateProcess(prevAudio);
      this.opusParser.reset();

      if (hadPrev) {
        await this.waitClockMs(ENCODER_WATCHDOG_CONSTANTS.restartDelayMs);
      }
      if (this.intentionallyStopped || this.pausedForHold) {
        return;
      }

      const stream = this.deps.settings.getCurrent().stream;
      this.spawnAudioProcess(stream.audioBitrate);
    } finally {
      this.restartingAudio = false;
    }
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  subscribePackets(listener: EncoderPacketListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private computeDimensionsAndFps(
    layout: AlignedDimensions,
    stream: StreamSettings,
  ): {
    readonly capture: AlignedDimensions;
    readonly encode: AlignedDimensions;
    readonly effectiveSettings: StreamSettings;
  } {
    const profile = resolveClientProfile(stream.clientProfile);
    const snappedFps = snapFpsToAllowed(stream.fps, profile.allowedFps);
    const capture = clampCaptureToMaxSize(layout, stream.maxSize);
    const encode = alignEncodeDimensions(capture, profile.scale);
    const effectiveSettings: StreamSettings = {
      ...stream,
      fps: snappedFps,
      vaapi: {
        ...stream.vaapi,
        lowPower: this.fallbackState.vaapiLowPower,
        gpuColorConvert: this.fallbackState.gpuColorConvert,
      },
    };
    return { capture, encode, effectiveSettings };
  }

  private async restartVideoWithPlan(
    capture: AlignedDimensions,
    encode: AlignedDimensions,
    effectiveSettings: StreamSettings,
  ): Promise<void> {
    this.clearVideoWatchdogTimer();
    this.clearVideoRetryTimer();
    this.restartingVideo = true;
    try {
      const prevVideo = this.videoProc;
      this.videoProc = null;
      const hadPrev = prevVideo !== null;
      await this.terminateProcess(prevVideo);
      this.h264Parser.reset();

      if (hadPrev) {
        await this.waitClockMs(ENCODER_WATCHDOG_CONSTANTS.restartDelayMs);
      }
      if (this.intentionallyStopped || this.pausedForHold) {
        return;
      }

      this.spawnVideoProcess(capture, encode, effectiveSettings);
      // Commit active dimensions atomically only after the new encoder process spawns.
      this.activeCaptureDimensions = capture;
      this.activeEncodeDimensions = encode;
    } finally {
      this.restartingVideo = false;
    }
  }

  private spawnVideoProcess(
    captureDimensions: AlignedDimensions,
    encodeDimensions: AlignedDimensions,
    settings: StreamSettings,
  ): void {
    this.clearVideoWatchdogTimer();
    this.h264Parser.reset();
    this.videoStartedAtMs = this.deps.clock.monotonicMs();
    this.videoReceivedFrame = false;

    const args = buildVideoFfmpegArgs({
      backend: this.activeBackend,
      display: this.deps.display,
      captureDimensions,
      encodeDimensions,
      settings,
      vaapiDevice: this.vaapiDevice,
    });
    const env = buildEncoderProcessEnv(
      this.baseEnv,
      this.activeBackend === "vaapi" ? this.vaapiDriver : null,
      this.deps.pulseSocketPath,
    );

    const proc = this.deps.processRunner.spawn({
      command: "ffmpeg",
      args,
      env,
    });
    this.videoProc = proc;
    this.armVideoWatchdog();

    proc.onStdout((chunk) => {
      if (this.videoProc !== proc || this.intentionallyStopped || this.pausedForHold) {
        return;
      }
      const units = this.h264Parser.push(chunk);
      for (const unit of units) {
        if (unit.kind === "CONFIG") {
          this.emitPacket({
            mediaType: "video",
            flags: VIDEO_FLAG.CONFIG,
            streamEpoch: this.streamEpoch,
            ptsUs: 0n,
            payload: unit.data,
          });
          continue;
        }
        this.videoReceivedFrame = true;
        if (this.fallbackState.retryAttempt !== 0) {
          this.fallbackState = { ...this.fallbackState, retryAttempt: 0 };
        }
        this.armVideoWatchdog();
        const flags = VIDEO_FLAG.AVCC | (unit.isKeyframe ? VIDEO_FLAG.KEYFRAME : 0);
        this.emitPacket({
          mediaType: "video",
          flags,
          streamEpoch: this.streamEpoch,
          ptsUs: this.computeMasterPtsUs(),
          payload: unit.data,
        });
      }
    });

    proc.onExit(() => {
      if (this.videoProc !== proc) {
        return;
      }
      this.videoProc = null;
      this.clearVideoWatchdogTimer();
      if (this.intentionallyStopped || this.pausedForHold || this.restartingVideo) {
        return;
      }
      void this.handleUnexpectedVideoExit();
    });
  }

  private spawnAudioProcess(audioBitrateBps: number): void {
    this.opusParser.reset();
    const args = buildAudioFfmpegArgs({
      audioBitrateBps,
      pulseSocketPath: this.deps.pulseSocketPath,
    });
    const env = buildEncoderProcessEnv(this.baseEnv, null, this.deps.pulseSocketPath);

    const proc = this.deps.processRunner.spawn({
      command: "ffmpeg",
      args,
      env,
    });
    this.audioProc = proc;

    proc.onStdout((chunk) => {
      if (this.audioProc !== proc || this.intentionallyStopped || this.pausedForHold) {
        return;
      }
      const packets = this.opusParser.push(chunk);
      for (const packet of packets) {
        if (packet.kind === "CONFIG") {
          this.emitPacket({
            mediaType: "audio",
            flags: AUDIO_FLAG.CONFIG,
            streamEpoch: this.streamEpoch,
            ptsUs: 0n,
            payload: packet.data,
          });
          continue;
        }
        if (this.audioBasePtsUs === null) {
          this.audioBasePtsUs = this.computeMasterPtsUs();
          this.audioFrameCount = 0;
        }
        const ptsUs = this.audioBasePtsUs + BigInt(this.audioFrameCount) * OPUS_FRAME_DURATION_US;
        this.audioFrameCount += 1;
        this.emitPacket({
          mediaType: "audio",
          flags: AUDIO_FLAG.KEYFRAME,
          streamEpoch: this.streamEpoch,
          ptsUs,
          payload: packet.data,
        });
      }
    });

    proc.onExit(() => {
      if (this.audioProc !== proc) {
        return;
      }
      this.audioProc = null;
      if (this.intentionallyStopped || this.pausedForHold || this.restartingAudio) {
        return;
      }
      this.scheduleAudioRestart();
    });
  }

  private async handleUnexpectedVideoExit(): Promise<void> {
    const livedMs = Math.max(0, this.deps.clock.monotonicMs() - this.videoStartedAtMs);
    let delayAttempt = this.fallbackState.retryAttempt;

    if (!this.videoReceivedFrame && livedMs < ENCODER_WATCHDOG_CONSTANTS.earlyCrashWindowMs) {
      let vaapiAvailable = this.vaapiFallbackCache !== null;
      if (!vaapiAvailable && this.deps.mode === "auto" && this.fallbackState.backend === "nvenc") {
        const vaapiProbe = await detectBestEncoderBackend(
          "vaapi",
          this.deps.gpuProbe,
          this.deps.explicitVaapiDevice,
          this.deps.explicitVaapiDriver,
        );
        if (vaapiProbe.reason !== "fixed_vaapi_probe_failed") {
          this.vaapiFallbackCache = vaapiProbe;
          vaapiAvailable = true;
        }
      }

      if (this.intentionallyStopped || this.pausedForHold) {
        return;
      }

      const nextStep = computeNextFallbackStep(this.fallbackState, vaapiAvailable);
      if (nextStep !== null) {
        this.fallbackState = nextStep;
        this.activeBackend = nextStep.backend;
        if (nextStep.backend === "vaapi" && this.vaapiFallbackCache !== null) {
          this.vaapiDevice = this.vaapiFallbackCache.vaapiDevice;
          this.vaapiDriver = this.vaapiFallbackCache.vaapiDriver;
        } else if (nextStep.backend !== "vaapi") {
          this.vaapiDevice = null;
          this.vaapiDriver = null;
        }
        this.lastFallbackReason = `early_exit_${nextStep.backend}`;
        this.lastFallbackAt = new Date(this.deps.clock.nowMs()).toISOString();
        delayAttempt = nextStep.retryAttempt - 1;
      } else {
        this.lastFallbackReason = `fixed_${this.activeBackend}_retry`;
        this.lastFallbackAt = new Date(this.deps.clock.nowMs()).toISOString();
        this.fallbackState = {
          ...this.fallbackState,
          retryAttempt: this.fallbackState.retryAttempt + 1,
        };
      }
    } else {
      this.fallbackState = {
        ...this.fallbackState,
        retryAttempt: this.fallbackState.retryAttempt + 1,
      };
    }

    const delayMs = getEncoderRetryDelayMs(delayAttempt);
    this.clearVideoRetryTimer();
    this.videoRetryTimer = this.deps.clock.setTimeout(() => {
      this.videoRetryTimer = null;
      if (this.intentionallyStopped || this.pausedForHold || this.videoProc !== null) {
        return;
      }
      const stream = this.deps.settings.getCurrent().stream;
      const plan = this.computeDimensionsAndFps(this.baseLayoutDimensions, stream);
      this.spawnVideoProcess(plan.capture, plan.encode, plan.effectiveSettings);
      this.activeCaptureDimensions = plan.capture;
      this.activeEncodeDimensions = plan.encode;
    }, delayMs);
  }

  private scheduleAudioRestart(): void {
    this.clearAudioRetryTimer();
    this.audioRetryTimer = this.deps.clock.setTimeout(() => {
      this.audioRetryTimer = null;
      if (this.intentionallyStopped || this.pausedForHold || this.audioProc !== null) {
        return;
      }
      const stream = this.deps.settings.getCurrent().stream;
      this.spawnAudioProcess(stream.audioBitrate);
    }, ENCODER_WATCHDOG_CONSTANTS.audioRestartDelayMs);
  }

  private armVideoWatchdog(): void {
    this.clearVideoWatchdogTimer();
    if (this.intentionallyStopped || this.pausedForHold || this.videoProc === null) {
      return;
    }
    this.videoWatchdogTimer = this.deps.clock.setTimeout(() => {
      this.videoWatchdogTimer = null;
      if (this.intentionallyStopped || this.pausedForHold || this.videoProc === null) {
        return;
      }
      void this.restartVideoOnly();
    }, ENCODER_WATCHDOG_CONSTANTS.videoStallTimeoutMs);
  }

  private computeMasterPtsUs(): bigint {
    if (this.masterClockStartMs === null) {
      this.masterClockStartMs = this.deps.clock.monotonicMs();
    }
    const elapsedMs = Math.max(
      0,
      this.deps.clock.monotonicMs() - this.masterClockStartMs - this.timelineCompMs,
    );
    let ptsUs = BigInt(Math.round(elapsedMs * 1_000));
    if (ptsUs < this.lastVideoPtsUs) {
      ptsUs = this.lastVideoPtsUs;
    }
    this.lastVideoPtsUs = ptsUs;
    return ptsUs;
  }

  private emitPacket(packet: {
    readonly mediaType: "video" | "audio";
    readonly flags: number;
    readonly streamEpoch: number;
    readonly ptsUs: bigint;
    readonly payload: Uint8Array;
  }): void {
    for (const listener of this.listeners) {
      listener(packet);
    }
  }

  private async terminateProcess(proc: ManagedProcess | null): Promise<void> {
    if (proc === null) {
      return;
    }
    try {
      await this.deps.processRunner.terminateWithEscalation(
        proc,
        ENCODER_WATCHDOG_CONSTANTS.sigtermGraceMs,
      );
    } catch {
      // Ignore teardown errors when process already exited.
    }
  }

  private waitClockMs(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.deps.clock.setTimeout(resolve, delayMs);
    });
  }

  private clearVideoWatchdogTimer(): void {
    if (this.videoWatchdogTimer !== null) {
      this.deps.clock.clearTimeout(this.videoWatchdogTimer);
      this.videoWatchdogTimer = null;
    }
  }

  private clearVideoRetryTimer(): void {
    if (this.videoRetryTimer !== null) {
      this.deps.clock.clearTimeout(this.videoRetryTimer);
      this.videoRetryTimer = null;
    }
  }

  private clearAudioRetryTimer(): void {
    if (this.audioRetryTimer !== null) {
      this.deps.clock.clearTimeout(this.audioRetryTimer);
      this.audioRetryTimer = null;
    }
  }

  private clearAllTimers(): void {
    this.clearVideoWatchdogTimer();
    this.clearVideoRetryTimer();
    this.clearAudioRetryTimer();
  }
}
