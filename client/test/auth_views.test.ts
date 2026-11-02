import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderPinEntry } from '../src/views/pin-entry.js';
import { renderLockoutView } from '../src/views/lockout.js';

describe('Client Auth & Security Views (PIN Numpad & Lockout Screen)', () => {
  const originalDocument = (globalThis as any).document;

  afterEach(() => {
    (globalThis as any).document = originalDocument;
    vi.restoreAllMocks();
  });

  it('renderPinEntry enforces 4-to-8 digit bounds, clear/backspace, warning colors, and submit callback', () => {
    const keyButtons: any[] = [];
    const elementsById = new Map<string, any>();

    const makeButton = (idOrKey: string, isKey: boolean) => {
      const listeners = new Map<string, Function>();
      const btn: any = {
        disabled: true,
        style: {},
        innerHTML: '',
        getAttribute: (attr: string) => (attr === 'data-key' && isKey ? idOrKey : null),
        addEventListener: (ev: string, fn: Function) => listeners.set(ev, fn),
        click: () => listeners.get('click')?.(),
      };
      return btn;
    };

    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back']) {
      keyButtons.push(makeButton(k, true));
    }

    const dotsEl: any = { innerHTML: '', style: {} };
    const submitBtn = makeButton('pin-submit-btn', false);
    const settingsBtn = makeButton('pin-settings-btn', false);
    elementsById.set('pin-dots', dotsEl);
    elementsById.set('pin-submit-btn', submitBtn);
    elementsById.set('pin-settings-btn', settingsBtn);

    (globalThis as any).document = {
      getElementById: (id: string) => elementsById.get(id) || null,
    };

    const container: any = {
      innerHTML: '',
      querySelectorAll: (sel: string) => (sel === '.fullscreen-numpad-key' ? keyButtons : []),
    };

    const submittedPins: string[] = [];
    let settingsOpened = 0;

    // Render with 3 remaining attempts (< 5 triggers red alert styling)
    renderPinEntry(
      container,
      3,
      (pin) => submittedPins.push(pin),
      () => settingsOpened++
    );

    expect(container.innerHTML).toContain('#ff3b30'); // Red low-attempts warning

    const pressKey = (k: string) => keyButtons.find((b) => b.getAttribute('data-key') === k)!.click();

    // 3 digits -> submit remains disabled
    pressKey('2');
    pressKey('5');
    pressKey('8');
    expect(submitBtn.disabled).toBe(true);
    submitBtn.click();
    expect(submittedPins).toEqual([]);

    // 4th digit -> submit enabled!
    pressKey('0');
    expect(submitBtn.disabled).toBe(false);
    expect(dotsEl.innerHTML).toBe('● ● ● ●');

    // Backspace -> back to 3 digits (disabled)
    pressKey('back');
    expect(submitBtn.disabled).toBe(true);

    // Cap at 8 digits even if 10 keys are pressed
    pressKey('0');
    pressKey('1');
    pressKey('2');
    pressKey('3');
    pressKey('4');
    pressKey('9'); // 9th ignored
    pressKey('9'); // 10th ignored
    submitBtn.click();
    expect(submittedPins).toEqual(['25801234']);

    // Clear resets PIN
    pressKey('clear');
    expect(submitBtn.disabled).toBe(true);
    expect(dotsEl.innerHTML).toContain('PINを入力');

    // Settings button triggers callback
    settingsBtn.click();
    expect(settingsOpened).toBe(1);
  });

  it('renderLockoutView displays brute-force lockout notice and lockout.json recovery instructions', () => {
    const container: any = { innerHTML: '' };
    renderLockoutView(container);

    expect(container.innerHTML).toContain('セキュリティロックアウト');
    expect(container.innerHTML).toContain('10回連続');
    expect(container.innerHTML).toContain('lockout.json');
  });
});
