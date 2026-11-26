import {
  CPU_PERFORMANCE_PRESETS,
  type EncoderBackend,
  GPU_PERFORMANCE_PRESETS,
  SharedValidationError,
  type VideoPerformancePreset,
} from "../types/index.js";
import {
  CLIENT_PROFILE_DEFINITIONS,
  CPU_PERFORMANCE_PRESET_DEFINITIONS,
  DEFAULT_STREAM_SETTINGS,
  GPU_PERFORMANCE_PRESET_DEFINITIONS,
  HUD_BITRATE_FALLBACK_NEXT,
  HUD_BITRATE_STEPS,
  SETUP_QUALITY_PRESET_DEFINITIONS,
  STREAM_BOUNDS,
} from "./constants.js";
import {
  type ClientProfileConfig,
  type ResolvedClientProfile,
  SETUP_QUALITY_CHOICES,
  type SetupQualityChoice,
  type StreamSettings,
} from "./schema.js";

const GPU_PRESET_SET = new Set<string>(GPU_PERFORMANCE_PRESETS);
const CPU_PRESET_SET = new Set<string>(CPU_PERFORMANCE_PRESETS);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampVideoBitrateInternal(bps: number): number {
  if (!Number.isFinite(bps)) {
    return STREAM_BOUNDS.videoBitrate.default;
  }
  return clamp(Math.round(bps), STREAM_BOUNDS.videoBitrate.min, STREAM_BOUNDS.videoBitrate.max);
}

function normalizeAllowedFps(allowedFps: readonly number[]): number[] {
  const deduped = new Set<number>();
  for (const fps of allowedFps) {
    if (Number.isFinite(fps)) {
      const rounded = Math.round(fps);
      if (rounded >= STREAM_BOUNDS.fps.min && rounded <= STREAM_BOUNDS.fps.max) {
        deduped.add(rounded);
      }
    }
  }
  if (deduped.size === 0) {
    return [...CLIENT_PROFILE_DEFINITIONS.standard.allowedFps];
  }
  return [...deduped].sort((a, b) => a - b);
}

// Spec: docs/specs/01-auth-security.md#2.3
export function parseSetupQualityChoice(input: string): SetupQualityChoice | null {
  if (typeof input !== "string") {
    return null;
  }
  const normalized = input.trim().toLowerCase();
  for (const choice of SETUP_QUALITY_CHOICES) {
    if (choice === normalized) {
      return choice;
    }
  }
  return null;
}

// Spec: docs/specs/01-auth-security.md#2.3
export function expandSetupQualityPreset(
  choice: SetupQualityChoice,
  backend: EncoderBackend,
): Partial<StreamSettings> {
  const def = SETUP_QUALITY_PRESET_DEFINITIONS[choice];
  const common: Partial<StreamSettings> = {
    fps: def.fps,
    videoBitrate: def.videoBitrate,
    displayScale: def.displayScale,
    targetBufferMs: def.targetBufferMs,
    clientProfile: {
      active: def.clientProfile,
      custom: {
        scale: DEFAULT_STREAM_SETTINGS.clientProfile.custom.scale,
        allowedFps: [...DEFAULT_STREAM_SETTINGS.clientProfile.custom.allowedFps],
      },
    },
  };

  if (backend === "software") {
    const cpuDef = CPU_PERFORMANCE_PRESET_DEFINITIONS[def.cpuPreset];
    return {
      ...common,
      preset: def.cpuPreset,
      maxSize: cpuDef.maxSize,
      x264Preset: cpuDef.x264Preset,
    };
  }

  const gpuDef = GPU_PERFORMANCE_PRESET_DEFINITIONS[def.gpuPreset];
  if (backend === "vaapi") {
    return {
      ...common,
      preset: def.gpuPreset,
      maxSize: gpuDef.maxSize,
      vaapi: {
        compressionLevel: gpuDef.compressionLevel,
        lowPower: false,
        gpuColorConvert: gpuDef.gpuColorConvert,
      },
    };
  }

  return {
    ...common,
    preset: def.gpuPreset,
    maxSize: gpuDef.maxSize,
  };
}

