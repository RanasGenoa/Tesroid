import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type AuthService, isValidPin } from '../auth.js';
import type { BrowserManager } from '../browser/manager.js';
import {
  ALLOWED_LOCALES,
  type ClientPerformanceProfile,
  type ClientProfileConfig,
  type ConfigStore,
  PERFORMANCE_PRESET_DEFAULTS,
  type PerformancePreset,
  resolveClientProfile,
  type StreamConfig,
} from '../config.js';
import type { VaapiEncoder } from '../encoder/ffmpeg.js';
import type { LockoutManager } from '../lockout.js';
import { hasHardwareVideoDevice } from '../utils/vaapi.js';
import type { WebSocketHandler } from '../ws/handler.js';

interface SetupBody {
  pin: string;
  allowedDomains?: string[];
  locale?: string;
  timezone?: string;
  qualityPreset?: string; // Issue #101: オンボーディング 3 択（未指定時は従来デフォルト維持）
}

// Issue #101: オンボーディング 3 択 → 既存設定項目（displayScale / stream.*）への一括初期設定。
// 新しいプリセット概念は永続化せず、設定画面と同じフィールドへ初期値をセットするショートカットのみ。
export type OnboardingQualityPreset = 'high' | 'standard' | 'lightweight';

// 'custom' を含まれるプリセット名（オンボーディング 3 択のマップ先。Issue #90 の GPU/CPU 一覧と同一）
type NonCustomPerformancePreset = Exclude<PerformancePreset, 'custom'>;

interface QualityPresetSpec {
  // CPU (libx264) 環境では Issue #90 の方針に沿って有効な CPU プリセットへ安全マップする
  gpuPreset: NonCustomPerformancePreset;
  cpuPreset: NonCustomPerformancePreset;
  clientProfile: ClientPerformanceProfile;
  maxFps: number;
  bitrate: number;
  displayScale: number;
}

const ONBOARDING_QUALITY_PRESETS: Record<OnboardingQualityPreset, QualityPresetSpec> = {
  high: {
    gpuPreset: 'high',
    cpuPreset: 'cpu_balanced',
    clientProfile: 'standard',
    maxFps: 60,
    // HUD 循環の最上位段階 (streaming.ts bitrateOptions) と一致させる
    bitrate: 2_000_000,
    displayScale: 120,
  },
  standard: {
    gpuPreset: 'balanced',
    cpuPreset: 'cpu_balanced',
    clientProfile: 'standard',
    maxFps: 30,
    bitrate: 1_000_000,
    displayScale: 120,
  },
  lightweight: {
    gpuPreset: 'low_power',
    cpuPreset: 'cpu_low_power',
    clientProfile: 'lightweight',
    maxFps: 24,
    bitrate: 500_000,
    // 低解像度時の情報量確保 (Issue #101 で追加された 70% 段階)
    displayScale: 70,
  },
};

// 厳密一致の型ガード（PR #102 レビュー M1）: 前後空白や大文字は呼び出し元が先に正規化してから渡す。
export function isOnboardingQualityPreset(value: unknown): value is OnboardingQualityPreset {
  return typeof value === 'string' && Object.hasOwn(ONBOARDING_QUALITY_PRESETS, value);
}

// 選択プリセットを既存 stream.* / displayScale の正規化済み差分へ展開する。
// FPS は resolveClientProfile の実効 fpsOptions へスナップし、settings PUT と同じ範囲クランプを適用する。
export function buildQualityPresetUpdate(
  choice: OnboardingQualityPreset,
  currentStream: StreamConfig,
  backendIsSoftware: boolean,
): { displayScale: number; stream: StreamConfig } {
  const spec = ONBOARDING_QUALITY_PRESETS[choice];
  const performancePreset: NonCustomPerformancePreset = backendIsSoftware
    ? spec.cpuPreset
    : spec.gpuPreset;
  const presetDefaults = PERFORMANCE_PRESET_DEFAULTS[performancePreset];
  const clientProfile: ClientProfileConfig = { profile: spec.clientProfile };
  const resolvedProfile = resolveClientProfile({ ...currentStream, clientProfile });

  let maxFps = Math.max(24, Math.min(60, Math.round(spec.maxFps))); // D2 裁定: 24fps 未満は不可
  const allowedFpsOptions = resolvedProfile.fpsOptions;
  if (allowedFpsOptions.length > 0 && !allowedFpsOptions.includes(maxFps)) {
    const lowerOrEqual = [...allowedFpsOptions].sort((a, b) => b - a).find((n) => n <= maxFps);
    maxFps = lowerOrEqual ?? allowedFpsOptions[0];
  }

  return {
    displayScale: spec.displayScale,
    stream: {
      ...currentStream,
      bitrate: Math.max(250_000, Math.min(10_000_000, Math.round(spec.bitrate))),
      maxFps,
      maxSize: presetDefaults.maxSize,
      performancePreset,
      // CPU プリセットは VAAPI 調整項目を含まないため、既存値へ触れず x264Preset のみ設定する
      ...(presetDefaults.vaapiCompressionLevel !== undefined
        ? { vaapiCompressionLevel: presetDefaults.vaapiCompressionLevel }
        : {}),
      ...(presetDefaults.vaapiLowPower !== undefined
        ? { vaapiLowPower: presetDefaults.vaapiLowPower }
        : {}),
      ...(presetDefaults.vaapiGpuColorConversion !== undefined
        ? { vaapiGpuColorConversion: presetDefaults.vaapiGpuColorConversion }
        : {}),
      ...(presetDefaults.x264Preset !== undefined ? { x264Preset: presetDefaults.x264Preset } : {}),
      clientProfile,
    },
  };
}

