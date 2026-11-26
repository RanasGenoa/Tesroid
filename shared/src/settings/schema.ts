import type { SharedErrorCode, VideoPerformancePreset, X264Preset } from "../types/index.js";

export const CLIENT_PROFILE_NAMES = ["standard", "lightweight", "custom"] as const;

export type ClientProfileName = (typeof CLIENT_PROFILE_NAMES)[number];

export const SETUP_QUALITY_CHOICES = ["high", "standard", "lightweight"] as const;

export type SetupQualityChoice = (typeof SETUP_QUALITY_CHOICES)[number];

export interface ClientProfileCustomConfig {
  readonly scale: number;
  readonly allowedFps: readonly number[];
  readonly bitrateDefault?: number;
}

export interface ClientProfileConfig {
  readonly active: ClientProfileName;
  readonly custom: ClientProfileCustomConfig;
}

export interface ResolvedClientProfile {
  readonly name: ClientProfileName;
  readonly scale: number;
  readonly allowedFps: readonly number[];
  readonly defaultBitrateBps: number | null;
}

export interface VaapiAdvancedConfig {
  readonly compressionLevel: number;
  readonly lowPower: boolean;
  readonly gpuColorConvert: boolean;
}

export interface StreamSettings {
  readonly fps: number;
  readonly videoBitrate: number;
  readonly audioBitrate: number;
  readonly maxSize: number;
  readonly preset: VideoPerformancePreset;
  readonly x264Preset: X264Preset;
  readonly vaapi: VaapiAdvancedConfig;
  readonly clientProfile: ClientProfileConfig;
  readonly displayScale: number;
  readonly targetBufferMs: number;
  readonly autoSleepMinutes: number;
  readonly telemetryEnabled: boolean;
}

export interface FavoriteItem {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly isHome: boolean;
}

export interface AppSettings {
  readonly isSetupCompleted: boolean;
  readonly pinHash: string | null;
  readonly timezone: string;
  readonly stream: StreamSettings;
  readonly favorites: readonly FavoriteItem[];
}

export type PublicAppSettings = Omit<AppSettings, "pinHash">;

export interface SetupRequestInput {
  readonly pin: string;
  readonly timezone?: string;
  readonly qualityPreset?: string;
}

export interface SettingsUpdateInput {
  readonly pin?: string;
  readonly timezone?: string;
  readonly stream?: Partial<Omit<StreamSettings, "vaapi" | "clientProfile">> & {
    readonly vaapi?: Partial<VaapiAdvancedConfig>;
    readonly clientProfile?: {
      readonly active?: ClientProfileName;
      readonly custom?: Partial<ClientProfileCustomConfig>;
    };
  };
  readonly favorites?: readonly FavoriteItem[];
}

export type SettingsValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: SharedErrorCode;
      readonly message: string;
      readonly field?: string;
    };