// Spec: docs/specs/05-encoder-gpu.md#2.4
export function resolveClientProfile(config: ClientProfileConfig): ResolvedClientProfile {
  if (config.active === "standard") {
    const def = CLIENT_PROFILE_DEFINITIONS.standard;
    return {
      name: "standard",
      scale: def.scale,
      allowedFps: [...def.allowedFps],
      defaultBitrateBps: def.defaultBitrateBps,
    };
  }
  if (config.active === "lightweight") {
    const def = CLIENT_PROFILE_DEFINITIONS.lightweight;
    return {
      name: "lightweight",
      scale: def.scale,
      allowedFps: [...def.allowedFps],
      defaultBitrateBps: def.defaultBitrateBps,
    };
  }

  const rawScale = config.custom.scale;
  const scale = Number.isFinite(rawScale)
    ? clamp(rawScale, STREAM_BOUNDS.clientProfileScale.min, STREAM_BOUNDS.clientProfileScale.max)
    : STREAM_BOUNDS.clientProfileScale.default;
  const allowedFps = normalizeAllowedFps(config.custom.allowedFps);
  const defaultBitrateBps =
    config.custom.bitrateDefault !== undefined && Number.isFinite(config.custom.bitrateDefault)
      ? clampVideoBitrateInternal(config.custom.bitrateDefault)
      : null;

  return {
    name: "custom",
    scale,
    allowedFps,
    defaultBitrateBps,
  };
}

// Spec: docs/specs/05-encoder-gpu.md#2.4
export function snapFpsToAllowed(fps: number, allowedFps: readonly number[]): number {
  const normalized = normalizeAllowedFps(allowedFps);
  const target = Number.isFinite(fps) ? fps : STREAM_BOUNDS.fps.default;
  let best = normalized[0] ?? STREAM_BOUNDS.fps.default;
  let bestDiff = Math.abs(best - target);

  for (let i = 1; i < normalized.length; i += 1) {
    const candidate = normalized[i];
    if (candidate === undefined) {
      continue;
    }
    const diff = Math.abs(candidate - target);
    if (diff < bestDiff) {
      best = candidate;
      bestDiff = diff;
    }
  }

  return best;
}

// Spec: docs/specs/05-encoder-gpu.md#2.3
export function isPresetCompatibleWithBackend(
  preset: VideoPerformancePreset,
  backend: EncoderBackend,
): boolean {
  if (backend === "software") {
    return CPU_PRESET_SET.has(preset);
  }
  return GPU_PRESET_SET.has(preset);
}

// Spec: docs/specs/05-encoder-gpu.md#2.3
export function applyPerformancePreset(
  current: StreamSettings,
  preset: VideoPerformancePreset,
  backend: EncoderBackend,
): StreamSettings {
  if (!isPresetCompatibleWithBackend(preset, backend)) {
    throw new SharedValidationError(
      "INVALID_PRESET_FOR_BACKEND",
      `Preset "${preset}" is incompatible with backend "${backend}"`,
      "stream.preset",
    );
  }

  if (preset === "custom") {
    return {
      ...current,
      preset: "custom",
    };
  }

  if (backend === "software") {
    if (preset !== "cpu_balanced" && preset !== "cpu_low_power") {
      throw new SharedValidationError(
        "INVALID_PRESET_FOR_BACKEND",
        `Preset "${preset}" is incompatible with backend "${backend}"`,
        "stream.preset",
      );
    }
    const def = CPU_PERFORMANCE_PRESET_DEFINITIONS[preset];
    return {
      ...current,
      preset,
      maxSize: def.maxSize,
      x264Preset: def.x264Preset,
    };
  }

  if (preset !== "high" && preset !== "balanced" && preset !== "low_power") {
    throw new SharedValidationError(
      "INVALID_PRESET_FOR_BACKEND",
      `Preset "${preset}" is incompatible with backend "${backend}"`,
      "stream.preset",
    );
  }
  const gpuDef = GPU_PERFORMANCE_PRESET_DEFINITIONS[preset];
  if (backend === "vaapi") {
    return {
      ...current,
      preset,
      maxSize: gpuDef.maxSize,
      vaapi: {
        ...current.vaapi,
        compressionLevel: gpuDef.compressionLevel,
        gpuColorConvert: gpuDef.gpuColorConvert,
      },
    };
  }

  return {
    ...current,
    preset,
    maxSize: gpuDef.maxSize,
  };
}

// Spec: docs/specs/07-ui-hud-settings.md#2.1
export function nextHudBitrate(currentBps: number): number {
  for (let i = 0; i < HUD_BITRATE_STEPS.length; i += 1) {
    if (HUD_BITRATE_STEPS[i] === currentBps) {
      const nextIndex = (i + 1) % HUD_BITRATE_STEPS.length;
      return HUD_BITRATE_STEPS[nextIndex] ?? HUD_BITRATE_FALLBACK_NEXT;
    }
  }
  return HUD_BITRATE_FALLBACK_NEXT;
}
