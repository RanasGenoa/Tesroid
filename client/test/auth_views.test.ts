import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderLockoutView } from '../src/views/lockout.js';
import { renderPinEntry } from '../src/views/pin-entry.js';

function setupPinEntryDom() {
  const keyButtons: any[] = [];
  const elementsById = new Map<string, any>();

  const makeButton = (idOrKey: string, isKey: boolean) => {
    const listeners = new Map<string, () => void>();
    return {
      disabled: true,
      style: {},
      innerHTML: '',
      getAttribute: (attr: string) => (attr === 'data-key' && isKey ? idOrKey : null),
      addEventListener: (ev: string, fn: () => void) => listeners.set(ev, fn),
      click: () => listeners.get('click')?.(),
    };
  };

  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back']) {
    keyButtons.push(makeButton(k, true));
  }

  const dotsEl: any = { innerHTML: '', style: {} };
  const submitBtn = makeButton('pin-submit-btn', false);
  const secondaryBtn = makeButton('pin-secondary-btn', false);
  const settingsBtn = makeButton('pin-settings-btn', false);
  const settingsMenu: any = { style: { display: 'none' } };
  const settingsMenuBackdrop = makeButton('pin-settings-menu-backdrop', false);
  const rearStandbyBtn = makeButton('pin-menu-rear-standby-btn', false);
  const rearStandbySub: any = { textContent: '' };
  const openSettingsMenuBtn = makeButton('pin-menu-open-settings-btn', false);
  const openGuideMenuBtn = makeButton('pin-menu-open-guide-btn', false);
  const standbyHintEl: any = { textContent: '', style: { display: 'none' } };

  elementsById.set('pin-dots', dotsEl);
  elementsById.set('pin-submit-btn', submitBtn);
  elementsById.set('pin-settings-btn', settingsBtn);
  elementsById.set('pin-settings-menu', settingsMenu);
  elementsById.set('pin-settings-menu-backdrop', settingsMenuBackdrop);
  elementsById.set('pin-menu-rear-standby-btn', rearStandbyBtn);
  elementsById.set('pin-menu-rear-standby-sub', rearStandbySub);
  elementsById.set('pin-menu-open-settings-btn', openSettingsMenuBtn);
  elementsById.set('pin-menu-open-guide-btn', openGuideMenuBtn);
  elementsById.set('pin-standby-hint', standbyHintEl);

  (globalThis as any).document = {
    getElementById: (id: string) => elementsById.get(id) || null,
  };

  let htmlValue = '';
  const container: any = {
    querySelectorAll: (sel: string) => (sel === '.fullscreen-numpad-key' ? keyButtons : []),
  };
  Object.defineProperty(container, 'innerHTML', {
    get: () => htmlValue,
    set: (html: string) => {
      htmlValue = html;
      if (html.includes('id="pin-secondary-btn"')) {
        elementsById.set('pin-secondary-btn', secondaryBtn);
      } else {
        elementsById.delete('pin-secondary-btn');
      }
    },
  });

  const pressKey = (k: string) => {
    const btn = keyButtons.find((b) => b.getAttribute('data-key') === k);
    if (!btn) throw new Error(`Button not found for key: ${k}`);
    btn.click();
  };

  return {
    container,
    dotsEl,
    submitBtn,
    secondaryBtn,
    settingsBtn,
    settingsMenu,
    settingsMenuBackdrop,
    rearStandbyBtn,
    rearStandbySub,
    openSettingsMenuBtn,
    openGuideMenuBtn,
    standbyHintEl,
    pressKey,
  };
}

