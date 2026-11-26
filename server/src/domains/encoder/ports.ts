import type { AlignedDimensions, EncoderBackend, EncoderHealthStatus } from "@tesroid/shared";
import type { PowerEncoderPort } from "../power/ports.js";

export interface GpuProbeResult {
  readonly backend: EncoderBackend;
  readonly vaapiDevice: string | null;
  readonly vaapiDriver: string | null;
  readonly reason: string;
}

export interface EncodedMediaPacket {
  readonly mediaType: "video" | "audio";
  readonly flags: number;
  readonly streamEpoch: number;
  readonly ptsUs: bigint;
  readonly payload: Uint8Array;
}

export type EncoderPacketListener = (packet: EncodedMediaPacket) => void;

export interface GpuHardwareProbePort {
  hasNvidiaDevice(): Promise<boolean>;
  probeNvenc(): Promise<boolean>;
  findDriRenderNodes(): Promise<readonly { readonly path: string; readonly vendorId: string }[]>;
  probeVaapiEncode(devicePath: string, driverName: string): Promise<boolean>;
  hasWslDxgDevice(): Promise<boolean>;
}

export interface EncoderControlPort extends PowerEncoderPort {
  detectBackend(): Promise<GpuProbeResult>;
  getActiveBackend(): EncoderBackend;
  getHealthStatus(): EncoderHealthStatus;
  reconfigureDimensions(layoutDimensions: AlignedDimensions): Promise<void>;
  applySettingsUpdate(options: {
    readonly videoChanged: boolean;
    readonly audioChanged: boolean;
    readonly dimensionsChanged: boolean;
  }): Promise<void>;
  restartVideoOnly(): Promise<void>;
  restartAudioOnly(): Promise<void>;
  subscribePackets(listener: EncoderPacketListener): () => void;
}
