import { ICONS, showToast } from './icons.js';
import { openOnboardingGuideModal } from './onboarding.js';

export function renderPinEntry(
  container: HTMLElement,
  remainingAttempts: number,
  onSubmit: (pin: string, isSecondary?: boolean) => void,
  onOpenSettings: (enteredPin?: string) => void,
  options?: { hasActiveSession?: boolean; onOpenGuide?: () => void },
): void {
  let pin = '';
  let isSettingsMenuOpen = false;
  const showSecondaryOption = options?.hasActiveSession === true;

  const setSettingsMenuOpen = (open: boolean) => {
    isSettingsMenuOpen = open;
    const menuEl = document.getElementById('pin-settings-menu');
    const backdropEl = document.getElementById('pin-settings-menu-backdrop');
    const settingsBtn = document.getElementById('pin-settings-btn');
    if (menuEl) {
      menuEl.style.display = open ? 'flex' : 'none';
    }
    if (backdropEl) {
      backdropEl.style.display = open ? 'block' : 'none';
    }
    if (settingsBtn) {
      settingsBtn.style.borderColor = open ? '#3e6ae1' : 'rgba(255,255,255,0.15)';
      settingsBtn.style.background = open ? 'rgba(62,106,225,0.22)' : 'rgba(255,255,255,0.08)';
    }
  };

  const showPinRequiredNotice = () => {
    const standbyHintEl = document.getElementById('pin-standby-hint');
    if (standbyHintEl) {
      standbyHintEl.textContent = '先に4〜8桁のPINコードを入力してください';
      standbyHintEl.style.color = '#ff453a';
      standbyHintEl.style.display = 'block';
    }
    if (typeof document?.createElement === 'function' && document.body) {
      showToast('先に4〜8桁のPINコードを入力してください', 'error');
    }
  };

  const updateDisplay = () => {
    const dotsEl = document.getElementById('pin-dots');
    if (dotsEl) {
      dotsEl.innerHTML =
        pin.length > 0
          ? pin
              .split('')
              .map(() => '●')
              .join(' ')
          : '<span style="color: #666; font-size: 24px;">PINを入力</span>';
    }
    const standbyHintEl = document.getElementById('pin-standby-hint');
    if (standbyHintEl && pin.length >= 4) {
      standbyHintEl.style.display = 'none';
    }
    const standbySubEl = document.getElementById('pin-menu-rear-standby-sub');
    if (standbySubEl) {
      standbySubEl.textContent =
        pin.length >= 4
          ? '前席の配信開始を待機して映像を受信（入力中のPINで接続）'
          : '先に4〜8桁のPINコードを入力してからタップ';
    }
    const updateButtonState = (btn: HTMLButtonElement | null) => {
      if (!btn) return;
      btn.disabled = pin.length < 4;
      if (pin.length >= 4) {
        btn.style.opacity = '1';
        btn.style.transform = 'scale(1.02)';
      } else {
        btn.style.opacity = '0.4';
        btn.style.transform = 'scale(1)';
      }
    };
    updateButtonState(document.getElementById('pin-submit-btn') as HTMLButtonElement | null);
    updateButtonState(document.getElementById('pin-secondary-btn') as HTMLButtonElement | null);
  };

  container.innerHTML = `
    <div style="
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      background: radial-gradient(circle at center, #1a1a24 0%, #0d0d12 100%);
      display: flex; flex-direction: column; justify-content: space-between;
      align-items: center; padding: 24px 20px; box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #fff; z-index: 1000; overflow: hidden;
    ">
      <div id="pin-settings-menu-backdrop" style="
        display: none; position: fixed; inset: 0; z-index: 1050; background: rgba(0, 0, 0, 0.35);
      "></div>

      <!-- Header -->
      <div style="width: 100%; max-width: 800px; display: flex; justify-content: space-between; align-items: center; position: relative; z-index: 1060;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="width: 14px; height: 14px; border-radius: 50%; background: #00ff88; box-shadow: 0 0 12px #00ff88;"></div>
          <h1 style="font-size: 24px; font-weight: 700; margin: 0; letter-spacing: 1px;">TESROID <span style="font-size: 14px; color: #00ff88; font-weight: 500;">v2 Browser</span></h1>
        </div>
        <div style="position: relative;">
          <button id="pin-settings-btn" style="
            background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15);
            color: #fff; width: 52px; height: 52px; border-radius: 12px;
            display: flex; align-items: center; justify-content: center; cursor: pointer;
          " title="設定・接続メニュー">${ICONS.settings}</button>

          <div id="pin-settings-menu" style="
            display: none; position: absolute; top: 60px; right: 0; width: 320px;
            flex-direction: column; gap: 8px; padding: 10px;
            background: rgba(22, 23, 31, 0.98); border: 1px solid rgba(255,255,255,0.16);
            border-radius: 14px; box-shadow: 0 14px 36px rgba(0,0,0,0.65); z-index: 1060;
          ">
            <button id="pin-menu-rear-standby-btn" type="button" class="pin-settings-menu-item pin-settings-menu-standby">
              <span class="pin-menu-icon" style="color: #60a5fa;">${ICONS.cinema}</span>
              <span class="pin-menu-text">
                <span class="pin-menu-title">後席モニター待ち受けモードで接続</span>
                <span id="pin-menu-rear-standby-sub" class="pin-menu-sub">先に4〜8桁のPINコードを入力してからタップ</span>
              </span>
            </button>
            <button id="pin-menu-open-settings-btn" type="button" class="pin-settings-menu-item">
              <span class="pin-menu-icon" style="color: #d1d5db;">${ICONS.settings}</span>
              <span class="pin-menu-text">
                <span class="pin-menu-title">設定・管理コンソール</span>
                <span class="pin-menu-sub">画質・お気に入り・PIN設定を変更</span>
              </span>
            </button>
            <button id="pin-menu-open-guide-btn" type="button" class="pin-settings-menu-item">
              <span class="pin-menu-icon" style="color: #34c759;">${ICONS.help}</span>
              <span class="pin-menu-text">
                <span class="pin-menu-title">使い方・オンボードガイド</span>
                <span class="pin-menu-sub">基本操作・HUD機能・接続要件を確認</span>
              </span>
            </button>
          </div>
        </div>
      </div>

      <!-- Center: PIN Display & Prompt -->
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; margin: 12px 0;">
        <p style="font-size: 16px; color: #aaa; margin: 0 0 12px 0; text-align: center;">テスラ車載接続用 PINコードを入力してください</p>
        <div id="pin-dots" style="
          font-size: 42px; letter-spacing: 14px; height: 56px;
          display: flex; align-items: center; justify-content: center;
          color: #00ff88; text-shadow: 0 0 16px rgba(0,255,136,0.6);
        ">
          <span style="color: #666; font-size: 24px;">PINを入力</span>
        </div>
        <div id="pin-attempt-msg" style="
          font-size: 14px; margin-top: 8px;
          color: ${remainingAttempts < 5 ? '#ff3b30' : '#888'};
        ">
          残り試行可能回数: <strong style="color: ${remainingAttempts < 5 ? '#ff3b30' : '#00ff88'};">${remainingAttempts}</strong> / 10
        </div>
        <div id="pin-standby-hint" style="
          display: none; font-size: 13px; margin-top: 6px; color: #ff453a; font-weight: 600;
        "></div>
      </div>

      <!-- Keypad (Spread to fill touch area) -->
      <div style="
        width: 100%; max-width: 680px; flex: 1; max-height: 480px;
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px;
        margin-bottom: 16px;
      ">
        <button class="fullscreen-numpad-key" data-key="1">1</button>
        <button class="fullscreen-numpad-key" data-key="2">2</button>
        <button class="fullscreen-numpad-key" data-key="3">3</button>
        <button class="fullscreen-numpad-key" data-key="4">4</button>
        <button class="fullscreen-numpad-key" data-key="5">5</button>
        <button class="fullscreen-numpad-key" data-key="6">6</button>
        <button class="fullscreen-numpad-key" data-key="7">7</button>
        <button class="fullscreen-numpad-key" data-key="8">8</button>
        <button class="fullscreen-numpad-key" data-key="9">9</button>
        <button class="fullscreen-numpad-key" data-key="clear" style="color: #ff453a; font-size: 24px;">C</button>
        <button class="fullscreen-numpad-key" data-key="0">0</button>
        <button class="fullscreen-numpad-key" data-key="back" style="font-size: 26px;">⌫</button>
      </div>

      <!-- Submit Button -->
      <div style="width: 100%; max-width: 680px;">
        ${
          showSecondaryOption
            ? `
        <div id="pin-connect-actions" style="display: flex; gap: 12px; width: 100%;">
          <button id="pin-submit-btn" style="
            flex: 1; height: 52px; background: #00ff88; color: #000;
            border: none; border-radius: 12px; font-size: 16px; font-weight: 700;
            cursor: pointer; transition: all 0.15s ease; opacity: 0.4;
            box-shadow: 0 4px 16px rgba(0,255,136,0.28);
            white-space: nowrap; padding: 0 12px;
          " disabled>
            メインとして接続
          </button>
          <button id="pin-secondary-btn" style="
            flex: 1.25; height: 52px; background: #3e6ae1; color: #fff;
            border: none; border-radius: 12px; font-size: 16px; font-weight: 700;
            cursor: pointer; transition: all 0.15s ease; opacity: 0.4;
            box-shadow: 0 4px 16px rgba(62,106,225,0.35);
            white-space: nowrap; padding: 0 12px;
          " disabled>
            セカンドディスプレイとして接続
          </button>
        </div>
        `
            : `
        <button id="pin-submit-btn" style="
          width: 100%; height: 60px; background: #00ff88; color: #000;
          border: none; border-radius: 14px; font-size: 20px; font-weight: 700;
          cursor: pointer; transition: all 0.15s ease; opacity: 0.4;
          box-shadow: 0 4px 20px rgba(0,255,136,0.3);
        " disabled>
          ストリーミング接続開始 ➔
        </button>
        `
        }
      </div>
    </div>

    <style>
      .fullscreen-numpad-key {
        background: rgba(255, 255, 255, 0.07);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 14px;
        color: #fff;
        font-size: 34px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.1s ease;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      .fullscreen-numpad-key:active {
        background: rgba(0, 255, 136, 0.25);
        border-color: #00ff88;
        transform: scale(0.96);
      }
      .pin-settings-menu-item {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        padding: 12px 14px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.05);
        color: #fff;
        text-align: left;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      .pin-settings-menu-item:active {
        background: rgba(255, 255, 255, 0.14);
      }
      .pin-settings-menu-standby {
        border-color: rgba(62, 106, 225, 0.45);
        background: rgba(62, 106, 225, 0.16);
      }
      .pin-settings-menu-standby:active {
        background: rgba(62, 106, 225, 0.3);
      }
      .pin-menu-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .pin-menu-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .pin-menu-title {
        font-size: 14px;
        font-weight: 700;
        line-height: 1.3;
      }
      .pin-menu-sub {
        font-size: 11px;
        color: #9ca3af;
        line-height: 1.35;
      }
    </style>
  `;

  // Keypad click handlers
  const keys = container.querySelectorAll('.fullscreen-numpad-key');
  keys.forEach((k) => {
    k.addEventListener('click', () => {
      const val = k.getAttribute('data-key');
      if (val === 'clear') {
        pin = '';
      } else if (val === 'back') {
        pin = pin.slice(0, -1);
      } else if (val && pin.length < 8) {
        pin += val;
      }
      updateDisplay();
    });
  });

  // Submit handlers
  const submitBtn = document.getElementById('pin-submit-btn') as HTMLButtonElement | null;
  submitBtn?.addEventListener('click', () => {
    if (pin.length >= 4) {
      onSubmit(pin, false);
    }
  });

  const secondaryBtn = document.getElementById('pin-secondary-btn') as HTMLButtonElement | null;
  secondaryBtn?.addEventListener('click', () => {
    if (pin.length >= 4) {
      onSubmit(pin, true);
    }
  });

  // Settings menu handlers
  document.getElementById('pin-settings-btn')?.addEventListener('click', () => {
    setSettingsMenuOpen(!isSettingsMenuOpen);
  });

  document.getElementById('pin-settings-menu-backdrop')?.addEventListener('click', () => {
    setSettingsMenuOpen(false);
  });

  document.getElementById('pin-menu-rear-standby-btn')?.addEventListener('click', () => {
    setSettingsMenuOpen(false);
    if (pin.length >= 4) {
      onSubmit(pin, true);
    } else {
      showPinRequiredNotice();
    }
  });

  document.getElementById('pin-menu-open-settings-btn')?.addEventListener('click', () => {
    setSettingsMenuOpen(false);
    onOpenSettings(pin.length >= 4 ? pin : undefined);
  });

  document.getElementById('pin-menu-open-guide-btn')?.addEventListener('click', () => {
    setSettingsMenuOpen(false);
    if (options?.onOpenGuide) {
      options.onOpenGuide();
    } else {
      openOnboardingGuideModal(container);
    }
  });
}
