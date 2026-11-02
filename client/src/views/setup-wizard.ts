import { renderOnboardingGuide } from './onboarding.js';

export function renderSetupWizard(container: HTMLElement, onCompleted: () => void): void {
  let step = 1;

  const renderCurrentStep = () => {
    container.innerHTML = '';

    if (step === 1) {
      renderOnboardingGuide(container, () => {
        step = 2;
        renderCurrentStep();
      });
      return;
    }

    // Step 2: Setup form
    container.innerHTML = `
      <div class="card">
        <h2>Tesroid 初期セットアップ</h2>
        <p>外部公開と車載アクセスのための初期パラメータを設定します。</p>

        <form id="setup-form">
          <label style="display: block; font-size: 14px; margin-bottom: 6px;">
            認証PINコード (4〜8桁の数字・文字) <span style="color: var(--danger-color)">*必須</span>
          </label>
          <input type="password" id="setup-pin" placeholder="例: 1234" maxlength="8" required />

          <label style="display: block; font-size: 14px; margin-bottom: 6px;">
            接続用独自ドメイン (任意・カンマ区切り)
          </label>
          <input type="text" id="setup-domain" placeholder="例: tesroid.yourdomain.com" />

          <label style="display: block; font-size: 14px; margin-bottom: 6px;">
            タイムゾーン
          </label>
          <select id="setup-tz">
            <option value="Asia/Tokyo" selected>Asia/Tokyo (日本標準時)</option>
            <option value="UTC">UTC</option>
            <option value="America/New_York">America/New_York</option>
            <option value="America/Los_Angeles">America/Los_Angeles</option>
          </select>

          <label style="display: block; font-size: 14px; margin-bottom: 6px;">
            システム表示言語
          </label>
          <select id="setup-locale">
            <option value="ja-JP" selected>日本語 (ja-JP)</option>
            <option value="en-US">English (en-US)</option>
          </select>

          <div id="setup-error" style="color: var(--danger-color); font-size: 14px; margin-bottom: 12px; display: none;"></div>

          <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 20px;">
            <button type="submit" id="setup-submit-btn" class="btn" style="width: 100%;">
              設定を保存して完了
            </button>
          </div>
        </form>
      </div>
    `;

    const form = document.getElementById('setup-form') as HTMLFormElement;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = (document.getElementById('setup-pin') as HTMLInputElement).value.trim();
      const domain = (document.getElementById('setup-domain') as HTMLInputElement).value.trim();
      const tz = (document.getElementById('setup-tz') as HTMLSelectElement).value;
      const locale = (document.getElementById('setup-locale') as HTMLSelectElement).value;
      const errDiv = document.getElementById('setup-error')!;

      if (!pin || pin.length < 4 || pin.length > 8) {
        errDiv.textContent = 'PINコードは4〜8桁で入力してください。';
        errDiv.style.display = 'block';
        return;
      }

      const allowedDomains = domain ? domain.split(',').map((d) => d.trim()).filter(Boolean) : [];

      try {
        const res = await fetch('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pin,
            allowedDomains,
            timezone: tz,
            locale,
          }),
        });

        const data = await res.json();
        if (res.ok && data.success) {
          onCompleted();
        } else {
          errDiv.textContent = data.error || 'セットアップに失敗しました。';
          errDiv.style.display = 'block';
        }
      } catch (err) {
        errDiv.textContent = 'サーバーとの通信に失敗しました。';
        errDiv.style.display = 'block';
      }
    });
  };

  renderCurrentStep();
}
