import {
  CPU_PERFORMANCE_PRESETS,
  type EncoderBackend,
  GPU_PERFORMANCE_PRESETS,
  type VideoPerformancePreset,
  X264_PRESETS,
  type X264Preset,
} from "../types/index.js";
import {
  CLIENT_PROFILE_DEFINITIONS,
  DEFAULT_APP_SETTINGS,
  DEFAULT_FAVORITES,
  DEFAULT_STREAM_SETTINGS,
  DEFAULT_TIMEZONE,
  DISPLAY_SCALE_UI_OPTIONS,
  PIN_PATTERN,
  STREAM_BOUNDS,
  TIMEZONE_MAX_LENGTH,
} from "./constants.js";
import { validateFavorites } from "./favorites.js";
import { isPresetCompatibleWithBackend, parseSetupQualityChoice } from "./presets.js";
import {
  type AppSettings,
  CLIENT_PROFILE_NAMES,
  type ClientProfileName,
  type PublicAppSettings,
  type SettingsUpdateInput,
  type SettingsValidationResult,
  type SetupQualityChoice,
  type StreamSettings,
} from "./schema.js";

const CLIENT_PROFILE_NAME_SET = new Set<string>(CLIENT_PROFILE_NAMES);
const X264_PRESET_SET = new Set<string>(X264_PRESETS);
const ALL_PRESET_SET = new Set<string>([...GPU_PERFORMANCE_PRESETS, ...CPU_PERFORMANCE_PRESETS]);
const DISPLAY_SCALE_UI_SET = new Set<number>(DISPLAY_SCALE_UI_OPTIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function normalizeCustomAllowedFps(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const deduped = new Set<number>();
  for (const item of raw) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      return null;
    }
    const rounded = Math.round(item);
    if (rounded >= STREAM_BOUNDS.fps.min && rounded <= STREAM_BOUNDS.fps.max) {
      deduped.add(rounded);
    }
  }
  if (deduped.size === 0) {
    return [...CLIENT_PROFILE_DEFINITIONS.standard.allowedFps];
  }
  return [...deduped].sort((a, b) => a - b);
}

function cloneDefaultStreamSettings(): StreamSettings {
  return {
    ...DEFAULT_STREAM_SETTINGS,
    vaapi: { ...DEFAULT_STREAM_SETTINGS.vaapi },
    clientProfile: {
      active: DEFAULT_STREAM_SETTINGS.clientProfile.active,
      custom: {
        scale: DEFAULT_STREAM_SETTINGS.clientProfile.custom.scale,
        allowedFps: [...DEFAULT_STREAM_SETTINGS.clientProfile.custom.allowedFps],
      },
    },
  };
}

// Spec: docs/specs/01-auth-security.md#2.1
export function isValidPin(pin: string): boolean {
  return typeof pin === "string" && PIN_PATTERN.test(pin);
}

// Spec: docs/specs/01-auth-security.md#2.3
export function isValidTimezone(timezone: string): boolean {
  if (
    typeof timezone !== "string" ||
    timezone.length === 0 ||
    timezone.length > TIMEZONE_MAX_LENGTH ||
    timezone.trim() !== timezone
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// Spec: docs/specs/06-browser-input-cdp.md#2.4
export function clampDisplayScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return STREAM_BOUNDS.displayScale.default;
  }
  return clamp(Math.round(value), STREAM_BOUNDS.displayScale.min, STREAM_BOUNDS.displayScale.max);
}

// Spec: docs/specs/07-ui-hud-settings.md#2.4
export function normalizeDisplayScaleForUi(value: unknown): number {
  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return STREAM_BOUNDS.displayScale.default;
    }
    numeric = Number(trimmed);
  } else {
    return STREAM_BOUNDS.displayScale.default;
  }

  if (!Number.isFinite(numeric) || !DISPLAY_SCALE_UI_SET.has(numeric)) {
    return STREAM_BOUNDS.displayScale.default;
  }
  return numeric;
}

// Spec: docs/specs/05-encoder-gpu.md#2.3
export function clampVideoBitrate(bps: number): number {
  if (typeof bps !== "number" || !Number.isFinite(bps)) {
    return STREAM_BOUNDS.videoBitrate.default;
  }
  return clamp(Math.round(bps), STREAM_BOUNDS.videoBitrate.min, STREAM_BOUNDS.videoBitrate.max);
}

