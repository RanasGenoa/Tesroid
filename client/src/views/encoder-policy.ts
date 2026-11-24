// Issue #90: エンコーダーバックエンドに応じた設定UI制御の純粋ロジック。
// settings-modal.ts から呼び出し、Vitest で単体検証可能にする。

export type EncoderBackendName = 'vaapi' | 'nvenc' | 'software';

export interface EncoderStatusPayload {
  running?: boolean;
  backend?: string;
  encoderMode?: string;
  compressionLevel?: number;
  lowPower?: boolean;
  gpuColorConversion?: boolean;
  x264Preset?: string;
  libvaDriverName?: string | null;
  lastFallback?: { option?: string; timestamp?: number } | null;
  // Issue #11: レイアウト(キャプチャ)寸法と実エンコード出力寸法 (縮小時は両方表示)
  captureWidth?: number;
  captureHeight?: number;
  encodeWidth?: number;
  encodeHeight?: number;
}

export type PresetId =
  | 'high'
  | 'balanced'
  | 'low_power'
  | 'cpu_balanced'
  | 'cpu_low_power'
  | 'custom';

// サーバー側 config.ts の GPU_PERFORMANCE_PRESETS / CPU_PERFORMANCE_PRESETS と同期
export const GPU_PRESET_IDS: readonly PresetId[] = ['high', 'balanced', 'low_power'] as const;
export const CPU_PRESET_IDS: readonly PresetId[] = ['cpu_balanced', 'cpu_low_power'] as const;

/**
 * VAAPI依存コントロール（負荷優先度 / scale_vaapi / -low_power 1）を操作可能にするか。
 * ステータス未取得・バックエンド不明な間は既存挙動を壊さないよう操作可（安全側ではなく従来側）とし、
 * backend === 'software' および 'nvenc'（VAAPI引数が使われない）のときのみ明確に無効化する。
 */
export function vaapiControlsEnabled(status: EncoderStatusPayload | null): boolean {
  if (!status || typeof status.backend !== 'string') return true;
  return status.backend !== 'software' && status.backend !== 'nvenc';
}

/** バックエンドごとに表示すべきプリセットID一覧（'custom' は常に含む） */
export function visiblePresetIds(status: EncoderStatusPayload | null): PresetId[] {
  const backend = status && typeof status.backend === 'string' ? status.backend : '';
  if (backend === 'software') {
    return [...CPU_PRESET_IDS, 'custom'];
  }
  // vaapi および不明時はGPUプリセット（既存の既定挙動）
  return [...GPU_PRESET_IDS, 'custom'];
}

/**
 * 保存済みプリセットが現在のバックエンドで無効な場合、表示上は 'custom' 相当として開く。
 * （サーバー側の保存値自体は変更しない — 保存時に performancePreset を送信しないことで維持する）
 */
export function resolveDisplayPreset(
  savedPreset: string | undefined,
  status: EncoderStatusPayload | null,
): PresetId {
  const visible = visiblePresetIds(status);
  if (savedPreset && (visible as readonly string[]).includes(savedPreset)) {
    return savedPreset as PresetId;
  }
  return 'custom';
}

const FALLBACK_REASON_LABELS: Record<string, string> = {
  lowPower: 'Intel VDEnc 低電力モードを解除しました',
  gpuColorConversion: 'GPU色空間変換 (scale_vaapi) を無効化しました',
  softwareEncoder: 'CPU (libx264) エンコードへ降格しました',
};

const ENCODER_MODE_LABELS: Record<string, string> = {
  auto: '自動検出 (auto)',
  vaapi: 'VAAPI固定',
  nvenc: 'NVENC固定',
  software: 'CPU固定 (software)',
};

/**
 * 使用中エンコーダー情報の日本語表示文字列を生成する。
 * 機密（IP・パス等）は含まず、バックエンド種別とモードのみを表示する。
 */
export function describeEncoderStatus(status: EncoderStatusPayload | null): string {
  if (!status || typeof status.backend !== 'string') {
    return 'エンコーダー状態を取得できません';
  }
  let label: string;
  if (status.backend === 'software') {
    const x264 = typeof status.x264Preset === 'string' ? ` / -preset ${status.x264Preset}` : '';
    label = `CPU ソフトウェア (libx264${x264})`;
  } else if (status.backend === 'vaapi') {
    const driver =
      typeof status.libvaDriverName === 'string' && status.libvaDriverName.trim()
        ? ` / ${status.libvaDriverName.trim()}`
        : '';
    label = `VAAPI ハードウェア (h264_vaapi${driver})`;
  } else if (status.backend === 'nvenc') {
    label = 'NVENC ハードウェア (h264_nvenc)';
  } else {
    label = `不明なバックエンド (${status.backend})`;
  }
  const mode =
    status.encoderMode && ENCODER_MODE_LABELS[status.encoderMode]
      ? ` / モード: ${ENCODER_MODE_LABELS[status.encoderMode]}`
      : '';
  let fallback = '';
  if (status.lastFallback && typeof status.lastFallback.option === 'string') {
    const reason = FALLBACK_REASON_LABELS[status.lastFallback.option] || status.lastFallback.option;
    fallback = ` ⚠ ${reason}`;
  }
  // Issue #11: 実エンコード出力寸法を併記 (レイアウト縮小と異なる場合のみ縮小表示)
  let dims = '';
  if (
    typeof status.encodeWidth === 'number' &&
    typeof status.encodeHeight === 'number' &&
    status.encodeWidth > 0 &&
    status.encodeHeight > 0
  ) {
    if (
      typeof status.captureWidth === 'number' &&
      typeof status.captureHeight === 'number' &&
      (status.captureWidth !== status.encodeWidth || status.captureHeight !== status.encodeHeight)
    ) {
      dims = ` / 映像出力 ${status.encodeWidth}x${status.encodeHeight} (レイアウト ${status.captureWidth}x${status.captureHeight} から縮小)`;
    } else {
      dims = ` / 映像出力 ${status.encodeWidth}x${status.encodeHeight}`;
    }
  }
  return `${label}${mode}${dims}${fallback}`;
}
