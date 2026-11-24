import { describe, expect, it } from 'vitest';
import {
  CPU_PRESET_IDS,
  describeEncoderStatus,
  GPU_PRESET_IDS,
  resolveDisplayPreset,
  vaapiControlsEnabled,
  visiblePresetIds,
} from '../src/views/encoder-policy.js';

describe('NVENC backend settings UI policy (Issue #36 Phase 3)', () => {
  const nvencStatus = {
    running: true,
    backend: 'nvenc',
    encoderMode: 'auto',
    libvaDriverName: null,
    lastFallback: null,
  };

  it('VAAPI依存コントロール (-low_power / scale_vaapi / 負荷優先度) は無効化する', () => {
    expect(vaapiControlsEnabled(nvencStatus)).toBe(false);
  });

  it('サイズプリセットは GPU 前提一覧を維持し、CPU (libx264) プリセットは非表示とする', () => {
    const visible = visiblePresetIds(nvencStatus);
    expect(visible).toEqual([...GPU_PRESET_IDS, 'custom']);
    for (const id of CPU_PRESET_IDS) {
      expect(visible).not.toContain(id);
    }
  });

  it('NVENC稼働中は h264_nvenc のハードウェア表示とし、VAAPI/libx264 表記を含まない', () => {
    const text = describeEncoderStatus(nvencStatus);
    expect(text).toContain('NVENC ハードウェア (h264_nvenc)');
    expect(text).not.toContain('libx264');
    expect(text).not.toContain('h264_vaapi');
  });

  it('ENCODER_MODE=nvenc 固定は NVENC固定 と表示する', () => {
    const text = describeEncoderStatus({ backend: 'nvenc', encoderMode: 'nvenc' });
    expect(text).toContain('モード: NVENC固定');
  });

  it('GPUプリセット保存値は NVENC でもそのまま表示される (maxSize はバックエンド非依存)', () => {
    expect(resolveDisplayPreset('balanced', nvencStatus)).toBe('balanced');
    // CPUプリセット保存値は NVENC では表示上 custom として扱う
    expect(resolveDisplayPreset('cpu_balanced', nvencStatus)).toBe('custom');
  });

  it('プライベートIPやホスト固有パス等の機密を含まない', () => {
    const text = describeEncoderStatus(nvencStatus);
    expect(text).not.toMatch(/192\.168\.|\/home\/|\/Users\//);
  });
});
