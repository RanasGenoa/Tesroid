import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type AuthService, isValidPin } from '../auth.js';
import { type BrowserManager, isSafeHttpUrl } from '../browser/manager.js';
import {
  ALLOWED_LOCALES,
  ALLOWED_X264_PRESETS,
  type AppConfig,
  type ClientPerformanceProfile,
  type ClientProfileConfig,
  type ConfigStore,
  CPU_PERFORMANCE_PRESETS,
  DEFAULT_FAVORITES,
  DEFAULT_HOME_FAVORITE_ID,
  type FavoriteItem,
  GPU_PERFORMANCE_PRESETS,
  PERFORMANCE_PRESET_DEFAULTS,
  type PerformancePreset,
  pinHomeFavoriteFirst,
  resolveClientProfile,
  resolveHomeUrl,
} from '../config.js';
import type { VaapiEncoder } from '../encoder/ffmpeg.js';
import type { WebSocketHandler } from '../ws/handler.js';
import { isValidTimezone } from './setup.js';

interface VerifyPinBody {
  pin: string;
}

interface UpdateSettingsBody {
  pin?: string;
  allowedDomains?: string[];
  autoSleepMinutes?: number;
  browserUrl?: string;
  displayScale?: number;
  locale?: string;
  timezone?: string;
  favorites?: FavoriteItem[];
  homeFavoriteId?: string;
  resetFavorites?: boolean;
  stream?: {
    bitrate?: number;
    maxFps?: number;
    maxSize?: number;
    audioBitrate?: number | string;
    performancePreset?: PerformancePreset;
    vaapiCompressionLevel?: number;
    vaapiLowPower?: boolean;
    vaapiGpuColorConversion?: boolean;
    x264Preset?: string;
    clientProfile?: ClientProfileConfig; // Issue #11
  };
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  configStore: ConfigStore,
  authService: AuthService,
  browserManager: BrowserManager,
  encoder?: VaapiEncoder,
  wsHandler?: WebSocketHandler,
) {
  // Helper middleware for session check
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace(/^Bearer\s+/i, '');

    if (!token || !authService.validateSession(token)) {
      reply.status(401).send({ error: 'Unauthorized: Valid PIN session required.' });
      return;
    }
  };

  // PIN verification for settings access or session establishment
  app.post<{ Body: VerifyPinBody }>('/api/auth/verify', async (req, reply) => {
    const { pin } = req.body || {};
    if (!pin) {
      return reply.status(400).send({ error: 'PIN is required.' });
    }

    const result = await authService.verifyPin(pin);
    if (!result.success) {
      return reply.status(401).send({
        error: 'Invalid PIN.',
        remainingAttempts: result.remainingAttempts,
      });
    }

    return {
      success: true,
      token: result.token,
    };
  });

  // Get current settings
  app.get('/api/settings', { preHandler: requireAuth }, async (_req, _reply) => {
    const config = configStore.getConfig();
    return {
      isSetupCompleted: config.isSetupCompleted,
      allowedDomains: config.allowedDomains,
      autoSleepMinutes: config.autoSleepMinutes,
      displayScale: config.displayScale,
      locale: config.locale || 'ja-JP',
      timezone: config.timezone || 'Asia/Tokyo',
      favorites: config.favorites,
      homeFavoriteId: config.homeFavoriteId,
      homeUrl: resolveHomeUrl(config),
      stream: config.stream,
      // Issue #11: 保存値そのものではなく、HUD/設定UIが使う実効値（選択肢・スケール）を併記
      clientProfileResolved: resolveClientProfile(config.stream),
      browserState: browserManager.getState(),
      browserUrl: browserManager.getCurrentUrl(),
      browserTitle:
        typeof browserManager.getCurrentTitle === 'function'
          ? browserManager.getCurrentTitle()
          : '',
      ...(encoder && typeof encoder.getEncoderStatus === 'function'
        ? { encoderStatus: encoder.getEncoderStatus() }
        : {}),
    };
  });

  // Update settings
  app.put<{ Body: UpdateSettingsBody }>(
    '/api/settings',
    { preHandler: requireAuth },
    async (req, reply) => {
      const {
        pin,
        allowedDomains,
        autoSleepMinutes,
        stream,
        browserUrl,
        displayScale,
        locale,
        timezone,
        favorites,
        homeFavoriteId,
        resetFavorites,
      } = req.body || {};

      if (browserUrl !== undefined && browserUrl !== '' && !isSafeHttpUrl(browserUrl)) {
        return reply
          .status(400)
          .send({ error: 'Invalid browserUrl: Only http:// and https:// URLs are permitted.' });
      }

      const updates: Partial<AppConfig> = {};
      if (allowedDomains !== undefined) updates.allowedDomains = allowedDomains;
      if (autoSleepMinutes !== undefined) updates.autoSleepMinutes = autoSleepMinutes;
      if (displayScale !== undefined && Number.isFinite(Number(displayScale))) {
        const clampedScale = Math.max(50, Math.min(250, Math.round(Number(displayScale))));
        updates.displayScale = clampedScale;
        updates.displayScaleUserSet = true;
      }
      if (locale !== undefined) {
        if (typeof locale !== 'string' || !ALLOWED_LOCALES.includes(locale.trim())) {
          return reply.status(400).send({
            error: `Invalid locale: "${locale}". Allowed locales are: ${ALLOWED_LOCALES.join(', ')}`,
          });
        }
        updates.locale = locale.trim();
      }
      if (timezone !== undefined) {
        if (typeof timezone !== 'string' || !isValidTimezone(timezone.trim())) {
          return reply.status(400).send({
            error: `Invalid timezone: "${timezone}". Must be a valid IANA timezone string (e.g. Asia/Tokyo).`,
          });
        }
        updates.timezone = timezone.trim();
      }

      if (resetFavorites === true) {
        updates.favorites = pinHomeFavoriteFirst(
          DEFAULT_FAVORITES.map((f) => ({ ...f })),
          DEFAULT_HOME_FAVORITE_ID,
        );
        updates.homeFavoriteId = DEFAULT_HOME_FAVORITE_ID;
      } else {
        if (favorites !== undefined) {
          if (!Array.isArray(favorites)) {
            return reply.status(400).send({ error: 'Invalid favorites: Must be an array.' });
          }
          if (favorites.length > 100) {
            return reply
              .status(400)
              .send({ error: 'Invalid favorites: Maximum 100 favorite items are permitted.' });
          }
          const normalizedFavorites: FavoriteItem[] = [];
          const seenIds = new Set<string>();
          for (const item of favorites) {
            if (!item || typeof item !== 'object') {
              return reply.status(400).send({ error: 'Invalid favorite item: Must be an object.' });
            }
            const id = typeof item.id === 'string' ? item.id.trim() : '';
            const title = typeof item.title === 'string' ? item.title.trim() : '';
            const url = typeof item.url === 'string' ? item.url.trim() : '';
            if (!id || !title) {
              return reply
                .status(400)
                .send({ error: 'Invalid favorite item: id and title must be non-empty strings.' });
            }
            if (!isSafeHttpUrl(url)) {
              return reply.status(400).send({
                error: 'Invalid favorite URL: Only http:// and https:// URLs are permitted.',
              });
            }
            if (seenIds.has(id)) {
              return reply.status(400).send({ error: `Duplicate favorite id: "${id}".` });
            }
            seenIds.add(id);
            normalizedFavorites.push({ id, title, url });
          }
          updates.favorites = normalizedFavorites;
        }

        if (homeFavoriteId !== undefined) {
          if (typeof homeFavoriteId !== 'string' || homeFavoriteId.trim().length === 0) {
            return reply
              .status(400)
              .send({ error: 'Invalid homeFavoriteId: Must be a non-empty string.' });
          }
          const normalizedHomeId = homeFavoriteId.trim();
          const effectiveFavorites = updates.favorites ?? configStore.getConfig().favorites;
          if (
            effectiveFavorites.length > 0 &&
            !effectiveFavorites.some((f) => f.id === normalizedHomeId)
          ) {
            return reply
              .status(400)
              .send({ error: 'Invalid homeFavoriteId: Must match an existing favorite item.' });
          }
          updates.homeFavoriteId = normalizedHomeId;
        } else if (updates.favorites !== undefined) {
          const currentHomeId = configStore.getConfig().homeFavoriteId;
          if (!updates.favorites.some((f) => f.id === currentHomeId)) {
            updates.homeFavoriteId = updates.favorites[0]?.id || DEFAULT_HOME_FAVORITE_ID;
          }
        }
      }

      if (pin !== undefined && pin !== '') {
        if (!isValidPin(pin)) {
          return reply.status(400).send({ error: 'PIN must be 4 to 8 numeric digits (0-9).' });
        }
        await authService.setPin(pin);
      }
      // Issue #11: クライアント負荷プロファイルの実効値 (ブロードキャストと再適用判定に使用)
      let clientProfileChanged = false;
      let resolvedClientProfileEffective = resolveClientProfile(configStore.getConfig().stream);
      // PR #94 レビュー (High): エンコーダへ渡すのは常に検証・スナップ・連動済みの updates.stream 側のみ。
      // 明示指定が無くなっても連動値 (D1 bitrate / D4 fps) は current と比較して差分があれば適用する。
      let streamUpdateForEncoder:
        | {
            fps?: number;
            bitrate?: string | number;
            audioBitrate?: string | number;
            compressionLevel?: number;
            lowPower?: boolean;
            gpuColorConversion?: boolean;
            x264Preset?: string;
          }
        | undefined;
      if (stream) {
        if (stream.audioBitrate !== undefined) {
          let ab: number;
          if (typeof stream.audioBitrate === 'string') {
            const str = stream.audioBitrate.toLowerCase().trim();
            if (str.endsWith('k')) {
              ab = parseFloat(str) * 1000;
            } else if (str.endsWith('m')) {
              ab = parseFloat(str) * 1000 * 1000;
            } else {
              ab = Number(str);
            }
          } else {
            ab = Number(stream.audioBitrate);
          }
          if (ab >= 128 && ab <= 320) {
            ab = ab * 1000;
          }
          if (!Number.isFinite(ab) || ab < 128000 || ab > 320000) {
            return reply.status(400).send({
              error:
                'Invalid audioBitrate: Must be between 128000 and 320000 bps (128kbps - 320kbps).',
            });
          }
          const normalizedBitrate = Math.round(ab);
          stream.audioBitrate = normalizedBitrate;
        }
        const currentStream = configStore.getConfig().stream;
        // 定義は config.ts の GPU/CPU プリセット一覧を単一ソースとする (Issue #90 review)
        const allowedPresets: PerformancePreset[] = [
          ...GPU_PERFORMANCE_PRESETS,
          ...CPU_PERFORMANCE_PRESETS,
          'custom',
        ];
        const nextPreset =
          stream.performancePreset && allowedPresets.includes(stream.performancePreset)
            ? stream.performancePreset
            : currentStream.performancePreset;
        const presetDefaults =
          nextPreset && nextPreset !== 'custom' && stream.performancePreset !== undefined
            ? PERFORMANCE_PRESET_DEFAULTS[nextPreset]
            : undefined;

        // Issue #11: クライアント負荷プロファイル (standard / lightweight / custom) の検証と保存。
        // プリセット時は規定値を resolveClientProfile が展開するため profile 名のみ保存する。
        const allowedClientProfiles: ClientPerformanceProfile[] = [
          'standard',
          'lightweight',
          'custom',
        ];
        let nextClientProfile: ClientProfileConfig | undefined = currentStream.clientProfile;
        if (stream.clientProfile !== undefined) {
          if (
            stream.clientProfile === null ||
            typeof stream.clientProfile !== 'object' ||
            Array.isArray(stream.clientProfile)
          ) {
            return reply.status(400).send({ error: 'Invalid clientProfile: Must be an object.' });
          }
          const requestedProfile = stream.clientProfile.profile;
          if (!allowedClientProfiles.includes(requestedProfile)) {
            return reply.status(400).send({
              error: 'Invalid clientProfile.profile: Must be standard, lightweight or custom.',
            });
          }
          if (requestedProfile === 'custom') {
            const resolvedCustom = resolveClientProfile({
              ...currentStream,
              clientProfile: stream.clientProfile,
            });
            nextClientProfile = {
              profile: 'custom',
              resolutionScale: resolvedCustom.resolutionScale,
              fpsOptions: resolvedCustom.fpsOptions,
              bitrateDefault: resolvedCustom.bitrateDefault,
            };
          } else {
            nextClientProfile = { profile: requestedProfile };
          }
        }
        resolvedClientProfileEffective = resolveClientProfile({
          ...currentStream,
          clientProfile: nextClientProfile,
        });
        // 実効値（スケール / FPS 選択肢 / 既定ビットレート）が変わったときのみ再適用・連動とする
        const resolvedCurrentProfile = resolveClientProfile(currentStream);
        clientProfileChanged =
          stream.clientProfile !== undefined &&
          (resolvedCurrentProfile.resolutionScale !==
            resolvedClientProfileEffective.resolutionScale ||
            resolvedCurrentProfile.bitrateDefault !==
              resolvedClientProfileEffective.bitrateDefault ||
            resolvedCurrentProfile.fpsOptions.join(',') !==
              resolvedClientProfileEffective.fpsOptions.join(','));

        const nextBitrate =
          stream.bitrate !== undefined && Number.isFinite(Number(stream.bitrate))
            ? Math.max(250000, Math.min(10000000, Math.round(Number(stream.bitrate))))
            : clientProfileChanged && resolvedClientProfileEffective.bitrateDefault !== undefined
              ? resolvedClientProfileEffective.bitrateDefault // プロファイル切替時のビットレート連動 (D1 裁定)
              : currentStream.bitrate;
        let nextMaxFps =
          stream.maxFps !== undefined && Number.isFinite(Number(stream.maxFps))
            ? Math.max(24, Math.min(60, Math.round(Number(stream.maxFps)))) // D2 裁定: 24fps 未満は不可
            : currentStream.maxFps;
        // FPS 選択肢はプロファイルが制御 (D4 裁定): 範囲外値は最も近い下位許可値へ寄せる
        const allowedFpsOptions = resolvedClientProfileEffective.fpsOptions;
        if (allowedFpsOptions.length > 0 && !allowedFpsOptions.includes(nextMaxFps)) {
          const lowerOrEqual = [...allowedFpsOptions]
            .sort((a, b) => b - a)
            .find((n) => n <= nextMaxFps);
          nextMaxFps = lowerOrEqual ?? allowedFpsOptions[0];
        }
        const nextMaxSize =
          stream.maxSize !== undefined && Number.isFinite(Number(stream.maxSize))
            ? Math.max(640, Math.min(1920, Math.round(Number(stream.maxSize))))
            : (presetDefaults?.maxSize ?? currentStream.maxSize);
        const nextCompressionLevel =
          stream.vaapiCompressionLevel !== undefined &&
          Number.isFinite(Number(stream.vaapiCompressionLevel))
            ? Math.max(1, Math.min(7, Math.round(Number(stream.vaapiCompressionLevel))))
            : (presetDefaults?.vaapiCompressionLevel ?? currentStream.vaapiCompressionLevel);
        const nextLowPower =
          stream.vaapiLowPower !== undefined
            ? Boolean(stream.vaapiLowPower)
            : (presetDefaults?.vaapiLowPower ?? currentStream.vaapiLowPower);
        const nextGpuCsc =
          stream.vaapiGpuColorConversion !== undefined
            ? Boolean(stream.vaapiGpuColorConversion)
            : (presetDefaults?.vaapiGpuColorConversion ?? currentStream.vaapiGpuColorConversion);
        // libx264 speed preset: only set for CPU presets / explicit value; GPU presets keep current.
        const requestedX264Preset =
          typeof stream.x264Preset === 'string' &&
          ALLOWED_X264_PRESETS.includes(stream.x264Preset.trim())
            ? stream.x264Preset.trim()
            : undefined;
        const nextX264Preset =
          requestedX264Preset ?? presetDefaults?.x264Preset ?? currentStream.x264Preset;

        updates.stream = {
          bitrate: nextBitrate,
          maxFps: nextMaxFps,
          maxSize: nextMaxSize,
          audioBitrate:
            typeof stream.audioBitrate === 'number'
              ? stream.audioBitrate
              : currentStream.audioBitrate,
          performancePreset: nextPreset,
          vaapiCompressionLevel: nextCompressionLevel,
          vaapiLowPower: nextLowPower,
          vaapiGpuColorConversion: nextGpuCsc,
          x264Preset: nextX264Preset,
          clientProfile: nextClientProfile,
        };

        // PR #94 レビュー (High): 明示有無に関わらず、エンコーダへ渡す値は常に正規化済み (next*) とする。
        // 連動・スナップで保存値が変わった場合 (D1 bitrate / D4 fps) も差分として encoder に適用する。
        const applyCompression =
          stream.vaapiCompressionLevel !== undefined || stream.performancePreset !== undefined;
        const applyLowPower =
          stream.vaapiLowPower !== undefined || stream.performancePreset !== undefined;
        const applyGpuCsc =
          stream.vaapiGpuColorConversion !== undefined || stream.performancePreset !== undefined;
        // libx264 speed preset (software backend, Issue #90)
        const applyX264Preset =
          stream.x264Preset !== undefined || stream.performancePreset !== undefined;
        const applyFps = stream.maxFps !== undefined || nextMaxFps !== currentStream.maxFps;
        const applyBitrate = stream.bitrate !== undefined || nextBitrate !== currentStream.bitrate;
        const applyAudioBitrate = stream.audioBitrate !== undefined;
        streamUpdateForEncoder = {
          fps: applyFps ? nextMaxFps : undefined,
          bitrate: applyBitrate ? nextBitrate : undefined,
          audioBitrate: applyAudioBitrate ? updates.stream.audioBitrate : undefined,
          compressionLevel: applyCompression ? nextCompressionLevel : undefined,
          lowPower: applyLowPower ? nextLowPower : undefined,
          gpuColorConversion: applyGpuCsc ? nextGpuCsc : undefined,
          x264Preset: applyX264Preset ? nextX264Preset : undefined,
        };
      }

      configStore.updateConfig(updates);

      if (updates.locale !== undefined && typeof browserManager.setLocale === 'function') {
        browserManager.setLocale(updates.locale);
      }
      if (updates.timezone !== undefined && typeof browserManager.setTimezone === 'function') {
        browserManager.setTimezone(updates.timezone);
      }

      if (updates.displayScale !== undefined) {
        await browserManager.setDisplayScale(updates.displayScale);
      }

      if (stream && updates.stream) {
        // PR #94 レビュー (Medium): プロファイル変更時はここで再起動せず reapplyClientProfile へ
        // 委譲し、ビットレート・FPS 連動と新しいエンコード寸法を 1 回の再起動へ統合する
        const deferEncoderToProfile = clientProfileChanged && wsHandler !== undefined;
        // PR #94 レビュー (High): エンコーダへ渡すのは正規化済み値のみ (未指定フィールドは非適用)
        const streamUpdate = streamUpdateForEncoder;
        const hasStreamChanges =
          streamUpdate !== undefined && Object.values(streamUpdate).some((v) => v !== undefined);
        if (encoder && !deferEncoderToProfile && hasStreamChanges && streamUpdate) {
          console.log(
            `[SettingsRoute] Applying validated stream config to encoder: fps=${streamUpdate.fps}, bitrate=${streamUpdate.bitrate}, audioBitrate=${streamUpdate.audioBitrate}, compressionLevel=${streamUpdate.compressionLevel}, lowPower=${streamUpdate.lowPower}, gpuCsc=${streamUpdate.gpuColorConversion}, x264Preset=${streamUpdate.x264Preset}`,
          );
          await encoder.updateConfig(streamUpdate);
        }

        if (wsHandler) {
          // Issue #11: プロファイル変更時はレイアウト寸法を変えず、エンコード出力寸法のみ再適用
          if (clientProfileChanged) {
            try {
              await wsHandler.reapplyClientProfile(
                deferEncoderToProfile ? streamUpdate : undefined,
              );
            } catch (err) {
              console.error('[SettingsRoute] reapplyClientProfile failed:', err);
            }
          }
          wsHandler.broadcastStreamSettings({
            maxFps: updates.stream.maxFps,
            bitrate: updates.stream.bitrate,
            fpsOptions: resolvedClientProfileEffective.fpsOptions,
          });
        }
      }

      if (browserUrl) {
        await browserManager.navigate(browserUrl);
      }

      return { success: true, settings: configStore.getConfig() };
    },
  );

  // Browser power management: Pause
  app.post('/api/system/sleep', { preHandler: requireAuth }, async (_req, _reply) => {
    console.log('[SettingsRoute] Sleep requested');
    encoder?.stop();
    browserManager.pause();
    return { success: true, message: 'Browser paused and encoder stopped (CPU/GPU 0%)' };
  });

  // Browser power management: Resume
  app.post('/api/system/resume', { preHandler: requireAuth }, async (_req, _reply) => {
    console.log('[SettingsRoute] Resume requested');
    browserManager.resume();
    if (encoder && !encoder.isRunning()) {
      encoder.start();
    }
    return { success: true, message: 'Browser resumed' };
  });

  // Browser restart
  app.post('/api/system/restart-browser', { preHandler: requireAuth }, async (_req, _reply) => {
    console.log('[SettingsRoute] Restart browser requested');
    await browserManager.restartChrome();
    if (encoder && !encoder.isRunning()) {
      encoder.start();
    }
    return { success: true, message: 'Browser restarted' };
  });
}
