import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth.js';
import type { BrowserManager } from '../src/browser/manager.js';
import { CLIENT_PROFILE_DEFAULTS, ConfigStore, resolveClientProfile } from '../src/config.js';
import { computeEncodeDimensions } from '../src/encoder/encode-dimensions.js';
import { VaapiEncoder } from '../src/encoder/ffmpeg.js';
import { LockoutManager } from '../src/lockout.js';
import { registerSettingsRoutes } from '../src/routes/settings.js';

describe('Client load profile (Issue #11)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-client-profile-'));

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('resolveClientProfile', () => {
    it('未設定時は standard (= 現行動作と同一)', () => {
      const resolved = resolveClientProfile(undefined);
      expect(resolved.resolutionScale).toBe(1.0);
      expect(resolved.fpsOptions).toEqual([24, 30, 60]);
      expect(resolved.bitrateDefault).toBe(1_000_000);
    });

    it('lightweight は Phase 0 実車計測で容認確認済みの値 (D1 裁定)', () => {
      const resolved = resolveClientProfile({ clientProfile: { profile: 'lightweight' } } as never);
      expect(resolved.resolutionScale).toBe(CLIENT_PROFILE_DEFAULTS.lightweight.resolutionScale);
      expect(resolved.resolutionScale).toBe(0.65);
      expect(resolved.fpsOptions).toEqual([24, 30]);
      expect(resolved.bitrateDefault).toBe(700_000);
    });

    it('custom は範囲クランプ・重複排除・昇順ソート', () => {
      const resolved = resolveClientProfile({
        clientProfile: {
          profile: 'custom',
          resolutionScale: 0.2,
          fpsOptions: [90, 30, 24, 24, 10],
          bitrateDefault: 50_000_000,
        },
      } as never);
      expect(resolved.resolutionScale).toBe(0.4); // 下限クランプ
      expect(resolved.fpsOptions).toEqual([24, 30]); // 15..60 外除去・重複排除・昇順
      expect(resolved.bitrateDefault).toBe(10_000_000); // 上限クランプ
    });

    it('custom で FPS 指定なし / 24未満のみの指定は standard 選択肢へフォールバック (D2: 24fps 下限)', () => {
      const resolved = resolveClientProfile({
        clientProfile: { profile: 'custom', fpsOptions: [15, 12] },
      } as never);
      // 24 未満はすべて除外され、空集合になるため standard 既定値へフォールバックする
      expect(resolved.fpsOptions).toEqual([24, 30, 60]);
      const empty = resolveClientProfile({
        clientProfile: { profile: 'custom', fpsOptions: [] },
      } as never);
      expect(empty.fpsOptions).toEqual([24, 30, 60]);
    });
  });

  describe('computeEncodeDimensions', () => {
    it('scale >= 1.0 は null (現行と完全同一のFFmpeg引数パス)', () => {
      expect(computeEncodeDimensions(1280, 720, 1.0)).toBeNull();
      expect(computeEncodeDimensions(1280, 720, 1.5)).toBeNull();
    });

    it('車載レイアウト 966x752 × 0.65 → H.264 MB整合へ切り下げ (624x488)', () => {
      expect(computeEncodeDimensions(966, 752, 0.65)).toEqual({ width: 624, height: 488 });
    });

    it('幅は 8 の倍数・高さは 2 の倍数に切り下げる', () => {
      const dims = computeEncodeDimensions(1281, 721, 0.85);
      if (!dims) {
        throw new Error('expected encode dimensions for scale 0.85');
      }
      expect(dims.width % 8).toBe(0);
      expect(dims.height % 2).toBe(0);
    });

    it('元寸法と同等以上の場合は null (フィルタ追加なし)', () => {
      expect(computeEncodeDimensions(320, 240, 0.9)).toBeNull();
    });
  });

  describe('FFmpeg encode scaling (Issue #11 D3: レイアウト/エンコード分離)', () => {
    const stubStartVideo = (encoder: VaapiEncoder) => {
      (encoder as unknown as { startVideo: () => void }).startVideo = () => {};
    };

    it('VAAPI + GPU色空間変換経路は scale_vaapi=w:h を追加し、null で現行と同一引数に復帰', async () => {
      const encoder = new VaapiEncoder({ width: 1280, height: 720 });
      stubStartVideo(encoder);

      await encoder.setEncodeDimensions({ width: 832, height: 512 });
      const status = encoder.getEncoderStatus();
      expect(status.captureWidth).toBe(1280);
      expect(status.encodeWidth).toBe(832);
      const scaled = encoder.buildVideoArgs().join(' ');
      expect(scaled).toContain('hwupload,scale_vaapi=w=832:h=512:format=nv12');

      await encoder.setEncodeDimensions(null);
      const restored = encoder.buildVideoArgs().join(' ');
      expect(restored).toContain('hwupload,scale_vaapi=format=nv12');
      expect(restored).not.toContain('scale_vaapi=w=');
    });

    it('CPU 色空間変換経路は scale=W:H,format=nv12,hwupload を追加', async () => {
      const encoder = new VaapiEncoder({ width: 1280, height: 720, gpuColorConversion: false });
      stubStartVideo(encoder);
      await encoder.setEncodeDimensions({ width: 640, height: 480 });
      expect(encoder.buildVideoArgs().join(' ')).toContain('scale=640:480,format=nv12,hwupload');
    });
  });

  describe('PUT /api/settings clientProfile', () => {
    const makeApp = async () => {
      // ケースごとに独立した設定ディレクトリ (ConfigStore の永続化がテスト間で漏れないようにする)
      const caseDir = fs.mkdtempSync(path.join(tmpDir, 'case-'));
      const configStore = new ConfigStore(caseDir);
      const lockoutManager = new LockoutManager(tmpDir);
      const authService = new AuthService(configStore, lockoutManager);
      await authService.setPin('1234');
      const token = (await authService.verifyPin('1234')).token;

      const browserManager = {
        getState: vi.fn().mockReturnValue('active'),
        getCurrentUrl: vi.fn().mockReturnValue('https://www.youtube.com'),
        navigate: vi.fn().mockResolvedValue(undefined),
      } as unknown as BrowserManager;
      const mockEncoder = {
        updateConfig: vi.fn().mockResolvedValue(undefined),
      } as unknown as VaapiEncoder;
      const mockWsHandler = {
        broadcastStreamSettings: vi.fn(),
        reapplyClientProfile: vi.fn().mockResolvedValue(undefined),
      } as never;

      const app = fastify();
      registerSettingsRoutes(
        app,
        configStore,
        authService,
        browserManager,
        mockEncoder,
        mockWsHandler,
      );
      return { app, configStore, token, mockEncoder, mockWsHandler };
    };

    it('standard → lightweight 切替で FPS 選択肢外値をスナップしビットレートへ連動させる (D1/D4 裁定)', async () => {
      const { app, configStore, token, mockWsHandler } = await makeApp();

      // 事前: standard で maxFps=60 を許可範囲として保存
      const first = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { authorization: `Bearer ${token}` },
        payload: { stream: { maxFps: 60, bitrate: 2_000_000 } },
      });
      expect(first.statusCode).toBe(200);
      expect(configStore.getConfig().stream.maxFps).toBe(60);

      // プロファイルのみ切替 (ビットレート・FPS 明示なし)
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { authorization: `Bearer ${token}` },
        payload: { stream: { clientProfile: { profile: 'lightweight' } } },
      });
      expect(res.statusCode).toBe(200);

      const saved = configStore.getConfig().stream;
      expect(saved.clientProfile?.profile).toBe('lightweight');
      expect(saved.maxFps).toBe(30); // 60 → 選択肢 [24,30] の最も近い下位へ
      expect(saved.bitrate).toBe(700_000); // bitrateDefault 連動

      // エンコード寸法の再適用が呼ばれ、HUD へ fpsOptions がブロードキャストされる
      expect(mockWsHandler.reapplyClientProfile).toHaveBeenCalledTimes(1);
      const broadcastArg = mockWsHandler.broadcastStreamSettings.mock.calls.at(-1)?.[0];
      expect(broadcastArg?.fpsOptions).toEqual([24, 30]);

      // PR #94 レビュー (High): 明示指定が無いプロファイル切替でも、連動・スナップ済みの
      // 正規化値 (D1: 700kbps / D4: 30fps) が encoder 適用へ委譲されなければならない
      const delegated = (mockWsHandler.reapplyClientProfile as any).mock.calls[0]?.[0];
      expect(delegated?.fps).toBe(30);
      expect(delegated?.bitrate).toBe(700_000);

      await app.close();
    });

    it('プロファイル切替にビットレート・FPS 明示が含まれる場合、encoder 更新は reapplyClientProfile へ委譲し二重再起動を避ける (PR #94 レビュー Medium)', async () => {
      const { app, configStore, token, mockEncoder, mockWsHandler } = await makeApp();

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          stream: { clientProfile: { profile: 'lightweight' }, maxFps: 30, bitrate: 900_000 },
        },
      });
      expect(res.statusCode).toBe(200);

      // 設定ルートから encoder.updateConfig を直接呼ばず、寸法と同一の 1 回へ統合するため
      // streamUpdate を reapplyClientProfile へ委譲する
      expect(mockEncoder.updateConfig).not.toHaveBeenCalled();
      expect(mockWsHandler.reapplyClientProfile).toHaveBeenCalledTimes(1);
      const delegated = (mockWsHandler.reapplyClientProfile as any).mock.calls[0]?.[0];
      expect(delegated?.fps).toBe(30);
      expect(delegated?.bitrate).toBe(900_000);

      // プロファイル無変更のストリーム変更は従来どおり encoder.updateConfig を直接呼ぶ
      mockWsHandler.reapplyClientProfile.mockClear();
      const resPlain = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { authorization: `Bearer ${token}` },
        payload: { stream: { bitrate: 800_000 } },
      });
      expect(resPlain.statusCode).toBe(200);
      expect(mockEncoder.updateConfig).toHaveBeenCalledTimes(1);
      // PR #94 レビュー (High): 渡るのは常に正規化済み値 (レンジクランプ後) であること
      expect((mockEncoder.updateConfig as any).mock.calls[0]?.[0]?.bitrate).toBe(800_000);
      expect(mockWsHandler.reapplyClientProfile).not.toHaveBeenCalled();

      // PR #94 レビュー (High): FPS 選択肢外の明示値はスナップ済み値 (30) が encoder へ渡る
      mockEncoder.updateConfig.mockClear();
      const resSnap = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { authorization: `Bearer ${token}` },
        payload: { stream: { maxFps: 45 } },
      });
      expect(resSnap.statusCode).toBe(200);
      expect(mockEncoder.updateConfig).toHaveBeenCalledTimes(1);
      const applied = (mockEncoder.updateConfig as any).mock.calls[0]?.[0];
      expect(applied?.fps).toBe(30); // lightweight 選択肢 [24,30] の最も近い下位へスナップ
      expect(configStore.getConfig().stream.maxFps).toBe(30);
      await app.close();
    });

    it('custom の保存値は実効値へ正規化される', async () => {
      const { app, configStore, token } = await makeApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          stream: {
            clientProfile: { profile: 'custom', resolutionScale: 0.75, fpsOptions: [30, 24] },
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const saved = configStore.getConfig().stream.clientProfile;
      expect(saved?.profile).toBe('custom');
      expect(saved?.resolutionScale).toBe(0.75);
      expect(saved?.fpsOptions).toEqual([24, 30]);
      await app.close();
    });

    it('不正な profile 名は 400', async () => {
      const { app, token } = await makeApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { authorization: `Bearer ${token}` },
        payload: { stream: { clientProfile: { profile: 'turbo' } } },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('clientProfile に null / 非オブジェクトは 500 ではなく 400', async () => {
      const { app, token } = await makeApp();
      const resNull = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { authorization: `Bearer ${token}` },
        payload: { stream: { clientProfile: null } },
      });
      expect(resNull.statusCode).toBe(400);
      await app.close();
    });

    it('GET は clientProfileResolved 実効値を含む', async () => {
      const { app, token } = await makeApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.clientProfileResolved.resolutionScale).toBe(1.0);
      expect(body.clientProfileResolved.fpsOptions).toEqual([24, 30, 60]);
      await app.close();
    });
  });
});
