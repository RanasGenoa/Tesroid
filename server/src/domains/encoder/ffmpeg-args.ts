import {
  type AlignedDimensions,
  clampVideoBitrate,
  type EncoderBackend,
  STREAM_BOUNDS,
  type StreamSettings,
} from "@tesroid/shared";

export interface VideoEncodeArgsInput {
  readonly backend: EncoderBackend;
  readonly display: string;
  readonly captureDimensions: AlignedDimensions;
  readonly encodeDimensions: AlignedDimensions;
  readonly settings: StreamSettings;
  readonly vaapiDevice: string | null;
}

export interface AudioEncodeArgsInput {
  readonly audioBitrateBps: number;
  readonly pulseSocketPath: string;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

// Spec: docs/specs/05-encoder-gpu.md#2.1
export function buildVideoFfmpegArgs(input: VideoEncodeArgsInput): readonly string[] {
  const fps = clampInt(
    input.settings.fps,
    STREAM_BOUNDS.fps.min,
    STREAM_BOUNDS.fps.max,
    STREAM_BOUNDS.fps.default,
  );
  const gop = Math.max(1, Math.round(fps * 2.0));
  const bitrate = clampVideoBitrate(input.settings.videoBitrate);
  const maxrate = Math.round(bitrate * 1.3);
  const bufsize = Math.round(bitrate * 0.6);

  const capW = Math.max(2, Math.round(input.captureDimensions.width));
  const capH = Math.max(2, Math.round(input.captureDimensions.height));
  const encW = Math.max(2, Math.round(input.encodeDimensions.width));
  const encH = Math.max(2, Math.round(input.encodeDimensions.height));
  const needsScale = encW !== capW || encH !== capH;

  const args: string[] = ["-hide_banner", "-loglevel", "warning"];

  if (input.backend === "vaapi") {
    const device = input.vaapiDevice?.trim() || "/dev/dri/renderD128";
    args.push("-vaapi_device", device);
  }

  args.push(
    "-f",
    "x11grab",
    "-draw_mouse",
    "0",
    "-framerate",
    String(fps),
    "-video_size",
    `${capW}x${capH}`,
    "-i",
    input.display,
  );

  if (input.backend === "vaapi") {
    const compressionLevel = clampInt(
      input.settings.vaapi.compressionLevel,
      STREAM_BOUNDS.vaapiCompressionLevel.min,
      STREAM_BOUNDS.vaapiCompressionLevel.max,
      STREAM_BOUNDS.vaapiCompressionLevel.default,
    );
    const vf = input.settings.vaapi.gpuColorConvert
      ? needsScale
        ? `hwupload,scale_vaapi=w=${encW}:h=${encH}:format=nv12`
        : "hwupload,scale_vaapi=format=nv12"
      : needsScale
        ? `scale=${encW}:${encH},format=nv12,hwupload`
        : "format=nv12,hwupload";
    args.push("-vf", vf, "-c:v", "h264_vaapi", "-compression_level", String(compressionLevel));
    if (input.settings.vaapi.lowPower) {
      args.push("-low_power", "1");
    }
  } else if (input.backend === "nvenc") {
    if (needsScale) {
      args.push("-vf", `scale=${encW}:${encH},format=yuv420p`);
    } else {
      args.push("-pix_fmt", "yuv420p");
    }
    args.push(
      "-c:v",
      "h264_nvenc",
      "-preset",
      "p1",
      "-tune",
      "ull",
      "-zerolatency",
      "1",
      "-repeat-headers",
      "1",
    );
  } else {
    if (needsScale) {
      args.push("-vf", `scale=${encW}:${encH}`);
    }
    args.push(
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      input.settings.x264Preset,
      "-tune",
      "zerolatency",
      "-x264-params",
      "repeat-headers=1:annexb=1",
    );
  }

  args.push(
    "-bf",
    "0",
    "-g",
    String(gop),
    "-b:v",
    String(bitrate),
    "-maxrate",
    String(maxrate),
    "-bufsize",
    String(bufsize),
    "-f",
    "h264",
    "pipe:1",
  );

  return args;
}

// Spec: docs/specs/05-encoder-gpu.md#2.1
export function buildAudioFfmpegArgs(input: AudioEncodeArgsInput): readonly string[] {
  const bitrate = clampInt(
    input.audioBitrateBps,
    STREAM_BOUNDS.audioBitrate.min,
    STREAM_BOUNDS.audioBitrate.max,
    STREAM_BOUNDS.audioBitrate.default,
  );
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "nobuffer",
    "-f",
    "pulse",
    "-i",
    "default",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-c:a",
    "libopus",
    "-b:a",
    String(bitrate),
    "-vbr",
    "on",
    "-application",
    "lowdelay",
    "-frame_duration",
    "20",
    "-flush_packets",
    "1",
    "-f",
    "ogg",
    "pipe:1",
  ];
}

// Spec: docs/specs/05-encoder-gpu.md#3
export function buildEncoderProcessEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  vaapiDriver: string | null,
  pulseSocketPath: string,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  delete env.TUNNEL_TOKEN;

  const trimmedSocket = pulseSocketPath.trim();
  if (trimmedSocket.length > 0) {
    env.PULSE_SERVER = trimmedSocket.startsWith("unix:") ? trimmedSocket : `unix:${trimmedSocket}`;
  }

  const normalizedDriver = vaapiDriver?.trim() || null;
  if (normalizedDriver !== null) {
    env.LIBVA_DRIVER_NAME = normalizedDriver;
    if (normalizedDriver === "d3d12") {
      env.GALLIUM_DRIVER = "d3d12";
    } else if (env.GALLIUM_DRIVER?.trim().toLowerCase() === "d3d12") {
      delete env.GALLIUM_DRIVER;
    }
  } else {
    // Preserve host-specified LIBVA_DRIVER_NAME if set, without injecting an unrequested default.
    if (env.GALLIUM_DRIVER?.trim().toLowerCase() === "d3d12") {
      delete env.GALLIUM_DRIVER;
    }
  }

  return env;
}