describe('Client Auth & Security Views (PIN Numpad & Lockout Screen)', () => {
  const originalDocument = (globalThis as any).document;

  afterEach(() => {
    (globalThis as any).document = originalDocument;
    vi.restoreAllMocks();
  });

  it('renderPinEntry enforces 4-to-8 digit bounds, clear/backspace, warning colors, and submit callback', () => {
    const {
      container,
      dotsEl,
      submitBtn,
      settingsBtn,
      settingsMenu,
      openSettingsMenuBtn,
      pressKey,
    } = setupPinEntryDom();

    const submittedPins: string[] = [];
    const openedSettingsPins: Array<string | undefined> = [];

    // Render with 3 remaining attempts (< 5 triggers red alert styling)
    renderPinEntry(
      container,
      3,
      (pin) => submittedPins.push(pin),
      (enteredPin) => openedSettingsPins.push(enteredPin),
    );

    expect(container.innerHTML).toContain('#ff3b30'); // Red low-attempts warning

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

    // Settings button toggles menu, and menu item triggers onOpenSettings
    expect(settingsMenu.style.display).toBe('none');
    settingsBtn.click();
    expect(settingsMenu.style.display).toBe('flex');
    openSettingsMenuBtn.click();
    expect(settingsMenu.style.display).toBe('none');
    expect(openedSettingsPins).toEqual([undefined]);
  });

  it('renderPinEntry settings menu connects in rear-seat standby mode when 4-8 digit PIN is entered', () => {
    const {
      container,
      settingsBtn,
      settingsMenu,
      rearStandbyBtn,
      rearStandbySub,
      openSettingsMenuBtn,
      standbyHintEl,
      pressKey,
    } = setupPinEntryDom();

    const submitted: Array<{ pin: string; isSecondary?: boolean }> = [];
    const openedSettingsPins: Array<string | undefined> = [];

    renderPinEntry(
      container,
      10,
      (pin, isSecondary) => submitted.push({ pin, isSecondary }),
      (enteredPin) => openedSettingsPins.push(enteredPin),
      { hasActiveSession: false },
    );

    // Attempt standby connection before entering 4 digits -> shows hint and does not submit
    settingsBtn.click();
    expect(settingsMenu.style.display).toBe('flex');
    rearStandbyBtn.click();
    expect(settingsMenu.style.display).toBe('none');
    expect(submitted).toEqual([]);
    expect(standbyHintEl.style.display).toBe('block');
    expect(standbyHintEl.textContent).toContain('4〜8桁');

    // Enter 4-digit PIN -> hint clears and rear standby triggers onSubmit(pin, true)
    pressKey('2');
    pressKey('5');
    pressKey('8');
    pressKey('0');
    expect(standbyHintEl.style.display).toBe('none');
    expect(rearStandbySub.textContent).toContain('入力中のPINで接続');

    settingsBtn.click();
    rearStandbyBtn.click();
    expect(submitted).toEqual([{ pin: '2580', isSecondary: true }]);

    // Opening settings console while PIN is entered passes enteredPin
    settingsBtn.click();
    openSettingsMenuBtn.click();
    expect(openedSettingsPins).toEqual(['2580']);
  });

  it('renderPinEntry settings menu opens onboarding guide via menu item', () => {
    const { container, settingsBtn, settingsMenu, openGuideMenuBtn } = setupPinEntryDom();
    const onOpenGuide = vi.fn();

    renderPinEntry(container, 10, vi.fn(), vi.fn(), {
      hasActiveSession: false,
      onOpenGuide,
    });

    expect(container.innerHTML).toContain('id="pin-menu-open-guide-btn"');
    expect(container.innerHTML).toContain('使い方・オンボードガイド');

    settingsBtn.click();
    expect(settingsMenu.style.display).toBe('flex');
    openGuideMenuBtn.click();
    expect(settingsMenu.style.display).toBe('none');
    expect(onOpenGuide).toHaveBeenCalledTimes(1);
  });

  it('renderPinEntry hides secondary button when hasActiveSession is omitted or false', () => {
    const { container, submitBtn, pressKey } = setupPinEntryDom();
    const submitted: Array<{ pin: string; isSecondary?: boolean }> = [];

    renderPinEntry(
      container,
      10,
      (pin, isSecondary) => submitted.push({ pin, isSecondary }),
      vi.fn(),
    );

    expect(container.innerHTML).not.toContain('pin-connect-actions');
    expect(container.innerHTML).not.toContain('pin-secondary-btn');
    expect(document.getElementById('pin-secondary-btn')).toBeNull();
    expect(container.innerHTML).toContain('ストリーミング接続開始');

    pressKey('1');
    pressKey('2');
    pressKey('3');
    pressKey('4');
    submitBtn.click();
    expect(submitted).toEqual([{ pin: '1234', isSecondary: false }]);

    submitted.length = 0;
    renderPinEntry(
      container,
      10,
      (pin, isSecondary) => submitted.push({ pin, isSecondary }),
      vi.fn(),
      { hasActiveSession: false },
    );

    expect(container.innerHTML).not.toContain('pin-connect-actions');
    expect(container.innerHTML).not.toContain('pin-secondary-btn');
    expect(document.getElementById('pin-secondary-btn')).toBeNull();

    pressKey('5');
    pressKey('6');
    pressKey('7');
    pressKey('8');
    submitBtn.click();
    expect(submitted).toEqual([{ pin: '5678', isSecondary: false }]);
  });

  it('renderPinEntry renders side-by-side green primary and blue secondary buttons when hasActiveSession is true', () => {
    const { container, submitBtn, secondaryBtn, pressKey } = setupPinEntryDom();
    const submitted: Array<{ pin: string; isSecondary?: boolean }> = [];

    renderPinEntry(
      container,
      10,
      (pin, isSecondary) => submitted.push({ pin, isSecondary }),
      vi.fn(),
      { hasActiveSession: true },
    );

    expect(container.innerHTML).toContain('id="pin-connect-actions"');
    expect(container.innerHTML).toContain('id="pin-submit-btn"');
    expect(container.innerHTML).toContain('id="pin-secondary-btn"');
    expect(container.innerHTML).toContain('メインとして接続');
    expect(container.innerHTML).toContain('セカンドディスプレイとして接続');
    expect(container.innerHTML).toContain('#00ff88');
    expect(container.innerHTML).toContain('#3e6ae1');

    // Disabled until 4 digits are entered
    pressKey('1');
    pressKey('2');
    pressKey('3');
    expect(submitBtn.disabled).toBe(true);
    expect(secondaryBtn.disabled).toBe(true);

    pressKey('4');
    expect(submitBtn.disabled).toBe(false);
    expect(secondaryBtn.disabled).toBe(false);

    submitBtn.click();
    secondaryBtn.click();
    expect(submitted).toEqual([
      { pin: '1234', isSecondary: false },
      { pin: '1234', isSecondary: true },
    ]);
  });

  it('renderLockoutView displays brute-force lockout notice and lockout.json recovery instructions', () => {
    const container: any = { innerHTML: '' };
    renderLockoutView(container);

    expect(container.innerHTML).toContain('セキュリティロックアウト');
    expect(container.innerHTML).toContain('10回連続');
    expect(container.innerHTML).toContain('lockout.json');
  });
});
