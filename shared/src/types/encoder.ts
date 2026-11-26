import type { PowerState } from "./power.js";

export const ENCODER_MODES = ["auto", "nvenc", "vaapi", "software"] as const;

export type EncoderMode = (typeof ENCODER_MODES)[number];

export const ENCODER_BACKENDS = ["nvenc", "vaapi", "software"] as const;

export type EncoderBackend = (typeof ENCODER_BACKENDS)[number];

export const VAAPI_DRIVERS = ["radeonsi", "iHD", "i965", "d3d12"] as const;

export type VaapiDriverName = (typeof VAAPI_DRIVERS)[number];

export const X264_PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
] as const;

export type X264Preset = (typeof X264_PRESETS)[number];

export const GPU_PERFORMANCE_PRESETS = ["high", "balanced", "low_power", "custom"] as const;

export type GpuPerformancePreset = (typeof GPU_PERFORMANCE_PRESETS)[number];

export const CPU_PERFORMANCE_PRESETS = ["cpu_balanced", "cpu_low_power", "custom"] as const;

export type CpuPerformancePreset = (typeof CPU_PERFORMANCE_PRESETS)[number];

export type VideoPerformancePreset = GpuPerformancePreset | CpuPerformancePreset;

export interface EncoderResolution {
  readonly width: number;
  readonly height: number;
}

export interface EncoderHealthStatus {
  readonly running: boolean;
  readonly backend: EncoderBackend;
  readonly mode: EncoderMode;
  readonly compressionLevel: number | null;
  readonly x264Preset: X264Preset | null;
  readonly vaapiDriver: string | null;
  readonly lastFallbackReason: string | null;
  readonly lastFallbackAt: string | null;
  readonly captureResolution: EncoderResolution;
  readonly encodeResolution: EncoderResolution;
}

export interface HealthResponse {
  readonly ok: boolean;
  readonly uptimeSec: number;
  readonly timestamp: string;
  readonly powerState: PowerState;
  readonly encoder: EncoderHealthStatus;
}
