import type { EncoderBackend } from "../types/index.js";
import type {
  AppSettings,
  PublicAppSettings,
  SettingsUpdateInput,
  SettingsValidationResult,
  SetupQualityChoice,
} from "./schema.js";

// Spec: docs/specs/01-auth-security.md#2.1
export function isValidPin(pin: string): boolean {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/01-auth-security.md#2.3
export function isValidTimezone(timezone: string): boolean {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/06-browser-input-cdp.md#2.4
export function clampDisplayScale(value: unknown): number {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/07-ui-hud-settings.md#2.4
export function normalizeDisplayScaleForUi(value: unknown): number {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/05-encoder-gpu.md#2.3
export function clampVideoBitrate(bps: number): number {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/01-auth-security.md#2.3
export function validateSetupRequest(input: unknown): SettingsValidationResult<{
  readonly pin: string;
  readonly timezone: string;
  readonly qualityPreset: SetupQualityChoice | null;
}> {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/01-auth-security.md#2.1
export function validateSettingsUpdate(
  input: unknown,
  backend: EncoderBackend,
): SettingsValidationResult<SettingsUpdateInput> {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/01-auth-security.md#4
export function sanitizeStoredSettings(raw: unknown): AppSettings {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/01-auth-security.md#2.1
export function toPublicSettings(settings: AppSettings): PublicAppSettings {
  throw new Error("NOT_IMPLEMENTED");
}