// Spec: docs/specs/01-auth-security.md#2.3
export function validateSetupRequest(input: unknown): SettingsValidationResult<{
  readonly pin: string;
  readonly timezone: string;
  readonly qualityPreset: SetupQualityChoice | null;
}> {
  if (!isRecord(input)) {
    return {
      ok: false,
      code: "INVALID_SETTINGS",
      message: "Setup request must be an object",
    };
  }

  if (typeof input.pin !== "string" || !isValidPin(input.pin)) {
    return {
      ok: false,
      code: "INVALID_PIN",
      message: "PIN must be 4 to 8 ASCII digits",
      field: "pin",
    };
  }

  let timezone: string = DEFAULT_TIMEZONE;
  if (input.timezone !== undefined) {
    if (typeof input.timezone !== "string" || !isValidTimezone(input.timezone)) {
      return {
        ok: false,
        code: "INVALID_TIMEZONE",
        message: "Invalid IANA timezone",
        field: "timezone",
      };
    }
    timezone = input.timezone;
  }

  let qualityPreset: SetupQualityChoice | null = null;
  if (input.qualityPreset !== undefined) {
    if (typeof input.qualityPreset !== "string") {
      return {
        ok: false,
        code: "INVALID_QUALITY_PRESET",
        message: "qualityPreset must be a string",
        field: "qualityPreset",
      };
    }
    const parsed = parseSetupQualityChoice(input.qualityPreset);
    if (parsed === null) {
      return {
        ok: false,
        code: "INVALID_QUALITY_PRESET",
        message: `Unknown qualityPreset: ${input.qualityPreset}`,
        field: "qualityPreset",
      };
    }
    qualityPreset = parsed;
  }

  return {
    ok: true,
    value: {
      pin: input.pin,
      timezone,
      qualityPreset,
    },
  };
}

