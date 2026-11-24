import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSettingsWithAuth } from '../src/views/settings-modal.js';

// Issue #90 review: 詳細値を編集したらプリセット選択も即座に custom へ切り替わり、
// 保存時も 'custom' が送信されること。逆に display 上の custom 展開を触っただけの
// 未編集状態では、保存済みプリセット名がそのまま送信され誤った custom 永続化が起きないこと。
describe('Settings Modal Custom-Preset Touching (Issue #90 review) - Frontend Tests', () => {
  let elementRegistry: Map<string, any>;
  let mockContainer: any;
  const testToken = 'tesroid-test-token-custom-preset';

  const origDocument = (globalThis as any).document;
  const origWindow = (globalThis as any).window;
  const origLocalStorage = (globalThis as any).localStorage;
  const origFetch = (globalThis as any).fetch;
  const origRaf = (globalThis as any).requestAnimationFrame;

  function createMockElement(id?: string, tagName = 'div'): any {
    const listeners: Record<string, Function[]> = {};
    const el: any = {
      id: id || '',
      tagName,
      className: '',
      classList: { toggle: vi.fn(), remove: vi.fn(), add: vi.fn() },
      style: {},
      children: [] as any[],
      listeners,
      title: '',
      textContent: '',
      value: '',
      addEventListener: vi.fn((event: string, fn: Function) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn((event: any) => {
        const fns = listeners[event.type] || [];
        fns.forEach((f) => f(event));
      }),
      click: () => {
        el.dispatchEvent({
          type: 'click',
          target: el,
          stopPropagation: vi.fn(),
          preventDefault: vi.fn(),
        });
      },
      appendChild: vi.fn((child: any) => {
        el.children.push(child);
        if (child.id) elementRegistry.set(child.id, child);
        return child;
      }),
      remove: vi.fn(() => {
        if (el.id) elementRegistry.delete(el.id);
      }),
      querySelector: vi.fn((sel: string) => {
        if (sel.startsWith('#')) {
          return elementRegistry.get(sel.slice(1)) || null;
        }
        return null;
      }),
      querySelectorAll: vi.fn(() => []),
    };

    let innerHtmlVal = '';
    Object.defineProperty(el, 'innerHTML', {
      get: () => innerHtmlVal,
      set: (html: string) => {
        innerHtmlVal = html;
        const idMatches = html.matchAll(/id=["']([^"']+)["']/g);
        for (const m of idMatches) {
          const childId = m[1];
          if (!elementRegistry.has(childId)) {
            const child = createMockElement(childId);
            elementRegistry.set(childId, child);
            el.children.push(child);
          }
        }
      },
    });

    if (id) {
      elementRegistry.set(id, el);
    }
    return el;
  }

  const savedStream = {
    audioBitrate: 128000,
    performancePreset: 'balanced',
    maxSize: 1280,
    vaapiCompressionLevel: 7,
    vaapiLowPower: false,
    vaapiGpuColorConversion: true,
  };

  function mockFetchCapturingPut() {
    let putPayload: any = null;
    (globalThis as any).fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (url === '/api/settings' && (!opts || opts.method !== 'PUT')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ locale: 'ja-JP', stream: { ...savedStream } }),
        });
      }
      if (url === '/api/settings' && opts?.method === 'PUT') {
        putPayload = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    return () => putPayload;
  }

  beforeEach(() => {
    elementRegistry = new Map<string, any>();

    const mockDocument: any = {
      getElementById: vi.fn((id: string) => elementRegistry.get(id) || null),
      createElement: vi.fn((tag: string) => createMockElement(undefined, tag)),
      body: createMockElement('body', 'body'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const mockLocalStorage: Record<string, string> = {};
    const mockWindow: any = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      location: { reload: vi.fn() },
      localStorage: {
        getItem: vi.fn((key: string) => mockLocalStorage[key] || null),
        setItem: vi.fn((key: string, val: string) => {
          mockLocalStorage[key] = String(val);
        }),
        removeItem: vi.fn((key: string) => {
          delete mockLocalStorage[key];
        }),
      },
    };

    (globalThis as any).document = mockDocument;
    (globalThis as any).window = mockWindow;
    (globalThis as any).localStorage = mockWindow.localStorage;
    (globalThis as any).requestAnimationFrame = (cb: Function) => setTimeout(cb, 0);

    mockContainer = createMockElement('app');
  });

  afterEach(() => {
    (globalThis as any).document = origDocument;
    (globalThis as any).window = origWindow;
    (globalThis as any).localStorage = origLocalStorage;
    (globalThis as any).fetch = origFetch;
    (globalThis as any).requestAnimationFrame = origRaf;
  });

  it('editing a detail control switches the preset select to custom and persists custom on save', async () => {
    const getPut = mockFetchCapturingPut();
    openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());
    await new Promise((r) => setTimeout(r, 10));

    const maxSizeEl = elementRegistry.get('cfg-max-size');
    expect(maxSizeEl).toBeDefined();
    maxSizeEl.value = '960';
    maxSizeEl.dispatchEvent({ type: 'change', target: maxSizeEl });

    // 編集直後にセレクト表示自体が custom へ切り替わる（ラベルと実値の一致）
    const presetSelect = elementRegistry.get('cfg-perf-preset');
    expect(presetSelect.value).toBe('custom');

    elementRegistry.get('cfg-save-btn').click();
    await new Promise((r) => setTimeout(r, 10));

    const put = getPut();
    expect(put).toBeDefined();
    expect(put.stream.performancePreset).toBe('custom');
    expect(put.stream.maxSize).toBe(960);

    // テスト終了前に必ず閉じて encoderStatusTimer / metricsTimer を解放する (Issue #90 review)
    elementRegistry.get('modal-close-btn').click();
  });

  it('display-only custom expansion without any edit keeps the saved preset name on save', async () => {
    const getPut = mockFetchCapturingPut();
    openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());
    await new Promise((r) => setTimeout(r, 10));

    // バックエンド非対応で表示上 custom 相当に開いた状態を再現（ユーザーは一切編集しない）
    const presetSelect = elementRegistry.get('cfg-perf-preset');
    presetSelect.value = 'custom';

    elementRegistry.get('cfg-save-btn').click();
    await new Promise((r) => setTimeout(r, 10));

    const put = getPut();
    expect(put).toBeDefined();
    // 未編集では保存済みプリセット名をそのまま送信し、誤った custom 永続化が起きない
    expect(put.stream.performancePreset).toBe('balanced');

    elementRegistry.get('modal-close-btn').click();
  });

  it('restores the saved CPU preset display when /api/settings completes before /api/health (race, Issue #90 review)', async () => {
    // /api/settings は即時、/api/health はテスト側で解決するまで未達（software を返す）で
    // 先着順を決定化する (CI のタイマー遅延では flaky になるため手動解決)。
    let resolveHealth: (value: unknown) => void = () => {};
    (globalThis as any).fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/settings') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            locale: 'ja-JP',
            stream: { ...savedStream, performancePreset: 'cpu_balanced' },
          }),
        });
      }
      if (url === '/api/health') {
        return new Promise((resolve) => {
          resolveHealth = resolve;
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());
    const presetSelect = elementRegistry.get('cfg-perf-preset');
    expect(presetSelect).toBeDefined();
    // 実 <select> の option 一覧（6プリセット）をモックに用意し、可視性切替コードを発火させる
    presetSelect.options = [
      'high',
      'balanced',
      'low_power',
      'cpu_balanced',
      'cpu_low_power',
      'custom',
    ].map((value) => ({ value }));

    // settings 充填後、health 未達（=GPU前提一覧）の適用で 'custom' へ書き換わる時点まで待つ。
    // スケジュールによっては充填適用が option 設定前に走るため、その場合は固着状態を手動で再現する。
    let observedCustom = false;
    for (let i = 0; i < 50; i++) {
      if (presetSelect.value === 'custom') {
        observedCustom = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    if (!observedCustom) {
      presetSelect.value = 'custom';
    }

    // health (software) 到達後、未操作なら保存値 cpu_balanced へ復元され固着しない
    resolveHealth({
      ok: true,
      json: async () => ({ encoder: { backend: 'software', x264Preset: 'veryfast' } }),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(presetSelect.value).toBe('cpu_balanced');
    const panel = elementRegistry.get('cfg-perf-custom-panel');
    expect(panel.style.display).toBe('none');

    elementRegistry.get('modal-close-btn').click();
  });

  it('custom プロファイルのグリッド外 resolutionScale は「現在の保存値」option として追加し選択する (PR #94 レビュー M1)', async () => {
    (globalThis as any).fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (url === '/api/settings' && (!opts || opts.method !== 'PUT')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            locale: 'ja-JP',
            stream: { ...savedStream, clientProfile: { profile: 'custom' } },
            clientProfileResolved: {
              resolutionScale: 0.6,
              fpsOptions: [24, 30],
              bitrateDefault: 500000,
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
    });

    openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());
    const scaleEl = elementRegistry.get('cfg-client-scale');
    expect(scaleEl).toBeDefined();
    // 実 <select> の option 一覧 (5段階グリッド) を用意し、選択肢外 0.6 の動的追加経路を発火させる
    scaleEl.options = ['1', '0.85', '0.75', '0.65', '0.5'].map((value) => ({ value }));
    await new Promise((r) => setTimeout(r, 10));

    // 既定選択 (0.65) に潰えず、保存値 0.6 が選択されたまま維持される
    expect(scaleEl.value).toBe('0.6');
    const legacyOption = (scaleEl.children as any[]).find((c) => c.value === '0.6');
    expect(legacyOption).toBeDefined();
    expect(String(legacyOption.textContent)).toContain('(現在の保存値)');

    // FPS チェックボックスは実効 fpsOptions [24,30] を反映
    expect(elementRegistry.get('cfg-client-fps-24').checked).toBe(true);
    expect(elementRegistry.get('cfg-client-fps-60').checked).toBe(false);

    elementRegistry.get('modal-close-btn').click();
  });
});
