import type {
  AppSettings,
  ClientProfileName,
  FavoriteItem,
  SetupQualityChoice,
  StreamSettings,
} from "./schema.js";

export const PIN_PATTERN = /^\d{4,8}$/;
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;

export const TIMEZONE_MAX_LENGTH = 64;
export const DEFAULT_TIMEZONE = "Asia/Tokyo";
export const SETUP_TIMEZONE_OPTIONS = [
  "Asia/Tokyo",
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
] as const;

export const DEFAULT_LOCALE = "ja-JP";
export const DEFAULT_HOME_URL = "https://www.youtube.com";

export const STREAM_BOUNDS = {
  fps: { min: 24, max: 60, default: 30 },
  videoBitrate: { min: 250_000, max: 2_000_000, default: 1_000_000 },
  audioBitrate: { min: 128_000, max: 320_000, default: 128_000 },
  maxSize: { min: 640, max: 1_920, default: 1_280 },
  displayScale: { min: 50, max: 250, default: 100 },
  targetBufferMs: { min: 0, max: 30_000, default: 10_000 },
  autoSleepMinutes: { min: 0, max: 1_440, default: 3, minDelayMs: 15_000 },
  clientProfileScale: { min: 0.4, max: 1.0, default: 1.0 },
  vaapiCompressionLevel: { min: 1, max: 7, default: 7 },
} as const;

export const HUD_BITRATE_STEPS = [
  250_000, 500_000, 750_000, 1_000_000, 1_500_000, 2_000_000,
] as const;

export const HUD_BITRATE_FALLBACK_NEXT = 1_500_000;

export const AUDIO_BITRATE_OPTIONS = [128_000, 192_000, 256_000, 320_000] as const;

export const TARGET_BUFFER_MS_OPTIONS = [0, 2_000, 5_000, 10_000, 20_000, 30_000] as const;

export const DISPLAY_SCALE_UI_OPTIONS = [60, 70, 80, 90, 100, 110, 120, 130] as const;

export const GPU_PERFORMANCE_PRESET_DEFINITIONS = {
  high: { maxSize: 1_920, compressionLevel: 4, gpuColorConvert: true },
  balanced: { maxSize: 1_280, compressionLevel: 7, gpuColorConvert: true },
  low_power: { maxSize: 960, compressionLevel: 7, gpuColorConvert: true },
} as const;

export const CPU_PERFORMANCE_PRESET_DEFINITIONS = {
  cpu_balanced: { maxSize: 1_280, x264Preset: "veryfast" },
  cpu_low_power: { maxSize: 960, x264Preset: "ultrafast" },
} as const;

export const CLIENT_PROFILE_DEFINITIONS = {
  standard: {
    scale: 1.0,
    allowedFps: [24, 30, 60] as readonly number[],
    defaultBitrateBps: 1_000_000,
  },
  lightweight: {
    scale: 0.65,
    allowedFps: [24, 30] as readonly number[],
    defaultBitrateBps: 500_000,
  },
} as const;

export interface SetupQualityPresetDefinition {
  readonly gpuPreset: "high" | "balanced" | "low_power";
  readonly cpuPreset: "cpu_balanced" | "cpu_low_power";
  readonly clientProfile: Extract<ClientProfileName, "standard" | "lightweight">;
  readonly fps: number;
  readonly videoBitrate: number;
  readonly displayScale: number;
  readonly targetBufferMs: number;
}

export const SETUP_QUALITY_PRESET_DEFINITIONS: Readonly<
  Record<SetupQualityChoice, SetupQualityPresetDefinition>
> = {
  high: {
    gpuPreset: "high",
    cpuPreset: "cpu_balanced",
    clientProfile: "standard",
    fps: 60,
    videoBitrate: 2_000_000,
    displayScale: 100,
    targetBufferMs: 10_000,
  },
  standard: {
    gpuPreset: "balanced",
    cpuPreset: "cpu_balanced",
    clientProfile: "standard",
    fps: 30,
    videoBitrate: 1_000_000,
    displayScale: 100,
    targetBufferMs: 10_000,
  },
  lightweight: {
    gpuPreset: "low_power",
    cpuPreset: "cpu_low_power",
    clientProfile: "lightweight",
    fps: 24,
    videoBitrate: 500_000,
    displayScale: 70,
    targetBufferMs: 2_000,
  },
};

export const MAX_FAVORITES = 100;

export const DEFAULT_FAVORITES: readonly FavoriteItem[] = [
  { id: "youtube", title: "YouTube", url: "https://www.youtube.com", isHome: true },
  { id: "tver", title: "TVer", url: "https://tver.jp", isHome: false },
  {
    id: "prime-video",
    title: "Prime Video",
    url: "https://www.amazon.co.jp/gp/video/storefront",
    isHome: false,
  },
  { id: "netflix", title: "Netflix", url: "https://www.netflix.com", isHome: false },
  { id: "abema", title: "ABEMA", url: "https://abema.tv", isHome: false },
  { id: "disney-plus", title: "Disney+", url: "https://www.disneyplus.com", isHome: false },
  { id: "u-next", title: "U-NEXT", url: "https://video.unext.jp", isHome: false },
  { id: "dazn", title: "DAZN", url: "https://www.dazn.com", isHome: false },
  { id: "niconico", title: "ニコニコ動画", url: "https://www.nicovideo.jp", isHome: false },
  { id: "twitch", title: "Twitch", url: "https://www.twitch.tv", isHome: false },
  { id: "google", title: "Google 検索", url: "https://www.google.com", isHome: false },
];

export const DEFAULT_STREAM_SETTINGS: Readonly<StreamSettings> = {
  fps: STREAM_BOUNDS.fps.default,
  videoBitrate: STREAM_BOUNDS.videoBitrate.default,
  audioBitrate: STREAM_BOUNDS.audioBitrate.default,
  maxSize: STREAM_BOUNDS.maxSize.default,
  preset: "balanced",
  x264Preset: "veryfast",
  vaapi: {
    compressionLevel: STREAM_BOUNDS.vaapiCompressionLevel.default,
    lowPower: false,
    gpuColorConvert: true,
  },
  clientProfile: {
    active: "standard",
    custom: {
      scale: STREAM_BOUNDS.clientProfileScale.default,
      allowedFps: [24, 30, 60],
    },
  },
  displayScale: STREAM_BOUNDS.displayScale.default,
  targetBufferMs: STREAM_BOUNDS.targetBufferMs.default,
  autoSleepMinutes: STREAM_BOUNDS.autoSleepMinutes.default,
  telemetryEnabled: false,
};

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = {
  isSetupCompleted: false,
  pinHash: null,
  timezone: DEFAULT_TIMEZONE,
  stream: DEFAULT_STREAM_SETTINGS,
  favorites: DEFAULT_FAVORITES,
};