function validateStreamUpdate(
  rawStream: unknown,
  backend: EncoderBackend,
): SettingsValidationResult<NonNullable<SettingsUpdateInput["stream"]>> {
  if (!isRecord(rawStream)) {
    return {
      ok: false,
      code: "INVALID_SETTINGS",
      message: "stream must be an object",
      field: "stream",
    };
  }

  const out: {
    fps?: number;
    videoBitrate?: number;
    audioBitrate?: number;
    maxSize?: number;
    preset?: VideoPerformancePreset;
    x264Preset?: X264Preset;
    vaapi?: Partial<StreamSettings["vaapi"]>;
    clientProfile?: {
      active?: ClientProfileName;
      custom?: {
        scale?: number;
        allowedFps?: readonly number[];
        bitrateDefault?: number;
      };
    };
    displayScale?: number;
    targetBufferMs?: number;
    autoSleepMinutes?: number;
    telemetryEnabled?: boolean;
  } = {};

  if (rawStream.fps !== undefined) {
    if (!isFiniteInRange(rawStream.fps, STREAM_BOUNDS.fps.min, STREAM_BOUNDS.fps.max)) {
      return {
        ok: false,
        code: "INVALID_SETTINGS",
        message: `fps must be between ${STREAM_BOUNDS.fps.min} and ${STREAM_BOUNDS.fps.max}`,
        field: "stream.fps",
      };
    }
    out.fps = Math.round(rawStream.fps);
  }

  if (rawStream.videoBitrate !== undefined) {
    if (
      typeof rawStream.videoBitrate !== "number" ||
      !Number.isFinite(rawStream.videoBitrate) ||
      rawStream.videoBitrate <= 0
    ) {
      return {
        ok: false,
        code: "INVALID_BITRATE",
        message: "videoBitrate must be a positive finite number",
        field: "stream.videoBitrate",
      };
    }
    out.videoBitrate = clampVideoBitrate(rawStream.videoBitrate);
  }

  if (rawStream.audioBitrate !== undefined) {
    if (
      !isFiniteInRange(
        rawStream.audioBitrate,
        STREAM_BOUNDS.audioBitrate.min,
        STREAM_BOUNDS.audioBitrate.max,
      )
    ) {
      return {
        ok: false,
        code: "INVALID_BITRATE",
        message: `audioBitrate must be between ${STREAM_BOUNDS.audioBitrate.min} and ${STREAM_BOUNDS.audioBitrate.max}`,
        field: "stream.audioBitrate",
      };
    }
    out.audioBitrate = Math.round(rawStream.audioBitrate);
  }

  if (rawStream.maxSize !== undefined) {
    if (!isFiniteInRange(rawStream.maxSize, STREAM_BOUNDS.maxSize.min, STREAM_BOUNDS.maxSize.max)) {
      return {
        ok: false,
        code: "INVALID_DIMENSIONS",
        message: `maxSize must be between ${STREAM_BOUNDS.maxSize.min} and ${STREAM_BOUNDS.maxSize.max}`,
        field: "stream.maxSize",
      };
    }
    out.maxSize = Math.round(rawStream.maxSize);
  }

  if (rawStream.preset !== undefined) {
    if (
      typeof rawStream.preset !== "string" ||
      !ALL_PRESET_SET.has(rawStream.preset) ||
      !isPresetCompatibleWithBackend(rawStream.preset as VideoPerformancePreset, backend)
    ) {
      return {
        ok: false,
        code: "INVALID_PRESET_FOR_BACKEND",
        message: `Preset is incompatible with backend ${backend}`,
        field: "stream.preset",
      };
    }
    out.preset = rawStream.preset as VideoPerformancePreset;
  }

  if (rawStream.x264Preset !== undefined) {
    if (typeof rawStream.x264Preset !== "string" || !X264_PRESET_SET.has(rawStream.x264Preset)) {
      return {
        ok: false,
        code: "INVALID_SETTINGS",
        message: "Invalid x264Preset",
        field: "stream.x264Preset",
      };
    }
    out.x264Preset = rawStream.x264Preset as X264Preset;
  }

  if (rawStream.vaapi !== undefined) {
    if (!isRecord(rawStream.vaapi)) {
      return {
        ok: false,
        code: "INVALID_SETTINGS",
        message: "stream.vaapi must be an object",
        field: "stream.vaapi",
      };
    }
    const vaapiOut: {
      compressionLevel?: number;
      lowPower?: boolean;
      gpuColorConvert?: boolean;
    } = {};
    if (rawStream.vaapi.compressionLevel !== undefined) {
      if (
        !isFiniteInRange(
          rawStream.vaapi.compressionLevel,
          STREAM_BOUNDS.vaapiCompressionLevel.min,
          STREAM_BOUNDS.vaapiCompressionLevel.max,
        )
      ) {
        return {
          ok: false,
          code: "INVALID_SETTINGS",
          message: "Invalid vaapi.compressionLevel",
          field: "stream.vaapi.compressionLevel",
        };
      }
      vaapiOut.compressionLevel = Math.round(rawStream.vaapi.compressionLevel);
    }
    if (rawStream.vaapi.lowPower !== undefined) {
      if (typeof rawStream.vaapi.lowPower !== "boolean") {
        return {
          ok: false,
          code: "INVALID_SETTINGS",
          message: "vaapi.lowPower must be a boolean",
          field: "stream.vaapi.lowPower",
        };
      }
      vaapiOut.lowPower = rawStream.vaapi.lowPower;
    }
    if (rawStream.vaapi.gpuColorConvert !== undefined) {
      if (typeof rawStream.vaapi.gpuColorConvert !== "boolean") {
        return {
          ok: false,
          code: "INVALID_SETTINGS",
          message: "vaapi.gpuColorConvert must be a boolean",
          field: "stream.vaapi.gpuColorConvert",
        };
      }
      vaapiOut.gpuColorConvert = rawStream.vaapi.gpuColorConvert;
    }
    out.vaapi = vaapiOut;
  }

  if (rawStream.clientProfile !== undefined) {
    if (!isRecord(rawStream.clientProfile)) {
      return {
        ok: false,
        code: "INVALID_CLIENT_PROFILE",
        message: "clientProfile must be an object",
        field: "stream.clientProfile",
      };
    }
    const cpOut: {
      active?: ClientProfileName;
      custom?: {
        scale?: number;
        allowedFps?: readonly number[];
        bitrateDefault?: number;
      };
    } = {};

    if (rawStream.clientProfile.active !== undefined) {
      if (
        typeof rawStream.clientProfile.active !== "string" ||
        !CLIENT_PROFILE_NAME_SET.has(rawStream.clientProfile.active)
      ) {
        return {
          ok: false,
          code: "INVALID_CLIENT_PROFILE",
          message: "Invalid clientProfile.active",
          field: "stream.clientProfile.active",
        };
      }
      cpOut.active = rawStream.clientProfile.active as ClientProfileName;
    }

    if (rawStream.clientProfile.custom !== undefined) {
      if (!isRecord(rawStream.clientProfile.custom)) {
        return {
          ok: false,
          code: "INVALID_CLIENT_PROFILE",
          message: "clientProfile.custom must be an object",
          field: "stream.clientProfile.custom",
        };
      }
      const customRaw = rawStream.clientProfile.custom;
      const customOut: {
        scale?: number;
        allowedFps?: readonly number[];
        bitrateDefault?: number;
      } = {};

      if (customRaw.scale !== undefined) {
        if (
          !isFiniteInRange(
            customRaw.scale,
            STREAM_BOUNDS.clientProfileScale.min,
            STREAM_BOUNDS.clientProfileScale.max,
          )
        ) {
          return {
            ok: false,
            code: "INVALID_CLIENT_PROFILE",
            message: "Invalid clientProfile.custom.scale",
            field: "stream.clientProfile.custom.scale",
          };
        }
        customOut.scale = customRaw.scale;
      }

      if (customRaw.allowedFps !== undefined) {
        const normalizedFps = normalizeCustomAllowedFps(customRaw.allowedFps);
        if (normalizedFps === null) {
          return {
            ok: false,
            code: "INVALID_CLIENT_PROFILE",
            message: "Invalid clientProfile.custom.allowedFps",
            field: "stream.clientProfile.custom.allowedFps",
          };
        }
        customOut.allowedFps = normalizedFps;
      }

      if (customRaw.bitrateDefault !== undefined) {
        if (
          typeof customRaw.bitrateDefault !== "number" ||
          !Number.isFinite(customRaw.bitrateDefault) ||
          customRaw.bitrateDefault <= 0
        ) {
          return {
            ok: false,
            code: "INVALID_BITRATE",
            message: "clientProfile.custom.bitrateDefault must be a positive finite number",
            field: "stream.clientProfile.custom.bitrateDefault",
          };
        }
        customOut.bitrateDefault = clampVideoBitrate(customRaw.bitrateDefault);
      }

      cpOut.custom = customOut;
    }

    out.clientProfile = cpOut;
  }

  if (rawStream.displayScale !== undefined) {
    if (typeof rawStream.displayScale !== "number" || !Number.isFinite(rawStream.displayScale)) {
      return {
        ok: false,
        code: "INVALID_SETTINGS",
        message: "displayScale must be a finite number",
        field: "stream.displayScale",
      };
    }
    out.displayScale = clampDisplayScale(rawStream.displayScale);
  }

  if (rawStream.targetBufferMs !== undefined) {
    if (
      !isFiniteInRange(
        rawStream.targetBufferMs,
        STREAM_BOUNDS.targetBufferMs.min,
        STREAM_BOUNDS.targetBufferMs.max,
      )
    ) {
      return {
        ok: false,
        code: "INVALID_SETTINGS",
        message: "Invalid targetBufferMs",
        field: "stream.targetBufferMs",
      };
    }
    out.targetBufferMs = Math.round(rawStream.targetBufferMs);
  }

  if (rawStream.autoSleepMinutes !== undefined) {
    if (
      !isFiniteInRange(
        rawStream.autoSleepMinutes,
        STREAM_BOUNDS.autoSleepMinutes.min,
        STREAM_BOUNDS.autoSleepMinutes.max,
      )
    ) {
      return {
        ok: false,
        code: "INVALID_SETTINGS",
        message: "Invalid autoSleepMinutes",
        field: "stream.autoSleepMinutes",
      };
    }
    out.autoSleepMinutes = Math.round(rawStream.autoSleepMinutes);
  }

  if (rawStream.telemetryEnabled !== undefined) {
    if (typeof rawStream.telemetryEnabled !== "boolean") {
      return {
        ok: false,
        code: "INVALID_SETTINGS",
        message: "telemetryEnabled must be a boolean",
        field: "stream.telemetryEnabled",
      };
    }
    out.telemetryEnabled = rawStream.telemetryEnabled;
  }

  return { ok: true, value: out };
}

