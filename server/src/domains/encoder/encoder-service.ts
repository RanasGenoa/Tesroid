import type {
  AlignedDimensions,
  EncoderBackend,
  EncoderHealthStatus,
  EncoderMode,
} from "@tesroid/shared";
import type { Clock, ProcessRunner } from "../../infra/index.js";
import type { SettingsRepository } from "../settings/ports.js";
import type {
  EncoderControlPort,
  EncoderPacketListener,
  GpuHardwareProbePort,
  GpuProbeResult,
} from "./ports.js";

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
}

export class EncoderService implements EncoderControlPort {
  // Spec: docs/specs/05-encoder-gpu.md#2.1
  constructor(deps: EncoderServiceDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.2
  detectBackend(): Promise<GpuProbeResult> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.2
  getActiveBackend(): EncoderBackend {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  getHealthStatus(): EncoderHealthStatus {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  ensureDualRunning(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  stopAll(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  advanceEpochAndResetClock(): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  pauseWithTimelineComp(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  clearTimelineComp(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  getCurrentEpoch(): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.4
  reconfigureDimensions(layoutDimensions: AlignedDimensions): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  applySettingsUpdate(options: {
    readonly videoChanged: boolean;
    readonly audioChanged: boolean;
    readonly dimensionsChanged: boolean;
  }): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  restartVideoOnly(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  restartAudioOnly(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  subscribePackets(listener: EncoderPacketListener): () => void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
