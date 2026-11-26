import type { BrowserLaunchConfig } from "./ports.js";

export interface ChromePreferencesPatch {
  readonly rawJson: string;
}

// Spec: docs/specs/06-browser-input-cdp.md#2.1
export function buildChromeLaunchArgs(config: BrowserLaunchConfig): readonly string[] {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/06-browser-input-cdp.md#2.1
export function buildXvfbLaunchArgs(display: string): readonly string[] {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/06-browser-input-cdp.md#2.1
export function buildPulseAudioLaunchArgs(): readonly string[] {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/06-browser-input-cdp.md#2.3
export function sanitizeChromePreferences(existingJson: string | null): ChromePreferencesPatch {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/05-encoder-gpu.md#3
export function buildChromeProcessEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  locale: string,
  timezone: string,
  display: string,
  pulseSocketPath: string,
): Readonly<Record<string, string>> {
  throw new Error("NOT_IMPLEMENTED");
}
