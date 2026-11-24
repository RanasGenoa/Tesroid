import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSettingsWithAuth } from '../src/views/settings-modal.js';

// Issue #101: ブラウザ表示拡大率の選択肢を 60%〜130% の 8 段階へ刷新し、
// 旧保存値 (140 / 150 等) は「現在の保存値」動的オプションで非破壊保持する。
describe('Display scale options 60-130 & legacy preservation (Issue #101) - Frontend Tests', () => {
  let elementRegistry: Map<string, any>;
  let mockContainer: any;
  const testToken = 'tesroid-test-token-display-scale';

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

  // 実 DOM の <select> には option 一覧がある。テストハーネスの手書きモックには
  // .options が無いため、モーダル open 直後（同期）に手で用意して本番経路を発火させる。
  const DISPLAY_SCALE_GRID = ['60', '70', '80', '90', '100', '110', '120', '130'];

  function mockFetchWithSettings(displayScale: number) {
    let putPayload: any = null;
    (globalThis as any).fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (url === '/api/settings' && (!opts || opts.method !== 'PUT')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ locale: 'ja-JP', displayScale, stream: { ...savedStream } }),
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

  it('#cfg-display-scale offers the refreshed 60-130% grid without 140/150 (source guard)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/views/settings-modal.ts'), 'utf-8');
    const block = src.slice(
      src.indexOf('<select id="cfg-display-scale">'),
      src.indexOf('</select>', src.indexOf('<select id="cfg-display-scale">')),
    );
    expect(block).not.toBe('');
    for (const value of DISPLAY_SCALE_GRID) {
      // selected 属性の有無に依らず option の存在を検証する
      expect(block).toContain(`<option value="${value}"`);
    }
    // 140% / 150% は廃止、既定 120% は維持
    expect(block).not.toContain('<option value="140">');
    expect(block).not.toContain('<option value="150">');
    expect(block).toContain('<option value="120" selected>');
  });

  it('saved out-of-grid value 150 is kept as "(現在の保存値)" option instead of resetting to 120', async () => {
    mockFetchWithSettings(150);
    openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());

    const scaleEl = elementRegistry.get('cfg-display-scale');
    expect(scaleEl).toBeDefined();
    // open 直後の同期代入で option グリッドを用意し、選択肢外値の動的追加経路を発火させる
    scaleEl.options = DISPLAY_SCALE_GRID.map((value) => ({ value }));
    await new Promise((r) => setTimeout(r, 10));

    expect(scaleEl.value).toBe('150');
    const legacyOption = (scaleEl.children as any[]).find((c) => c.value === '150');
    expect(legacyOption).toBeDefined();
    expect(String(legacyOption.textContent)).toContain('(現在の保存値)');

    elementRegistry.get('modal-close-btn').click();
  });

  it('saved in-grid value 70 selects directly with no legacy option', async () => {
    mockFetchWithSettings(70);
    openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());

    const scaleEl = elementRegistry.get('cfg-display-scale');
    expect(scaleEl).toBeDefined();
    scaleEl.options = DISPLAY_SCALE_GRID.map((value) => ({ value }));
    await new Promise((r) => setTimeout(r, 10));

    expect(scaleEl.value).toBe('70');
    const legacyOptions = (scaleEl.children as any[]).filter((c) =>
      String(c.textContent || '').includes('(現在の保存値)'),
    );
    expect(legacyOptions).toHaveLength(0);

    elementRegistry.get('modal-close-btn').click();
  });

  // PR #102 レビュー 6th L: 空白のみの localStorage 値で不正な option を作らない。
  it('blank localStorage values never create a malformed "(現在の保存値)" option', async () => {
    (globalThis as any).localStorage.setItem('tesroid_display_scale', '   ');
    mockFetchWithSettings(120);
    openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());

    const scaleEl = elementRegistry.get('cfg-display-scale');
    expect(scaleEl).toBeDefined();
    await new Promise((r) => setTimeout(r, 10));

    const malformed = (scaleEl.children as any[]).filter((c) =>
      String(c.textContent || '').includes('(現在の保存値)'),
    );
    expect(malformed).toHaveLength(0);

    elementRegistry.get('modal-close-btn').click();
  });

  // PR #102 レビュー L2: localStorage 先行表示で挿入された旧値の動的 option が、
  // サーバー反映値が別値になった後もプルダウンに残らないことを検証する。
  it('stale "(現在の保存値)" option is cleared when the server value differs', async () => {
    (globalThis as any).localStorage.setItem('tesroid_display_scale', '150');
    mockFetchWithSettings(120);
    openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());

    const scaleEl = elementRegistry.get('cfg-display-scale');
    expect(scaleEl).toBeDefined();
    // 実 DOM の localStorage 先行表示で挿入された旧値 option を再現する
    const stale: any = {
      value: '150',
      textContent: '150% (現在の保存値)',
      __tesroidLegacySaved: true,
      remove: vi.fn(() => {
        scaleEl.children = (scaleEl.children as any[]).filter((c) => c !== stale);
      }),
    };
    scaleEl.children.push(stale);
    scaleEl.options = DISPLAY_SCALE_GRID.map((value) => ({ value }));
    await new Promise((r) => setTimeout(r, 10));

    // サーバー保存値 120 が選択され、旧 150% の動的 option は残留しない
    expect(scaleEl.value).toBe('120');
    expect(
      (scaleEl.children as any[]).find((c) => c.__tesroidLegacySaved === true),
    ).toBeUndefined();

    elementRegistry.get('modal-close-btn').click();
  });

  it('selecting the new 60% step saves displayScale=60 via PUT /api/settings', async () => {
    const getPut = mockFetchWithSettings(120);
    openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());
    await new Promise((r) => setTimeout(r, 10));

    const scaleEl = elementRegistry.get('cfg-display-scale');
    expect(scaleEl.value).toBe('120'); // サーバー保存値 120 が反映されている
    scaleEl.value = '60';

    elementRegistry.get('cfg-save-btn').click();
    await new Promise((r) => setTimeout(r, 10));

    const put = getPut();
    expect(put).toBeDefined();
    expect(put.displayScale).toBe(60);

    elementRegistry.get('modal-close-btn').click();
  });
});
