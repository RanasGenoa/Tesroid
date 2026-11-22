import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_LIBVA_DRIVER_NAME = 'iHD';
export const DEFAULT_VAAPI_DEVICE = '/dev/dri/renderD128';

export type EncoderMode = 'auto' | 'vaapi' | 'software';
export type EncoderBackend = 'vaapi' | 'software';

export interface VaapiProbeResult {
  status: number | null;
  stdout: string;
  stderr?: string;
  error?: Error;
}

export interface VaapiDetectDeps {
  env?: NodeJS.ProcessEnv;
  existsSync?: (targetPath: string) => boolean;
  readdirSync?: (dirPath: string) => string[];
  readFileSync?: (filePath: string) => string;
  runVainfo?: (device: string, driver: string, env: NodeJS.ProcessEnv) => VaapiProbeResult;
}

export interface VaapiDetectedConfig {
  vaapiDevice: string;
  libvaDriverName: string;
  hasDri: boolean;
  hasDxg: boolean;
  vaapiEncodeSupported: boolean;
  reason: string;
}

interface DriverProbeOutcome {
  libvaDriverName: string;
  vaapiEncodeSupported: boolean;
  reason: string;
}

/**
 * Normalizes an environment/option string, treating empty values and `'auto'`
 * (case-insensitive) as unset (`undefined`).
 */
export function normalizeVaapiOverride(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === 'auto') {
    return undefined;
  }
  return trimmed;
}

/**
 * Resolves the VAAPI driver name (`LIBVA_DRIVER_NAME`) from an optional explicit override,
 * `process.env.LIBVA_DRIVER_NAME`, or falls back to `'iHD'`.
 * Case-insensitive `'auto'` is treated as unset.
 */
export function resolveLibvaDriverName(override?: string): string {
  return (
    normalizeVaapiOverride(override) ||
    normalizeVaapiOverride(process.env.LIBVA_DRIVER_NAME) ||
    DEFAULT_LIBVA_DRIVER_NAME
  );
}

/**
 * Resolves `ENCODER_MODE` (`'auto' | 'vaapi' | 'software'`) from an optional explicit override,
 * `process.env.ENCODER_MODE`, or defaults to `'auto'`.
 */
export function resolveEncoderMode(override?: string): EncoderMode {
  const candidate = (override?.trim() || process.env.ENCODER_MODE?.trim() || 'auto').toLowerCase();
  if (candidate === 'vaapi' || candidate === 'software' || candidate === 'auto') {
    return candidate;
  }
  return 'auto';
}

function listDriNodes(
  existsSync: (targetPath: string) => boolean,
  depsReaddirSync?: (dirPath: string) => string[],
): { renderNodes: string[]; cardNodes: string[] } {
  let entries: string[] = [];
  if (depsReaddirSync) {
    try {
      entries = depsReaddirSync('/dev/dri');
    } catch {
      entries = [];
    }
  } else if (existsSync('/dev/dri')) {
    try {
      entries = fs.readdirSync('/dev/dri');
    } catch {
      entries = [];
    }
  }

  const renderNodes = entries
    .filter((entry) => /^renderD\d+$/.test(entry) && existsSync(`/dev/dri/${entry}`))
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));

  const cardNodes = entries
    .filter((entry) => /^card\d+$/.test(entry) && existsSync(`/dev/dri/${entry}`))
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));

  return { renderNodes, cardNodes };
}

function readDriVendor(
  devicePath: string,
  readFileSync: (filePath: string) => string,
  useRealFs: boolean,
): string | null {
  let nodeBase = path.posix.basename(devicePath);
  if (useRealFs) {
    try {
      nodeBase = path.posix.basename(fs.realpathSync(devicePath));
    } catch {
      // Keep original basename if path doesn't exist or realpath fails
    }
  }
  try {
    return readFileSync(`/sys/class/drm/${nodeBase}/device/vendor`).trim().toLowerCase();
  } catch {
    return null;
  }
}

function defaultRunVainfo(
  device: string,
  _driver: string,
  env: NodeJS.ProcessEnv,
): VaapiProbeResult {
  const res = spawnSync('vainfo', ['--display', 'drm', '--device', device], {
    env,
    encoding: 'utf-8',
    timeout: 3000,
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error,
  };
}

function hasH264EncodeCapability(result: VaapiProbeResult): boolean {
  if (result.error || result.status !== 0) {
    return false;
  }
  const output = result.stdout || '';
  return output.includes('VAProfileH264') && output.includes('VAEntrypointEncSlice');
}

function probeDriverCapability(
  device: string,
  driver: string,
  baseEnv: NodeJS.ProcessEnv,
  runVainfo: (device: string, driver: string, env: NodeJS.ProcessEnv) => VaapiProbeResult,
): VaapiProbeResult {
  const probeEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    LIBVA_DRIVER_NAME: driver,
  };
  if (driver === 'd3d12' && !probeEnv.GALLIUM_DRIVER) {
    probeEnv.GALLIUM_DRIVER = 'd3d12';
  }
  return runVainfo(device, driver, probeEnv);
}

