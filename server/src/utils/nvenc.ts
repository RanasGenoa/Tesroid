import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * NVIDIA NVENC 検出・能力プローブ (Issue #36 Phase 3)。
 *
 * NVIDIA Container Toolkit (`--gpus all` / `runtime: nvidia` / Compose の
 * `deploy.resources.reservations.devices`) が露出する次のいずれかを根拠に
 * NVIDIA デバイスの存在を判定する:
 *  - `NVIDIA_VISIBLE_DEVICES` 環境変数 (Toolkit フラグメントが注入する)
 *  - `/dev/nvidiactl` / `/dev/nvidia0` などのキャラクターデバイス
 *
 * 実際のエンコード可否は VAAPI 側と同じ「能力実測ゲート」方針に従い、
 * FFmpeg の 1 フレーム実エンコード (`h264_nvenc`) で判定する。
 */

export interface NvencProbeResult {
  status: number | null;
  stdout: string;
  stderr?: string;
  error?: Error;
}

export interface NvencDetectDeps {
  env?: NodeJS.ProcessEnv;
  existsSync?: (targetPath: string) => boolean;
  runNvencProbe?: (env: NodeJS.ProcessEnv) => NvencProbeResult;
}

export interface NvencDetectedConfig {
  hasNvidiaDevice: boolean;
  nvencEncodeSupported: boolean;
  reason: string;
}

const NVIDIA_DEVICE_PATHS = ['/dev/nvidiactl', '/dev/nvidia0'] as const;

/**
 * NVIDIA デバイスがコンテナに露出しているかを判定する。
 * `NVIDIA_VISIBLE_DEVICES` の空 / `none` / `void` は「露出なし」とみなす。
 */
export function hasNvidiaDevice(deps?: Pick<NvencDetectDeps, 'env' | 'existsSync'>): boolean {
  const env = deps?.env ?? process.env;
  const existsSync = deps?.existsSync ?? fs.existsSync;

  const visible = (env.NVIDIA_VISIBLE_DEVICES || '').trim().toLowerCase();
  if (visible && visible !== 'none' && visible !== 'void') {
    return true;
  }

  return NVIDIA_DEVICE_PATHS.some((devicePath) => existsSync(devicePath));
}

function defaultRunNvencProbe(env: NodeJS.ProcessEnv): NvencProbeResult {
  // 64x64 の単色 1 フレームを実際に h264_nvenc でエンコードして能力を実測する。
  // コンテナに NVIDIA ドライバ (libnvidia-encode.so.*) が未マウントの場合は非ゼロ終了する。
  const res = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=black:s=64x64:r=1',
      '-frames:v',
      '1',
      '-c:v',
      'h264_nvenc',
      '-preset',
      'p1',
      '-tune',
      'll',
      '-zerolatency',
      '1',
      '-f',
      'null',
      '-',
    ],
    { env, encoding: 'utf-8', timeout: 8000 },
  );
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error,
  };
}

/**
 * NVIDIA デバイス露出の有無と、FFmpeg `h264_nvenc` による H.264 エンコード能力を実測する。
 */
export function detectNvencConfig(deps?: NvencDetectDeps): NvencDetectedConfig {
  const env = deps?.env ?? process.env;
  const runNvencProbe = deps?.runNvencProbe ?? defaultRunNvencProbe;

  if (!hasNvidiaDevice({ env, existsSync: deps?.existsSync })) {
    return {
      hasNvidiaDevice: false,
      nvencEncodeSupported: false,
      reason:
        'no NVIDIA device exposed (requires NVIDIA Container Toolkit / --gpus all / runtime: nvidia)',
    };
  }

  const probe = runNvencProbe({ ...env });
  const nvencEncodeSupported = !probe.error && probe.status === 0;
  return {
    hasNvidiaDevice: true,
    nvencEncodeSupported,
    reason: nvencEncodeSupported
      ? 'h264_nvenc 1-frame encode probe succeeded on exposed NVIDIA device'
      : `h264_nvenc 1-frame encode probe failed (status=${probe.status ?? 'err'}): ${(probe.stderr || probe.error?.message || '').trim().slice(0, 200)}`,
  };
}
