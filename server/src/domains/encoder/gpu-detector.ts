import * as fs from "node:fs/promises";
import path from "node:path";
import type { EncoderBackend, EncoderMode } from "@tesroid/shared";
import type { ProcessRunner } from "../../infra/index.js";
import { buildEncoderProcessEnv } from "./ffmpeg-args.js";
import type { GpuHardwareProbePort, GpuProbeResult } from "./ports.js";

export const ENCODER_RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

export const ENCODER_WATCHDOG_CONSTANTS = {
  videoStallTimeoutMs: 3_000,
  earlyCrashWindowMs: 5_000,
  sigtermGraceMs: 80,
  restartDelayMs: 100,
  audioRestartDelayMs: 1_000,
  nvencProbeTimeoutMs: 8_000,
  vaapiProbeTimeoutMs: 3_000,
} as const;

export interface FallbackLadderState {
  readonly mode: EncoderMode;
  readonly backend: EncoderBackend;
  readonly vaapiLowPower: boolean;
  readonly gpuColorConvert: boolean;
  readonly retryAttempt: number;
}

const AMD_VENDOR_ID = "0x1002";
const INTEL_VENDOR_ID = "0x8086";
const DEFAULT_VAAPI_DEVICE = "/dev/dri/renderD128";
const VAINFO_H264_ENCODE_RE = /VAProfileH264[^\r\n]*VAEntrypointEncSlice/;
// VP9 Version1/2 = 10bit (Profile 1/2) HW decode. Gen 9 iHD exposes Version0 only.
// Spec: docs/specs/05-encoder-gpu.md#2.2
export function parseVainfoSupportsH264Encode(output: string): boolean {
  return VAINFO_H264_ENCODE_RE.test(output);
}

