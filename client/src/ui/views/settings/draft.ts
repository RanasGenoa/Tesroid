import {
  type ClientProfileName,
  isPresetCompatibleWithBackend,
  normalizeDisplayScaleForUi,
  STREAM_BOUNDS,
  type VideoPerformancePreset,
} from "@tesroid/shared";
import type { AppState } from "../../../state/index.js";

export interface GeneralDraft {
  pin: string;
  displayScale: number;
  targetBufferMs: number;
  audioBitrate: number;
  preset: VideoPerformancePreset;
  maxSize: number;
  vaapiCompressionLevel: number;
  vaapiLowPower: boolean;
  vaapiGpuColorConvert: boolean;
  clientProfileActive: ClientProfileName;
  customScale: number;
  customAllowedFpsText: string;
}

export function createDraftFromState(state: AppState): GeneralDraft | null {
  const settings = state.settings;
  if (settings === null) {
    return null;
  }
  const backend = state.health?.encoder.backend;
  const rawPreset = settings.stream.preset;
  const preset =
    backend !== undefined && !isPresetCompatibleWithBackend(rawPreset, backend)
      ? "custom"
      : rawPreset;

  return {
    pin: "",
    displayScale: normalizeDisplayScaleForUi(settings.stream.displayScale),
    targetBufferMs: settings.stream.targetBufferMs,
    audioBitrate: settings.stream.audioBitrate,
    preset,
    maxSize: settings.stream.maxSize,
    vaapiCompressionLevel: settings.stream.vaapi.compressionLevel,
    vaapiLowPower: settings.stream.vaapi.lowPower,
    vaapiGpuColorConvert: settings.stream.vaapi.gpuColorConvert,
    clientProfileActive: settings.stream.clientProfile.active,
    customScale: settings.stream.clientProfile.custom.scale,
    customAllowedFpsText: settings.stream.clientProfile.custom.allowedFps.join(","),
  };
}

export function parseAllowedFpsText(text: string): number[] {
  const values = text
    .split(",")
    .map((part) => Number(part.trim()))
    .filter(
      (num) => Number.isFinite(num) && num >= STREAM_BOUNDS.fps.min && num <= STREAM_BOUNDS.fps.max,
    );
  return values.length > 0 ? values : [24, 30];
}