function selectVaapiDevice(
  explicitDevice: string | undefined,
  hasDxg: boolean,
  renderNodes: string[],
  existsSync: (targetPath: string) => boolean,
  readFileSync: (filePath: string) => string,
  useRealFs: boolean,
): string {
  if (explicitDevice) {
    return explicitDevice;
  }
  if (renderNodes.length > 0) {
    let firstNonNvidia: string | undefined;
    for (const node of renderNodes) {
      const candidate = `/dev/dri/${node}`;
      const vendor = readDriVendor(candidate, readFileSync, useRealFs);
      if (vendor === '0x8086' || vendor === '0x1002') {
        return candidate;
      }
      if (vendor !== '0x10de' && !firstNonNvidia) {
        firstNonNvidia = candidate;
      }
    }
    return firstNonNvidia || `/dev/dri/${renderNodes[0]}`;
  }
  if (existsSync(DEFAULT_VAAPI_DEVICE) || !hasDxg) {
    return DEFAULT_VAAPI_DEVICE;
  }
  return '';
}

function probeSingleDriver(
  vaapiDevice: string,
  deviceExists: boolean,
  driver: string,
  contextLabel: string,
  missingMessage: string,
  env: NodeJS.ProcessEnv,
  runVainfo: (device: string, driver: string, env: NodeJS.ProcessEnv) => VaapiProbeResult,
): DriverProbeOutcome {
  if (!deviceExists) {
    return {
      libvaDriverName: driver,
      vaapiEncodeSupported: false,
      reason: missingMessage,
    };
  }
  const probeRes = probeDriverCapability(vaapiDevice, driver, env, runVainfo);
  const vaapiEncodeSupported = hasH264EncodeCapability(probeRes);
  return {
    libvaDriverName: driver,
    vaapiEncodeSupported,
    reason: vaapiEncodeSupported
      ? `${contextLabel}; ${driver} supports H.264 VAAPI encode on ${vaapiDevice}`
      : `${contextLabel}; ${driver} lacks H.264 VAAPI encode (status=${probeRes.status ?? 'err'}) on ${vaapiDevice}`,
  };
}

function probeIntelDrivers(
  vaapiDevice: string,
  deviceExists: boolean,
  env: NodeJS.ProcessEnv,
  runVainfo: (device: string, driver: string, env: NodeJS.ProcessEnv) => VaapiProbeResult,
): DriverProbeOutcome {
  if (!deviceExists) {
    return {
      libvaDriverName: 'iHD',
      vaapiEncodeSupported: false,
      reason: `Intel vendor 0x8086 detected; device ${vaapiDevice} missing`,
    };
  }

  const ihdRes = probeDriverCapability(vaapiDevice, 'iHD', env, runVainfo);
  if (hasH264EncodeCapability(ihdRes)) {
    return {
      libvaDriverName: 'iHD',
      vaapiEncodeSupported: true,
      reason: `Intel vendor 0x8086; iHD supports H.264 VAAPI encode on ${vaapiDevice}`,
    };
  }

  const i965Res = probeDriverCapability(vaapiDevice, 'i965', env, runVainfo);
  if (hasH264EncodeCapability(i965Res)) {
    return {
      libvaDriverName: 'i965',
      vaapiEncodeSupported: true,
      reason: `Intel vendor 0x8086; iHD unavailable/unsupported, i965 supports H.264 VAAPI encode on ${vaapiDevice}`,
    };
  }

  if (!ihdRes.error && ihdRes.status === 0) {
    return {
      libvaDriverName: 'iHD',
      vaapiEncodeSupported: false,
      reason: `Intel vendor 0x8086; iHD initialized without H.264 VAAPI encode on ${vaapiDevice}`,
    };
  }

  if (!i965Res.error && i965Res.status === 0) {
    return {
      libvaDriverName: 'i965',
      vaapiEncodeSupported: false,
      reason: `Intel vendor 0x8086; i965 initialized without H.264 VAAPI encode on ${vaapiDevice}`,
    };
  }

  return {
    libvaDriverName: 'iHD',
    vaapiEncodeSupported: false,
    reason: `Intel vendor 0x8086; neither iHD nor i965 supports H.264 VAAPI encode on ${vaapiDevice}`,
  };
}

