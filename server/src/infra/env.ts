import type { EncoderMode } from "@tesroid/shared";

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

// Spec: docs/specs/09-deploy-infra.md#2.4
export function parseServerEnv(raw: Readonly<Record<string, string | undefined>>): ServerEnvConfig {
  throw new Error("NOT_IMPLEMENTED");
}

export class ProcessEnvReader implements EnvReader {
  // Spec: docs/specs/09-deploy-infra.md#2.4
  read(): ServerEnvConfig {
    throw new Error("NOT_IMPLEMENTED");
  }
}
