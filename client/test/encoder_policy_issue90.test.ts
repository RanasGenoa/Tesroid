import { describe, expect, it } from 'vitest';
import {
  CPU_PRESET_IDS,
  describeEncoderStatus,
  GPU_PRESET_IDS,
  resolveDisplayPreset,
  vaapiControlsEnabled,
  visiblePresetIds,
} from '../src/views/encoder-policy.js';

describe('Encoder backend-aware settings UI policy (Issue #90)', () => {
  const vaapiStatus = {
    running: true,
    backend: 'vaapi',
    encoderMode: 'auto',
    libvaDriverName: 'radeonsi',
    lastFallback: null,
  };
  const softwareStatus = {
    running: true,
    backend: 'software',
    encoderMode: 'auto',
    x264Preset: 'ultrafast',
    lastFallback: null,
  };

  describe('vaapiControlsEnabled', () => {
    it('VAAPIバックエンドではVAAPI依存コントロールを操作可能にする', () => {
      expect(vaapiControlsEnabled(vaapiStatus)).toBe(true);
    });

    it('softwareバックエンドではVAAPI依存コントロールを無効化する', () => {
      expect(vaapiControlsEnabled(softwareStatus)).toBe(false);
    });

    it('ステータス未取得・不明時は既存挙動を維持し操作可能とする', () => {
      expect(vaapiControlsEnabled(null)).toBe(true);
      expect(vaapiControlsEnabled({ backend: undefined })).toBe(true);
      expect(vaapiControlsEnabled({ backend: 'qsv' })).toBe(true);
    });

    it('nvencバックエンドではVAAPI依存コントロールを無効化する (Issue #36)', () => {
      expect(vaapiControlsEnabled({ backend: 'nvenc', encoderMode: 'auto' })).toBe(false);
    });
  });

  describe('visiblePresetIds', () => {
    it('vaapi時はGPUプリセットとcustomのみ表示する', () => {
      const visible = visiblePresetIds(vaapiStatus);
      expect(visible).toEqual([...GPU_PRESET_IDS, 'custom']);
      for (const id of CPU_PRESET_IDS) {
        expect(visible).not.toContain(id);
      }
    });

    it('software時はCPUプリセットとcustomのみ表示する', () => {
      const visible = visiblePresetIds(softwareStatus);
      expect(visible).toEqual([...CPU_PRESET_IDS, 'custom']);
      for (const id of GPU_PRESET_IDS) {
        expect(visible).not.toContain(id);
      }
    });

    it('ステータス不明時は従来どおりGPUプリセットを表示する', () => {
      expect(visiblePresetIds(null)).toEqual([...GPU_PRESET_IDS, 'custom']);
    });
  });

  describe('resolveDisplayPreset', () => {
    it('現在のバックエンドで有効な保存プリセットはそのまま表示する', () => {
      expect(resolveDisplayPreset('balanced', vaapiStatus)).toBe('balanced');
      expect(resolveDisplayPreset('cpu_balanced', softwareStatus)).toBe('cpu_balanced');
      expect(resolveDisplayPreset('custom', softwareStatus)).toBe('custom');
    });

    it('バックエンド非対応の保存プリセットは表示上customとして開く（保存値は変更しない）', () => {
      // GPU前提プリセットが保存された環境でsoftwareへフォールバックした場合
      expect(resolveDisplayPreset('balanced', softwareStatus)).toBe('custom');
      // CPUプリセットが保存された環境でVAAPIが有効な場合
      expect(resolveDisplayPreset('cpu_low_power', vaapiStatus)).toBe('custom');
    });

    it('保存値が無い場合はcustomを返す', () => {
      expect(resolveDisplayPreset(undefined, vaapiStatus)).toBe('custom');
    });
  });

  describe('describeEncoderStatus', () => {
    it('VAAPI稼働中はドライバ名付きのハードウェア表示とする', () => {
      const text = describeEncoderStatus(vaapiStatus);
      expect(text).toContain('VAAPI ハードウェア');
      expect(text).toContain('radeonsi');
      expect(text).not.toContain('libx264');
    });

    it('software稼働中はlibx264とx264 presetを表示する', () => {
      const text = describeEncoderStatus(softwareStatus);
      expect(text).toContain('CPU ソフトウェア (libx264');
      expect(text).toContain('ultrafast');
    });

    it('段階降格が発生している場合は理由を明示する', () => {
      const text = describeEncoderStatus({
        backend: 'software',
        lastFallback: { option: 'softwareEncoder', timestamp: 1 },
      });
      expect(text).toContain('CPU (libx264) エンコードへ降格');
    });

    it('プライベートIPやホスト固有パス等の機密を含まない', () => {
      const text = describeEncoderStatus(vaapiStatus);
      expect(text).not.toMatch(/192\.168\.|\/home\/|\/Users\//);
    });
  });
});