export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function registerSetupRoutes(
  app: FastifyInstance,
  configStore: ConfigStore,
  authService: AuthService,
  lockoutManager: LockoutManager,
  browserManager: BrowserManager,
  wsHandler?: WebSocketHandler,
  encoder?: VaapiEncoder,
) {
  // Public status check
  app.get('/api/status', async (_req: FastifyRequest, _reply: FastifyReply) => {
    const hasDri = hasHardwareVideoDevice();

    return {
      isSetupCompleted: configStore.isSetupCompleted(),
      browserState: browserManager.getState(),
      browserUrl: browserManager.getCurrentUrl(),
      hasDri,
      consecutiveFailures: lockoutManager.getConsecutiveFailures(),
      remainingAttempts: lockoutManager.getRemainingAttempts(),
      hasActiveSession: wsHandler
        ? typeof wsHandler.hasPrimaryClients === 'function'
          ? wsHandler.hasPrimaryClients()
          : wsHandler.hasActiveClients()
        : false,
    };
  });

  // Initial setup endpoint (only permitted when not yet completed)
  app.post('/api/setup', async (req: FastifyRequest<{ Body: SetupBody }>, reply: FastifyReply) => {
    if (configStore.isSetupCompleted()) {
      return reply.status(403).send({ error: 'Setup has already been completed.' });
    }

    const { pin, allowedDomains, locale, timezone, qualityPreset } =
      req.body || ({} as Partial<SetupBody>);
    if (!isValidPin(pin)) {
      return reply.status(400).send({ error: 'PIN must be 4 to 8 numeric digits (0-9).' });
    }

    // Save PIN
    await authService.setPin(pin);

    const safeLocale =
      typeof locale === 'string' && ALLOWED_LOCALES.includes(locale.trim())
        ? locale.trim()
        : 'ja-JP';
    const safeTimezone =
      typeof timezone === 'string' && isValidTimezone(timezone.trim())
        ? timezone.trim()
        : 'Asia/Tokyo';

    // Issue #101: オンボーディング 3 択は既存設定項目への初期値ショートカット。
    // 未指定・未知値のときは従来デフォルト（stream / displayScale）をそのまま維持する。
    const normalizedChoice =
      typeof qualityPreset === 'string' ? qualityPreset.trim().toLowerCase() : undefined;
    let qualityUpdate: { displayScale: number; stream: StreamConfig } | undefined;
    if (isOnboardingQualityPreset(normalizedChoice)) {
      // CPU (libx264) 稼働環境では Issue #90 の方針に沿って有効な CPU プリセットへ安全マップする
      const backendIsSoftware = Boolean(
        encoder &&
          typeof encoder.getActiveBackend === 'function' &&
          encoder.getActiveBackend() === 'software',
      );
      qualityUpdate = buildQualityPresetUpdate(
        normalizedChoice,
        configStore.getConfig().stream,
        backendIsSoftware,
      );
    }

    // Save configuration
    configStore.updateConfig({
      allowedDomains: allowedDomains || [],
      locale: safeLocale,
      timezone: safeTimezone,
      ...(qualityUpdate
        ? { displayScale: qualityUpdate.displayScale, stream: qualityUpdate.stream }
        : {}),
    });

    if (typeof browserManager.setLocale === 'function') {
      browserManager.setLocale(safeLocale);
    }
    if (typeof browserManager.setTimezone === 'function') {
      browserManager.setTimezone(safeTimezone);
    }

    // 選択プリセットを稼働中のブラウザズーム / エンコーダ / エンコード寸法へ即時反映する。
    // 反映失敗でセットアップ自体を失敗させない（設定は保存済み、次回起動・接続時に再適用される）。
    if (qualityUpdate) {
      try {
        if (typeof browserManager.setDisplayScale === 'function') {
          await browserManager.setDisplayScale(qualityUpdate.displayScale);
        }
        const s = qualityUpdate.stream;
        if (encoder && typeof encoder.updateConfig === 'function') {
          await encoder.updateConfig({
            fps: s.maxFps,
            bitrate: s.bitrate,
            ...(s.vaapiCompressionLevel !== undefined
              ? { compressionLevel: s.vaapiCompressionLevel }
              : {}),
            ...(s.vaapiLowPower !== undefined ? { lowPower: s.vaapiLowPower } : {}),
            ...(s.vaapiGpuColorConversion !== undefined
              ? { gpuColorConversion: s.vaapiGpuColorConversion }
              : {}),
            ...(s.x264Preset !== undefined ? { x264Preset: s.x264Preset } : {}),
          });
        }
        // Issue #11 と同一経路: lightweight 選択時は最初の RESIZE 前から縮小エンコードを維持する
        if (wsHandler && typeof wsHandler.syncEncodeDimensionsFromConfig === 'function') {
          await wsHandler.syncEncodeDimensionsFromConfig();
        }
      } catch (err) {
        console.error(
          '[SetupRoute] Quality preset live re-apply failed (saved config is authoritative):',
          err,
        );
      }
    }

    return { success: true, message: 'Setup completed successfully.' };
  });
}
