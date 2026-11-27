import path from "node:path";
import { ENCODER_MODES, type EncoderMode } from "@tesroid/shared";

export interface ServerEnvConfig {
  readonly port: number;
  readonly dataDir: string;
  readonly display: string;
  readonly locale: string;
  readonly timezone: string;
  readonly encoderMode: EncoderMode;
  readonly vaapiDevice: string | null;
  readonly libvaDriverName: string | null;
  readonly telemetryLogDir: string;
  readonly clientDistPath: string;
  readonly bufferHoldExpireMinutes: number;
  readonly playbackBufferSeconds: number;
  readonly playbackBufferMaxBytes: number;
  readonly idleToBufferSeconds: number;
}

export const SERVER_ENV_DEFAULTS = {
  port: 8080,
  dataDir: "/data",
  display: ":99",
  locale: "ja-JP",
  timezone: "Asia/Tokyo",
  encoderMode: "auto" as EncoderMode,
  bufferHoldExpireMinutes: 10,
  playbackBufferSeconds: 60,
  playbackBufferMaxBytes: 48 * 1024 * 1024,
  idleToBufferSeconds: 5,
} as const;

export interface EnvReader {
  read(): ServerEnvConfig;
}

const ENCODER_MODE_SET = new Set<string>(ENCODER_MODES);
const STRICT_INT_PATTERN = /^\d+$/;

function readTrimmedString(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalExplicitSetting(value: string | undefined): string | null {
  const trimmed = readTrimmedString(value);
  if (trimmed === null || trimmed.toLowerCase() === "auto") {
    return null;
  }
  return trimmed;
}

function parseBoundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const trimmed = readTrimmedString(value);
  if (trimmed === null || !STRICT_INT_PATTERN.test(trimmed)) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function parseEncoderMode(value: string | undefined): EncoderMode {
  const trimmed = readTrimmedString(value);
  if (trimmed === null) {
    return SERVER_ENV_DEFAULTS.encoderMode;
  }
  const normalized = trimmed.toLowerCase();
  if (ENCODER_MODE_SET.has(normalized)) {
    return normalized as EncoderMode;
  }
  return SERVER_ENV_DEFAULTS.encoderMode;
}

// Spec: docs/specs/09-deploy-infra.md#2.4
export function parseServerEnv(raw: Readonly<Record<string, string | undefined>>): ServerEnvConfig {
  const dataDir = readTrimmedString(raw.DATA_DIR) ?? SERVER_ENV_DEFAULTS.dataDir;
  const telemetryLogDir =
    readTrimmedString(raw.TELEMETRY_LOG_DIR) ?? path.join(dataDir, "telemetry");

  return {
    port: parseBoundedInt(raw.PORT, SERVER_ENV_DEFAULTS.port, 1, 65_535),
    dataDir,
    display: readTrimmedString(raw.DISPLAY) ?? SERVER_ENV_DEFAULTS.display,
    locale: readTrimmedString(raw.LOCALE) ?? SERVER_ENV_DEFAULTS.locale,
    timezone: readTrimmedString(raw.TZ) ?? SERVER_ENV_DEFAULTS.timezone,
    encoderMode: parseEncoderMode(raw.ENCODER_MODE),
    vaapiDevice: readOptionalExplicitSetting(raw.VAAPI_DEVICE),
    libvaDriverName: readOptionalExplicitSetting(raw.LIBVA_DRIVER_NAME),
    telemetryLogDir,
    // 既定はイメージ/開発の作業ディレクトリ基準（/app/client/dist、repo ルート client/dist）で単一の配置規約とする。
    clientDistPath: path.resolve("client/dist"),
    bufferHoldExpireMinutes: parseBoundedInt(
      raw.BUFFER_HOLD_EXPIRE_MINUTES,
      SERVER_ENV_DEFAULTS.bufferHoldExpireMinutes,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    playbackBufferSeconds: parseBoundedInt(
      raw.PLAYBACK_BUFFER_SECONDS,
      SERVER_ENV_DEFAULTS.playbackBufferSeconds,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    playbackBufferMaxBytes: parseBoundedInt(
      raw.PLAYBACK_BUFFER_MAX_BYTES,
      SERVER_ENV_DEFAULTS.playbackBufferMaxBytes,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    idleToBufferSeconds: parseBoundedInt(
      raw.IDLE_TO_BUFFER_SECONDS,
      SERVER_ENV_DEFAULTS.idleToBufferSeconds,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

export class ProcessEnvReader implements EnvReader {
  // Spec: docs/specs/09-deploy-infra.md#2.4
  read(): ServerEnvConfig {
    return parseServerEnv(process.env);
  }
}