// Spec: docs/specs/01-auth-security.md#2.1
export function validateSettingsUpdate(
  input: unknown,
  backend: EncoderBackend,
): SettingsValidationResult<SettingsUpdateInput> {
  if (!isRecord(input)) {
    return {
      ok: false,
      code: "INVALID_SETTINGS",
      message: "Settings update payload must be an object",
    };
  }

  const out: {
    pin?: string;
    timezone?: string;
    stream?: SettingsUpdateInput["stream"];
    favorites?: SettingsUpdateInput["favorites"];
  } = {};

  if (input.pin !== undefined) {
    if (typeof input.pin !== "string") {
      return {
        ok: false,
        code: "INVALID_PIN",
        message: "PIN must be a string",
        field: "pin",
      };
    }
    if (input.pin.length > 0) {
      if (!isValidPin(input.pin)) {
        return {
          ok: false,
          code: "INVALID_PIN",
          message: "PIN must be 4 to 8 ASCII digits",
          field: "pin",
        };
      }
      out.pin = input.pin;
    }
  }

  if (input.timezone !== undefined) {
    if (typeof input.timezone !== "string" || !isValidTimezone(input.timezone)) {
      return {
        ok: false,
        code: "INVALID_TIMEZONE",
        message: "Invalid IANA timezone",
        field: "timezone",
      };
    }
    out.timezone = input.timezone;
  }

  if (input.stream !== undefined) {
    const streamResult = validateStreamUpdate(input.stream, backend);
    if (!streamResult.ok) {
      return streamResult;
    }
    out.stream = streamResult.value;
  }

  if (input.favorites !== undefined) {
    const favoritesResult = validateFavorites(input.favorites);
    if (!favoritesResult.ok) {
      return favoritesResult;
    }
    out.favorites = favoritesResult.value;
  }

  return { ok: true, value: out };
}