/**
 * Checks whether any hardware video device is available:
 * configured `vaapiDevice` (or `VAAPI_DEVICE`), any `/dev/dri/renderD*` or `/dev/dri/card*`,
 * or `/dev/dxg` (WSL2 / Docker Desktop GPU paravirtualization).
 */
export function hasHardwareVideoDevice(
  vaapiDevice?: string,
  deps?: Pick<VaapiDetectDeps, 'env' | 'existsSync' | 'readdirSync'>,
): boolean {
  const env = deps?.env ?? process.env;
  const existsSync = deps?.existsSync ?? fs.existsSync;

  const configured =
    normalizeVaapiOverride(vaapiDevice) || normalizeVaapiOverride(env.VAAPI_DEVICE);
  if (configured && configured !== 'none' && existsSync(configured)) {
    return true;
  }

  if (existsSync('/dev/dxg')) {
    return true;
  }

  if (existsSync('/dev/dri/renderD128') || existsSync('/dev/dri/card0')) {
    return true;
  }

  const { renderNodes, cardNodes } = listDriNodes(existsSync, deps?.readdirSync);
  return renderNodes.length > 0 || cardNodes.length > 0;
}

/**
 * Detects the active VAAPI device, driver (`iHD`, `i965`, `radeonsi`, `d3d12`),
 * and H.264 VAAPI encode capability (`VAProfileH264` + `VAEntrypointEncSlice`).
 */
export function detectVaapiConfig(deps?: VaapiDetectDeps): VaapiDetectedConfig {
  const env = deps?.env ?? process.env;
  const existsSync = deps?.existsSync ?? fs.existsSync;
  const readFileSync =
    deps?.readFileSync ?? ((filePath: string) => fs.readFileSync(filePath, 'utf-8'));
  const runVainfo = deps?.runVainfo ?? defaultRunVainfo;
  const useRealFs = !deps?.existsSync;

  const explicitDevice = normalizeVaapiOverride(env.VAAPI_DEVICE);
  const explicitDriver = normalizeVaapiOverride(env.LIBVA_DRIVER_NAME);

  const hasDxg = existsSync('/dev/dxg');
  const { renderNodes, cardNodes } = listDriNodes(existsSync, deps?.readdirSync);
  const hasDri =
    renderNodes.length > 0 ||
    cardNodes.length > 0 ||
    existsSync('/dev/dri/renderD128') ||
    existsSync('/dev/dri/card0');

  const vaapiDevice = selectVaapiDevice(
    explicitDevice,
    hasDxg,
    renderNodes,
    existsSync,
    readFileSync,
    useRealFs,
  );
  const deviceExists = Boolean(vaapiDevice) && vaapiDevice !== 'none' && existsSync(vaapiDevice);
  const vendor =
    vaapiDevice && vaapiDevice !== 'none'
      ? readDriVendor(vaapiDevice, readFileSync, useRealFs)
      : null;

  let outcome: DriverProbeOutcome;
  if (explicitDriver) {
    outcome = probeSingleDriver(
      vaapiDevice,
      deviceExists,
      explicitDriver,
      `explicit LIBVA_DRIVER_NAME=${explicitDriver}`,
      `explicit LIBVA_DRIVER_NAME=${explicitDriver}; VAAPI device ${vaapiDevice || '<none>'} not found`,
      env,
      runVainfo,
    );
  } else if (hasDxg) {
    outcome = probeSingleDriver(
      vaapiDevice,
      deviceExists,
      'd3d12',
      '/dev/dxg detected',
      '/dev/dxg detected without /dev/dri/renderD* (vgem required for d3d12 VAAPI)',
      env,
      runVainfo,
    );
  } else if (vendor === '0x1002') {
    outcome = probeSingleDriver(
      vaapiDevice,
      deviceExists,
      'radeonsi',
      'AMD vendor 0x1002',
      `AMD vendor 0x1002 detected; device ${vaapiDevice} missing`,
      env,
      runVainfo,
    );
  } else if (vendor === '0x8086') {
    outcome = probeIntelDrivers(vaapiDevice, deviceExists, env, runVainfo);
  } else {
    outcome = probeSingleDriver(
      vaapiDevice,
      deviceExists,
      DEFAULT_LIBVA_DRIVER_NAME,
      `fallback driver (vendor=${vendor ?? 'unknown'})`,
      `no VAAPI render node found at ${vaapiDevice || '<none>'}; fallback driver=${DEFAULT_LIBVA_DRIVER_NAME}`,
      env,
      runVainfo,
    );
  }

  return {
    vaapiDevice,
    ...outcome,
    hasDri,
    hasDxg,
  };
}
