import type { EncoderBackend, VideoPerformancePreset } from "../types/index.js";
import type {
  ClientProfileConfig,
  ResolvedClientProfile,
  SetupQualityChoice,
  StreamSettings,
} from "./schema.js";

// Spec: docs/specs/01-auth-security.md#2.3
export function parseSetupQualityChoice(input: string): SetupQualityChoice | null {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/01-auth-security.md#2.3
export function expandSetupQualityPreset(
  choice: SetupQualityChoice,
  backend: EncoderBackend,
): Partial<StreamSettings> {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/05-encoder-gpu.md#2.4
export function resolveClientProfile(config: ClientProfileConfig): ResolvedClientProfile {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/05-encoder-gpu.md#2.4
export function snapFpsToAllowed(fps: number, allowedFps: readonly number[]): number {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/05-encoder-gpu.md#2.3
export function isPresetCompatibleWithBackend(
  preset: VideoPerformancePreset,
  backend: EncoderBackend,
): boolean {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/05-encoder-gpu.md#2.3
export function applyPerformancePreset(
  current: StreamSettings,
  preset: VideoPerformancePreset,
  backend: EncoderBackend,
): StreamSettings {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/07-ui-hud-settings.md#2.1
export function nextHudBitrate(currentBps: number): number {
  throw new Error("NOT_IMPLEMENTED");
}