function sanitizeStreamSettings(rawStream: unknown): StreamSettings {
  if (!isRecord(rawStream)) {
    return cloneDefaultStreamSettings();
  }

  const defaults = DEFAULT_STREAM_SETTINGS;
  const rawVaapi = isRecord(rawStream.vaapi) ? rawStream.vaapi : null;
  const rawCp = isRecord(rawStream.clientProfile) ? rawStream.clientProfile : null;
  const rawCustom = rawCp !== null && isRecord(rawCp.custom) ? rawCp.custom : null;

  const activeProfile: ClientProfileName =
    rawCp !== null && typeof rawCp.active === "string" && CLIENT_PROFILE_NAME_SET.has(rawCp.active)
      ? (rawCp.active as ClientProfileName)
      : defaults.clientProfile.active;

  const customScale =
    rawCustom !== null && typeof rawCustom.scale === "number" && Number.isFinite(rawCustom.scale)
      ? clamp(
          rawCustom.scale,
          STREAM_BOUNDS.clientProfileScale.min,
          STREAM_BOUNDS.clientProfileScale.max,
        )
      : defaults.clientProfile.custom.scale;

  const normalizedCustomFps =
    rawCustom !== null ? normalizeCustomAllowedFps(rawCustom.allowedFps) : null;
  const customAllowedFps = normalizedCustomFps ?? [...defaults.clientProfile.custom.allowedFps];

  const customBitrateDefault =
    rawCustom !== null &&
    typeof rawCustom.bitrateDefault === "number" &&
    Number.isFinite(rawCustom.bitrateDefault) &&
    rawCustom.bitrateDefault > 0
      ? clampVideoBitrate(rawCustom.bitrateDefault)
      : undefined;

  return {
    fps:
      typeof rawStream.fps === "number" && Number.isFinite(rawStream.fps)
        ? clamp(Math.round(rawStream.fps), STREAM_BOUNDS.fps.min, STREAM_BOUNDS.fps.max)
        : defaults.fps,
    videoBitrate:
      typeof rawStream.videoBitrate === "number" &&
      Number.isFinite(rawStream.videoBitrate) &&
      rawStream.videoBitrate > 0
        ? clampVideoBitrate(rawStream.videoBitrate)
        : defaults.videoBitrate,
    audioBitrate: isFiniteInRange(
      rawStream.audioBitrate,
      STREAM_BOUNDS.audioBitrate.min,
      STREAM_BOUNDS.audioBitrate.max,
    )
      ? Math.round(rawStream.audioBitrate)
      : defaults.audioBitrate,
    maxSize:
      typeof rawStream.maxSize === "number" && Number.isFinite(rawStream.maxSize)
        ? clamp(Math.round(rawStream.maxSize), STREAM_BOUNDS.maxSize.min, STREAM_BOUNDS.maxSize.max)
        : defaults.maxSize,
    preset:
      typeof rawStream.preset === "string" && ALL_PRESET_SET.has(rawStream.preset)
        ? (rawStream.preset as VideoPerformancePreset)
        : defaults.preset,
    x264Preset:
      typeof rawStream.x264Preset === "string" && X264_PRESET_SET.has(rawStream.x264Preset)
        ? (rawStream.x264Preset as X264Preset)
        : defaults.x264Preset,
    vaapi: {
      compressionLevel:
        rawVaapi !== null &&
        typeof rawVaapi.compressionLevel === "number" &&
        Number.isFinite(rawVaapi.compressionLevel)
          ? clamp(
              Math.round(rawVaapi.compressionLevel),
              STREAM_BOUNDS.vaapiCompressionLevel.min,
              STREAM_BOUNDS.vaapiCompressionLevel.max,
            )
          : defaults.vaapi.compressionLevel,
      lowPower:
        rawVaapi !== null && typeof rawVaapi.lowPower === "boolean"
          ? rawVaapi.lowPower
          : defaults.vaapi.lowPower,
      gpuColorConvert:
        rawVaapi !== null && typeof rawVaapi.gpuColorConvert === "boolean"
          ? rawVaapi.gpuColorConvert
          : defaults.vaapi.gpuColorConvert,
    },
    clientProfile: {
      active: activeProfile,
      custom:
        customBitrateDefault !== undefined
          ? {
              scale: customScale,
              allowedFps: customAllowedFps,
              bitrateDefault: customBitrateDefault,
            }
          : {
              scale: customScale,
              allowedFps: customAllowedFps,
            },
    },
    displayScale: clampDisplayScale(rawStream.displayScale),
    targetBufferMs:
      typeof rawStream.targetBufferMs === "number" && Number.isFinite(rawStream.targetBufferMs)
        ? clamp(
            Math.round(rawStream.targetBufferMs),
            STREAM_BOUNDS.targetBufferMs.min,
            STREAM_BOUNDS.targetBufferMs.max,
          )
        : defaults.targetBufferMs,
    autoSleepMinutes:
      typeof rawStream.autoSleepMinutes === "number" && Number.isFinite(rawStream.autoSleepMinutes)
        ? clamp(
            Math.round(rawStream.autoSleepMinutes),
            STREAM_BOUNDS.autoSleepMinutes.min,
            STREAM_BOUNDS.autoSleepMinutes.max,
          )
        : defaults.autoSleepMinutes,
    telemetryEnabled:
      typeof rawStream.telemetryEnabled === "boolean"
        ? rawStream.telemetryEnabled
        : defaults.telemetryEnabled,
  };
}

