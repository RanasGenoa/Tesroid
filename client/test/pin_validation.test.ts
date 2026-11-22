import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validatePinCharacters, validatePinInput } from '../src/views/pin-validation.js';
import { openSettingsWithAuth } from '../src/views/settings-modal.js';

describe('PIN Validation Helper & Settings Modal PIN Validation (Issue #80)', () => {
  type MockListener = (event?: unknown) => void;
  type MockElement = {
    id: string;
    tagName: string;
    className: string;
    classList: {
      toggle: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
      add: ReturnType<typeof vi.fn>;
    };
    style: Record<string, string>;
    children: MockElement[];
    listeners: Record<string, MockListener[]>;
    title: string;
    textContent: string;
    value: string;
    innerHTML: string;
    focus: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    dispatchEvent: ReturnType<typeof vi.fn>;
    click: () => void;
    appendChild: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    querySelector: ReturnType<typeof vi.fn>;
    querySelectorAll: ReturnType<typeof vi.fn>;
  };

  let elementRegistry: Map<string, MockElement>;
  let mockContainer: MockElement;
  const testToken = 'tesroid-test-token-pin';

  const origDocument = globalThis.document;
  const origWindow = globalThis.window;
  const origLocalStorage = globalThis.localStorage;
  const origFetch = globalThis.fetch;
  const origRaf = globalThis.requestAnimationFrame;

  function createMockElement(id?: string, tagName = 'div'): MockElement {
    const listeners: Record<string, MockListener[]> = {};
    const el: MockElement = {
      id: id || '',
      tagName,
      className: '',
      classList: {
        toggle: vi.fn(),
        remove: vi.fn(),
        add: vi.fn(),
      },
      style: {},
      children: [],
      listeners,
      title: '',
      textContent: '',
      value: '',
      innerHTML: '',
      focus: vi.fn(),
      addEventListener: vi.fn((event: string, fn: MockListener) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
      }),
      removeEventListener: vi.fn((event: string, fn: MockListener) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter((l) => l !== fn);
        }
      }),
      dispatchEvent: vi.fn((event: { type: string }) => {
        const fns = listeners[event.type] || [];
        for (const f of fns) {
          f(event);
        }
      }),
      click: () => {
        el.dispatchEvent({
          type: 'click',
          target: el,
          stopPropagation: vi.fn(),
          preventDefault: vi.fn(),
        });
      },
      appendChild: vi.fn((child: MockElement) => {
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
    elementRegistry = new Map<string, MockElement>();

    const mockDocument = {
      getElementById: vi.fn((id: string) => elementRegistry.get(id) || null),
      createElement: vi.fn((tag: string) => createMockElement(undefined, tag)),
      body: createMockElement('body', 'body'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const mockLocalStorage: Record<string, string> = {};
    const mockWindow = {
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

    Object.assign(globalThis, {
      document: mockDocument,
      window: mockWindow,
      localStorage: mockWindow.localStorage,
      requestAnimationFrame: vi.fn((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      }),
      CustomEvent: class {
        type: string;
        detail: unknown;
        constructor(type: string, opts?: { detail?: unknown }) {
          this.type = type;
          this.detail = opts?.detail;
        }
      },
    });

    mockContainer = createMockElement('app');
  });

  afterEach(() => {
    Object.assign(globalThis, {
      document: origDocument,
      window: origWindow,
      localStorage: origLocalStorage,
      fetch: origFetch,
      requestAnimationFrame: origRaf,
    });
    vi.restoreAllMocks();
  });

  it('validatePinInput and validatePinCharacters strictly enforce ASCII 0-9 digits and 4-8 length', () => {
    expect(validatePinInput('0000')).toBeNull();
    expect(validatePinInput('1234')).toBeNull();
    expect(validatePinInput('12345678')).toBeNull();

    expect(validatePinInput('')).toContain('半角数字4〜8桁');
    expect(validatePinInput('', { allowEmpty: true })).toBeNull();

    expect(validatePinInput('123')).toContain('4〜8桁');
    expect(validatePinInput('123456789')).toContain('4〜8桁');
    expect(validatePinInput('abcd')).toContain('半角数字（0〜9）のみ');
    expect(validatePinInput('12a4')).toContain('半角数字（0〜9）のみ');
    expect(validatePinInput('１２３４')).toContain('半角数字（0〜9）のみ');
    expect(validatePinInput('12 34')).toContain('半角数字（0〜9）のみ');
    expect(validatePinInput('    ', { allowEmpty: true })).toContain('半角数字（0〜9）のみ');

    expect(validatePinCharacters('')).toBeNull();
    expect(validatePinCharacters('12')).toBeNull();
    expect(validatePinCharacters('12a')).toContain('半角数字（0〜9）のみ');
    expect(validatePinCharacters('１')).toContain('半角数字（0〜9）のみ');
  });

  it('settings modal renders numeric inputmode hints and rejects invalid PINs before calling PUT /api/settings', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    Object.assign(globalThis, { fetch: fetchMock });

    openSettingsWithAuth(mockContainer as unknown as HTMLElement, testToken, vi.fn(), vi.fn());
    await new Promise((r) => setTimeout(r, 0));

    const overlay = mockContainer.children[0];
    expect(overlay.innerHTML).toContain('新しいPINコード (半角数字 4〜8桁 / 空欄で維持)');
    expect(overlay.innerHTML).toContain('inputmode="numeric"');
    expect(overlay.innerHTML).toContain('pattern="[0-9]*"');

    const cfgPin = elementRegistry.get('cfg-pin');
    const cfgPinError = elementRegistry.get('cfg-pin-error');
    const saveBtn = elementRegistry.get('cfg-save-btn');
    expect(cfgPin).toBeDefined();
    expect(cfgPinError).toBeDefined();
    expect(saveBtn).toBeDefined();
    if (!cfgPin || !cfgPinError || !saveBtn) return;

    // Typing a non-digit character highlights the inline error immediately
    cfgPin.value = '12a';
    cfgPin.dispatchEvent({ type: 'input', target: cfgPin });
    expect(cfgPinError.style.display).toBe('block');
    expect(cfgPinError.textContent).toContain('半角数字');
    expect(cfgPin.style.borderColor).toBe('var(--danger-color)');

    // Clearing restores normal styling
    cfgPin.value = '';
    cfgPin.dispatchEvent({ type: 'input', target: cfgPin });
    expect(cfgPinError.style.display).toBe('none');
    expect(cfgPin.style.borderColor).toBe('');

    fetchMock.mockClear();

    // Invalid PINs must block PUT /api/settings
    for (const invalidPin of ['123', '123456789', 'abcd', '12a4', '１２３４', '12 34']) {
      cfgPin.value = invalidPin;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(cfgPinError.style.display).toBe('block');
      expect(cfgPin.focus).toHaveBeenCalled();
    }

    // Empty PIN keeps existing PIN and submits PUT /api/settings without pin field
    cfgPin.value = '';
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const emptyBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(emptyBody.pin).toBeUndefined();

    // Valid numeric PIN submits PUT /api/settings with pin and clears the field on success
    fetchMock.mockClear();
    cfgPin.value = '0528';
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const validBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(validBody.pin).toBe('0528');
    expect(cfgPin.value).toBe('');
  });
});