// Spec: docs/specs/05-encoder-gpu.md#2.2
export function isNvidiaVisibleFromEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.NVIDIA_VISIBLE_DEVICES?.trim().toLowerCase();
  return value !== undefined && value.length > 0 && value !== "none" && value !== "void";
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeVendorId(vendorId: string): string {
  return vendorId.trim().toLowerCase();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export interface NodeGpuHardwareProbeDeps {
  readonly processRunner: ProcessRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class NodeGpuHardwareProbe implements GpuHardwareProbePort {
  private readonly processRunner: ProcessRunner;
  private readonly env: Readonly<Record<string, string | undefined>>;

  // Spec: docs/specs/05-encoder-gpu.md#2.2
  constructor(deps: NodeGpuHardwareProbeDeps) {
    this.processRunner = deps.processRunner;
    this.env = deps.env ?? process.env;
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.2
  async hasNvidiaDevice(): Promise<boolean> {
    if (isNvidiaVisibleFromEnv(this.env)) {
      return true;
    }
    const [hasCtrl, hasGpu0] = await Promise.all([
      fileExists("/dev/nvidiactl"),
      fileExists("/dev/nvidia0"),
    ]);
    return hasCtrl || hasGpu0;
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.2
  async probeNvenc(): Promise<boolean> {
    const result = await this.processRunner.exec(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=black:s=256x144:r=30",
        "-frames:v",
        "1",
        "-c:v",
        "h264_nvenc",
        "-f",
        "null",
        "-",
      ],
      {
        timeoutMs: ENCODER_WATCHDOG_CONSTANTS.nvencProbeTimeoutMs,
      },
    );
    return !result.timedOut && result.exitCode === 0;
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.2
  async findDriRenderNodes(): Promise<
    readonly { readonly path: string; readonly vendorId: string }[]
  > {
    let entries: string[];
    try {
      entries = await fs.readdir("/dev/dri");
    } catch {
      return [];
    }

    const renderNames = entries.filter((name) => name.startsWith("renderD")).sort();
    const nodes: { readonly path: string; readonly vendorId: string }[] = [];

    for (const name of renderNames) {
      let vendorId = "";
      try {
        vendorId = (
          await fs.readFile(path.join("/sys/class/drm", name, "device/vendor"), "utf8")
        ).trim();
      } catch {
        vendorId = "";
      }
      nodes.push({
        path: path.posix.join("/dev/dri", name),
        vendorId,
      });
    }

    return nodes;
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.2
  async probeVaapiEncode(devicePath: string, driverName: string): Promise<boolean> {
    const probeEnv = buildEncoderProcessEnv(this.env, driverName, "");
    const result = await this.processRunner.exec(
      "vainfo",
      ["--display", "drm", "--device", devicePath],
      {
        timeoutMs: ENCODER_WATCHDOG_CONSTANTS.vaapiProbeTimeoutMs,
        env: probeEnv,
      },
    );
    if (result.timedOut || result.exitCode !== 0) {
      return false;
    }
    return parseVainfoSupportsH264Encode(`${result.stdout}\n${result.stderr}`);
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.2
  async hasWslDxgDevice(): Promise<boolean> {
    return fileExists("/dev/dxg");
  }
}

async function detectVaapiCandidate(
  probe: GpuHardwareProbePort,
  explicitDevice: string | null,
  explicitDriver: string | null,
): Promise<GpuProbeResult | null> {
  const allNodes = await probe.findDriRenderNodes();
  const candidateNodes =
    explicitDevice !== null
      ? (() => {
          const matching = allNodes.filter((node) => node.path === explicitDevice);
          return matching.length > 0 ? matching : [{ path: explicitDevice, vendorId: "" }];
        })()
      : allNodes;

  // Priority order: AMD (radeonsi) -> Intel (iHD -> i965) -> WSL2 (d3d12).
  for (const node of candidateNodes) {
    if (normalizeVendorId(node.vendorId) !== AMD_VENDOR_ID) {
      continue;
    }
    const drivers = explicitDriver !== null ? [explicitDriver] : ["radeonsi"];
    for (const driver of drivers) {
      if (await probe.probeVaapiEncode(node.path, driver)) {
        return {
          backend: "vaapi",
          vaapiDevice: node.path,
          vaapiDriver: driver,
          reason: `vaapi_amd_${driver}`,
        };
      }
    }
  }

  for (const node of candidateNodes) {
    if (normalizeVendorId(node.vendorId) !== INTEL_VENDOR_ID) {
      continue;
    }
    const drivers = explicitDriver !== null ? [explicitDriver] : ["iHD", "i965"];
    for (const driver of drivers) {
      if (await probe.probeVaapiEncode(node.path, driver)) {
        return {
          backend: "vaapi",
          vaapiDevice: node.path,
          vaapiDriver: driver,
          reason: `vaapi_intel_${driver}`,
        };
      }
    }
  }

  if (await probe.hasWslDxgDevice()) {
    const devicePath = explicitDevice ?? candidateNodes[0]?.path ?? DEFAULT_VAAPI_DEVICE;
    const driver = explicitDriver ?? "d3d12";
    if (await probe.probeVaapiEncode(devicePath, driver)) {
      return {
        backend: "vaapi",
        vaapiDevice: devicePath,
        vaapiDriver: driver,
        reason: `vaapi_wsl_${driver}`,
      };
    }
  }

  if (explicitDriver !== null) {
    for (const node of candidateNodes) {
      const vendor = normalizeVendorId(node.vendorId);
      if (vendor === AMD_VENDOR_ID || vendor === INTEL_VENDOR_ID) {
        continue;
      }
      if (await probe.probeVaapiEncode(node.path, explicitDriver)) {
        return {
          backend: "vaapi",
          vaapiDevice: node.path,
          vaapiDriver: explicitDriver,
          reason: `vaapi_explicit_${explicitDriver}`,
        };
      }
    }
  }

  return null;
}

// Spec: docs/specs/05-encoder-gpu.md#2.2
export async function detectBestEncoderBackend(
  mode: EncoderMode,
  probe: GpuHardwareProbePort,
  explicitVaapiDevice: string | null,
  explicitVaapiDriver: string | null,
): Promise<GpuProbeResult> {
  const explicitDevice = normalizeOptionalString(explicitVaapiDevice);
  const explicitDriver = normalizeOptionalString(explicitVaapiDriver);

  if (mode === "software") {
    return {
      backend: "software",
      vaapiDevice: null,
      vaapiDriver: null,
      reason: "fixed_software_mode",
    };
  }

  if (mode === "nvenc") {
    const hasDevice = await probe.hasNvidiaDevice();
    if (!hasDevice) {
      return {
        backend: "nvenc",
        vaapiDevice: null,
        vaapiDriver: null,
        reason: "fixed_nvenc_device_missing",
      };
    }
    const nvencOk = await probe.probeNvenc();
    return {
      backend: "nvenc",
      vaapiDevice: null,
      vaapiDriver: null,
      reason: nvencOk ? "fixed_nvenc_verified" : "fixed_nvenc_probe_failed",
    };
  }

  if (mode === "vaapi") {
    const vaapiHit = await detectVaapiCandidate(probe, explicitDevice, explicitDriver);
    if (vaapiHit !== null) {
      return vaapiHit;
    }
    const nodes = await probe.findDriRenderNodes();
    return {
      backend: "vaapi",
      vaapiDevice: explicitDevice ?? nodes[0]?.path ?? DEFAULT_VAAPI_DEVICE,
      vaapiDriver: explicitDriver,
      reason: "fixed_vaapi_probe_failed",
    };
  }

  if (await probe.hasNvidiaDevice()) {
    if (await probe.probeNvenc()) {
      return {
        backend: "nvenc",
        vaapiDevice: null,
        vaapiDriver: null,
        reason: "auto_nvenc",
      };
    }
  }

  const vaapiHit = await detectVaapiCandidate(probe, explicitDevice, explicitDriver);
  if (vaapiHit !== null) {
    return vaapiHit;
  }

  return {
    backend: "software",
    vaapiDevice: null,
    vaapiDriver: null,
    reason: "auto_fallback_software",
  };
}

// Spec: docs/specs/05-encoder-gpu.md#2.2
export function computeNextFallbackStep(
  state: FallbackLadderState,
  vaapiAvailable: boolean,
): FallbackLadderState | null {
  const retryAttempt = state.retryAttempt + 1;

  if (state.mode === "nvenc" || state.mode === "software") {
    return null;
  }

  if (state.mode === "vaapi") {
    if (state.vaapiLowPower) {
      return { ...state, vaapiLowPower: false, retryAttempt };
    }
    if (state.gpuColorConvert) {
      return { ...state, gpuColorConvert: false, retryAttempt };
    }
    return null;
  }

  if (state.backend === "nvenc") {
    if (vaapiAvailable) {
      return { ...state, backend: "vaapi", retryAttempt };
    }
    return {
      ...state,
      backend: "software",
      vaapiLowPower: false,
      gpuColorConvert: false,
      retryAttempt,
    };
  }

  if (state.backend === "vaapi") {
    if (state.vaapiLowPower) {
      return { ...state, vaapiLowPower: false, retryAttempt };
    }
    if (state.gpuColorConvert) {
      return { ...state, gpuColorConvert: false, retryAttempt };
    }
    return {
      ...state,
      backend: "software",
      vaapiLowPower: false,
      gpuColorConvert: false,
      retryAttempt,
    };
  }

  return null;
}

// Spec: docs/specs/05-encoder-gpu.md#2.2
export function getEncoderRetryDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) {
    return ENCODER_RETRY_BACKOFF_MS[0];
  }
  const index = Math.min(ENCODER_RETRY_BACKOFF_MS.length - 1, Math.floor(attempt));
  return ENCODER_RETRY_BACKOFF_MS[index] ?? ENCODER_RETRY_BACKOFF_MS[0];
}