// Spec: docs/specs/01-auth-security.md#4
export function sanitizeStoredSettings(raw: unknown): AppSettings {
  if (!isRecord(raw)) {
    return {
      isSetupCompleted: DEFAULT_APP_SETTINGS.isSetupCompleted,
      pinHash: DEFAULT_APP_SETTINGS.pinHash,
      timezone: DEFAULT_APP_SETTINGS.timezone,
      stream: cloneDefaultStreamSettings(),
      favorites: DEFAULT_FAVORITES.map((item) => ({ ...item })),
    };
  }

  const pinHash = typeof raw.pinHash === "string" && raw.pinHash.length > 0 ? raw.pinHash : null;
  const isSetupCompleted = raw.isSetupCompleted === true && pinHash !== null;
  const timezone =
    typeof raw.timezone === "string" && isValidTimezone(raw.timezone)
      ? raw.timezone
      : DEFAULT_TIMEZONE;
  const stream = sanitizeStreamSettings(raw.stream);
  const favoritesValidation = validateFavorites(raw.favorites);
  const favorites = favoritesValidation.ok
    ? favoritesValidation.value
    : DEFAULT_FAVORITES.map((item) => ({ ...item }));

  return {
    isSetupCompleted,
    pinHash,
    timezone,
    stream,
    favorites,
  };
}

// Spec: docs/specs/01-auth-security.md#2.1
export function toPublicSettings(settings: AppSettings): PublicAppSettings {
  const { pinHash: _pinHash, ...publicSettings } = settings;
  return publicSettings;
}
