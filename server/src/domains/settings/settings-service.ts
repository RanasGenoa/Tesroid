import {
  type AppSettings,
  applyPerformancePreset,
  DEFAULT_STREAM_SETTINGS,
  isValidTimezone,
  type SettingsUpdateInput,
  type SharedErrorCode,
  type StreamSettings,
  sanitizeStoredSettings,
  validateFavorites,
  validateSettingsUpdate,
} from "@tesroid/shared";
import type { AtomicJsonStore } from "../../infra/index.js";
import { SettingsDomainError } from "./errors.js";
import type {
  CompleteSetupRepoInput,
  SettingsChangeListener,
  SettingsRepository,
  UpdateSettingsRepoOptions,
} from "./ports.js";

export interface SettingsServiceDeps {
  readonly store: AtomicJsonStore;
  readonly filePath: string;
}

function cloneStreamSettings(stream: StreamSettings): StreamSettings {
  return {
    ...stream,
    vaapi: { ...stream.vaapi },
    clientProfile: {
      active: stream.clientProfile.active,
      custom: {
        ...stream.clientProfile.custom,
        allowedFps: [...stream.clientProfile.custom.allowedFps],
      },
    },
  };
}

function cloneAppSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    stream: cloneStreamSettings(settings.stream),
    favorites: settings.favorites.map((item) => ({ ...item })),
  };
}

function mapValidationError(code: SharedErrorCode, message: string): SettingsDomainError {
  if (code === "DUPLICATE_FAVORITE_URL") {
    return new SettingsDomainError("DUPLICATE_FAVORITE_URL", message, 400);
  }
  if (
    code === "INVALID_FAVORITE" ||
    code === "FAVORITES_LIMIT_EXCEEDED" ||
    code === "INVALID_URL_SCHEME"
  ) {
    return new SettingsDomainError("INVALID_FAVORITE", message, 400);
  }
  return new SettingsDomainError("INVALID_SETTINGS_UPDATE", message, 400);
}

export class SettingsService implements SettingsRepository {
  private readonly deps: SettingsServiceDeps;
  private current: AppSettings;
  private readonly listeners = new Set<SettingsChangeListener>();

  // Spec: docs/specs/01-auth-security.md#2.3
  constructor(deps: SettingsServiceDeps) {
    this.deps = deps;
    this.current = sanitizeStoredSettings(null);
  }

  // Spec: docs/specs/01-auth-security.md#4
  async load(): Promise<AppSettings> {
    try {
      const raw = await this.deps.store.readJson<unknown>(this.deps.filePath);
      this.current = sanitizeStoredSettings(raw);
    } catch {
      this.current = sanitizeStoredSettings(null);
    }
    return cloneAppSettings(this.current);
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.4
  getCurrent(): AppSettings {
    return cloneAppSettings(this.current);
  }

  // Spec: docs/architecture.md#3.1
  async save(next: AppSettings): Promise<AppSettings> {
    const favoritesResult = validateFavorites(next.favorites);
    if (!favoritesResult.ok) {
      throw mapValidationError(favoritesResult.code, favoritesResult.message);
    }
    if (!isValidTimezone(next.timezone)) {
      throw new SettingsDomainError("INVALID_SETTINGS_UPDATE", "Invalid IANA timezone", 400);
    }

    const snapshot = cloneAppSettings({
      ...next,
      favorites: favoritesResult.value,
    });
    await this.deps.store.writeJsonAtomic(this.deps.filePath, snapshot);
    this.current = snapshot;
    for (const listener of this.listeners) {
      listener(cloneAppSettings(snapshot));
    }
    return cloneAppSettings(snapshot);
  }

  // Spec: docs/specs/01-auth-security.md#2.3
  async completeSetup(input: CompleteSetupRepoInput): Promise<AppSettings> {
    if (this.current.isSetupCompleted) {
      throw new SettingsDomainError(
        "SETUP_ALREADY_COMPLETED",
        "Initial setup is already completed",
        403,
      );
    }
    if (
      typeof input.pinHash !== "string" ||
      input.pinHash.length === 0 ||
      !isValidTimezone(input.timezone)
    ) {
      throw new SettingsDomainError("INVALID_SETUP_INPUT", "Invalid setup input", 400);
    }

    const baseStream = cloneStreamSettings(DEFAULT_STREAM_SETTINGS);
    const patch = input.streamPatch;
    const mergedStream: StreamSettings = patch
      ? {
          ...baseStream,
          ...patch,
          vaapi: patch.vaapi ? { ...baseStream.vaapi, ...patch.vaapi } : baseStream.vaapi,
          clientProfile: patch.clientProfile
            ? {
                active: patch.clientProfile.active,
                custom: {
                  ...patch.clientProfile.custom,
                  allowedFps: [...patch.clientProfile.custom.allowedFps],
                },
              }
            : baseStream.clientProfile,
        }
      : baseStream;

    return this.save({
      isSetupCompleted: true,
      pinHash: input.pinHash,
      timezone: input.timezone,
      stream: mergedStream,
      favorites: this.current.favorites,
    });
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  async updateSettings(
    patch: SettingsUpdateInput,
    options: UpdateSettingsRepoOptions,
  ): Promise<AppSettings> {
    const validated = validateSettingsUpdate(patch, options.backend);
    if (!validated.ok) {
      throw mapValidationError(validated.code, validated.message);
    }

    const { timezone, stream: streamPatch, favorites } = validated.value;
    let nextStream = cloneStreamSettings(this.current.stream);

    if (streamPatch !== undefined) {
      if (streamPatch.preset !== undefined) {
        nextStream = applyPerformancePreset(nextStream, streamPatch.preset, options.backend);
      }

      const nextClientProfile = streamPatch.clientProfile
        ? {
            active: streamPatch.clientProfile.active ?? nextStream.clientProfile.active,
            custom: streamPatch.clientProfile.custom
              ? {
                  ...nextStream.clientProfile.custom,
                  ...streamPatch.clientProfile.custom,
                  allowedFps:
                    streamPatch.clientProfile.custom.allowedFps !== undefined
                      ? [...streamPatch.clientProfile.custom.allowedFps]
                      : [...nextStream.clientProfile.custom.allowedFps],
                }
              : nextStream.clientProfile.custom,
          }
        : nextStream.clientProfile;

      nextStream = {
        ...nextStream,
        fps: streamPatch.fps ?? nextStream.fps,
        videoBitrate: streamPatch.videoBitrate ?? nextStream.videoBitrate,
        audioBitrate: streamPatch.audioBitrate ?? nextStream.audioBitrate,
        maxSize: streamPatch.maxSize ?? nextStream.maxSize,
        x264Preset: streamPatch.x264Preset ?? nextStream.x264Preset,
        vaapi: streamPatch.vaapi ? { ...nextStream.vaapi, ...streamPatch.vaapi } : nextStream.vaapi,
        clientProfile: nextClientProfile,
        displayScale: streamPatch.displayScale ?? nextStream.displayScale,
        targetBufferMs: streamPatch.targetBufferMs ?? nextStream.targetBufferMs,
        autoSleepMinutes: streamPatch.autoSleepMinutes ?? nextStream.autoSleepMinutes,
        telemetryEnabled: streamPatch.telemetryEnabled ?? nextStream.telemetryEnabled,
      };
    }

    return this.save({
      isSetupCompleted: this.current.isSetupCompleted,
      pinHash: options.pinHash ?? this.current.pinHash,
      timezone: timezone ?? this.current.timezone,
      stream: nextStream,
      favorites: favorites ?? this.current.favorites,
    });
  }

  // Spec: docs/architecture.md#2.3
  subscribe(listener: SettingsChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
