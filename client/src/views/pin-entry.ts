import { ICONS } from './icons.js';

export function renderPinEntry(
  container: HTMLElement,
  remainingAttempts: number,
  onSubmit: (pin: string) => void,
  onOpenSettings: () => void
): void {
  let pin = '';

  const updateDisplay = () => {
    const dotsEl = document.getElementById('pin-dots');
    if (dotsEl) {
      dotsEl.innerHTML = pin.length > 0
        ? pin.split('').map(() => '●').join(' ')
        : '<span style="color: #666; font-size: 24px;">PINを入力</span>';
    }
    const submitBtn = document.getElementById('pin-submit-btn') as HTMLButtonElement;
    if (submitBtn) {
      submitBtn.disabled = pin.length < 4;
      if (pin.length >= 4) {
        submitBtn.style.opacity = '1';
        submitBtn.style.transform = 'scale(1.02)';
      } else {
        submitBtn.style.opacity = '0.4';
        submitBtn.style.transform = 'scale(1)';
      }
    }
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
      <!-- Header -->
      <div style="width: 100%; max-width: 800px; display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="width: 14px; height: 14px; border-radius: 50%; background: #00ff88; box-shadow: 0 0 12px #00ff88;"></div>
          <h1 style="font-size: 24px; font-weight: 700; margin: 0; letter-spacing: 1px;">TESROID <span style="font-size: 14px; color: #00ff88; font-weight: 500;">v2 Browser</span></h1>
        </div>
        <button id="pin-settings-btn" style="
          background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15);
          color: #fff; width: 52px; height: 52px; border-radius: 12px;
          display: flex; align-items: center; justify-content: center; cursor: pointer;
        " title="設定">${ICONS.settings}</button>
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
        <button id="pin-submit-btn" style="
          width: 100%; height: 60px; background: #00ff88; color: #000;
          border: none; border-radius: 14px; font-size: 20px; font-weight: 700;
          cursor: pointer; transition: all 0.15s ease; opacity: 0.4;
          box-shadow: 0 4px 20px rgba(0,255,136,0.3);
        " disabled>
          ストリーミング接続開始 ➔
        </button>
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

  // Submit handler
  const submitBtn = document.getElementById('pin-submit-btn') as HTMLButtonElement;
  submitBtn.addEventListener('click', () => {
    if (pin.length >= 4) {
      onSubmit(pin);
    }
  });

  // Settings button handler
  document.getElementById('pin-settings-btn')?.addEventListener('click', onOpenSettings);
}
