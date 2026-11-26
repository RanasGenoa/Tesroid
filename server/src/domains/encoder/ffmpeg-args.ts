import type { AlignedDimensions, EncoderBackend, StreamSettings } from "@tesroid/shared";

export interface VideoEncodeArgsInput {
  readonly backend: EncoderBackend;
  readonly display: string;
  readonly captureDimensions: AlignedDimensions;
  readonly encodeDimensions: AlignedDimensions;
  readonly settings: StreamSettings;
  readonly vaapiDevice: string | null;
}

export interface AudioEncodeArgsInput {
  readonly audioBitrateBps: number;
  readonly pulseSocketPath: string;
}

// Spec: docs/specs/05-encoder-gpu.md#2.1
export function buildVideoFfmpegArgs(input: VideoEncodeArgsInput): readonly string[] {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/05-encoder-gpu.md#2.1
export function buildAudioFfmpegArgs(input: AudioEncodeArgsInput): readonly string[] {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/05-encoder-gpu.md#3
export function buildEncoderProcessEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  vaapiDriver: string | null,
  pulseSocketPath: string,
): Readonly<Record<string, string>> {
  throw new Error("NOT_IMPLEMENTED");
}
