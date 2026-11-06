import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSettingsWithAuth } from '../src/views/settings-modal.js';

describe('Settings Modal Audio Bitrate (Issue 10) - Frontend Tests', () => {
  let elementRegistry: Map<string, any>;
  let mockContainer: any;
  const testToken = 'tesroid-test-token-audio';

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
      classList: {
        toggle: vi.fn(),
        remove: vi.fn(),
        add: vi.fn(),
      },
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
      removeEventListener: vi.fn((event: string, fn: Function) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter((l) => l !== fn);
        }
      }),
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

  it('renders #cfg-audio-bitrate selector with 128k, 192k, 256k, 320k options in settings modal', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        stream: { audioBitrate: 128000 },
      }),
    });

    openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());

    const audioSelect = elementRegistry.get('cfg-audio-bitrate');
    expect(audioSelect).toBeDefined();

    // Verify option HTML includes 128000, 192000, 256000, 320000
    const cardEl = mockContainer.children[0];
    expect(cardEl.innerHTML).toContain('cfg-audio-bitrate');
    expect(cardEl.innerHTML).toContain('value="128000"');
    expect(cardEl.innerHTML).toContain('value="192000"');
    expect(cardEl.innerHTML).toContain('value="256000"');
    expect(cardEl.innerHTML).toContain('value="320000"');
  });

  it('populates audio bitrate from GET /api/settings response', async () => {
    (globalThis as any).fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/settings') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            locale: 'ja-JP',
            stream: { audioBitrate: 256000 },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());

    // Allow promise microtasks to run for fetch('/api/settings')
    await new Promise((r) => setTimeout(r, 10));

    const audioSelect = elementRegistry.get('cfg-audio-bitrate');
    expect(audioSelect.value).toBe('256000');
    expect((globalThis as any).window.localStorage.setItem).toHaveBeenCalledWith(
      'tesroid_audio_bitrate',
      '256000',
    );
  });

  it('submits selected audioBitrate in PUT /api/settings and dispatches update event', async () => {
    let putPayload: any = null;
    (globalThis as any).fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (url === '/api/settings' && (!opts || opts.method === 'GET' || !opts.method)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            locale: 'ja-JP',
            stream: { audioBitrate: 128000 },
          }),
        });
      }
      if (url === '/api/settings' && opts?.method === 'PUT') {
        putPayload = JSON.parse(opts.body);
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    openSettingsWithAuth(mockContainer, testToken, vi.fn(), vi.fn());
    await new Promise((r) => setTimeout(r, 10));

    const audioSelect = elementRegistry.get('cfg-audio-bitrate');
    audioSelect.value = '320000';

    const saveBtn = elementRegistry.get('cfg-save-btn');
    expect(saveBtn).toBeDefined();

    saveBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(putPayload).toBeDefined();
    expect(putPayload.stream).toBeDefined();
    expect(putPayload.stream.audioBitrate).toBe(320000);

    expect((globalThis as any).window.localStorage.setItem).toHaveBeenCalledWith(
      'tesroid_audio_bitrate',
      '320000',
    );
    expect((globalThis as any).window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tesroid:settings-updated',
        detail: expect.objectContaining({ audioBitrate: 320000 }),
      }),
    );
  });
});
