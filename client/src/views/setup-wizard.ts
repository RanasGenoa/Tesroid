import { renderOnboardingGuide } from './onboarding.js';
import { bindPinInputValidation, setPinFieldError, validatePinInput } from './pin-validation.js';

// Issue #101: 3 択はサーバー側の既存設定項目（clientProfile / performancePreset / displayScale 等）
// への初期値ショートカット。先行バッファ深度と表示拡大率のローカル先行表示のみクライアント側
// localStorage 設定のため、セットアップ完了時に同一プリセット対応の初期値をローカルへ書き込む
// （再セットアップ時の旧 `tesroid_display_scale` 残留による一瞬の旧値表示を防ぐ。PR #102 3rd L）。
type QualityPresetChoice = 'high' | 'standard' | 'lightweight';
// 注意: displayScale の値はサーバー側 server/src/routes/setup.ts の
// ONBOARDING_QUALITY_PRESETS.displayScale と必ず同期させること（プリセット調整時は両方を更新）。
const QUALITY_PRESET_LOCAL_DEFAULTS: Record<
  QualityPresetChoice,
  { bufferDepthMs: number; displayScale: number }
> = {
  high: { bufferDepthMs: 10000, displayScale: 120 }, // 推奨 10秒 / 標準ズーム (cfg-* と同一段階)
  standard: { bufferDepthMs: 10000, displayScale: 120 },
  lightweight: { bufferDepthMs: 2000, displayScale: 70 }, // 軽量 2秒・70% (Intel / MCU2 向け)
};

function normalizeQualityPreset(raw: unknown): QualityPresetChoice {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value === 'high' || value === 'lightweight' ? value : 'standard';
}

function applyQualityPresetLocalDefaults(choice: QualityPresetChoice): void {
  const defaults = QUALITY_PRESET_LOCAL_DEFAULTS[choice];
  try {
    localStorage.setItem('tesroid_prefetch_buffer_ms', String(defaults.bufferDepthMs));
    localStorage.setItem('tesroid_display_scale', String(defaults.displayScale));
  } catch {
    // localStorage 不可環境 (テスト / プライベートモード) ではサーバー側設定のみ適用する
  }
}

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

        <form id="setup-form" novalidate>
          <label style="display: block; font-size: 14px; margin-bottom: 6px;">
            認証PINコード (半角数字 4〜8桁) <span style="color: var(--danger-color)">*必須</span>
          </label>
          <input
            type="password"
            id="setup-pin"
            inputmode="numeric"
            pattern="[0-9]*"
            autocomplete="new-password"
            placeholder="例: 1234（半角数字4〜8桁）"
            maxlength="8"
            required
            style="margin-bottom: 6px;"
          />
          <p style="font-size: 12px; color: var(--text-muted); margin: 0 0 8px 0;">
            ※ 車載ログイン画面の数字テンキーで入力するため、0〜9 の半角数字のみで 4〜8 桁を設定してください。
          </p>
          <div id="setup-pin-error" style="color: var(--danger-color); font-size: 13px; margin-bottom: 12px; display: none;"></div>

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

          <!-- Issue #101: 3 択は設定画面内の既存項目（クライアント負荷・サーバー性能・拡大率等）の初期値ショートカット -->
          <label style="display: block; font-size: 14px; margin-bottom: 6px; margin-top: 12px;">
            負荷・品質の初期プリセット
          </label>
          <select id="setup-quality-preset">
            <option value="high">最高品質 (MCU3 / ハイエンドサーバー推奨)</option>
            <option value="standard" selected>標準 (MCU3)（おすすめ）</option>
            <option value="lightweight">軽量 (Intel / MCU2 車両・低解像度低負荷推奨)</option>
          </select>
          <p style="font-size: 12px; color: var(--text-muted); margin: 6px 0 8px 0; line-height: 1.5;">
            ※ この選択は設定画面内の各項目（クライアント負荷・サーバー性能・拡大率など）の初期値をまとめて設定するものです。セットアップ後も設定画面からいつでも個別にすぐ変更できます。
          </p>

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
    const pinInput = document.getElementById('setup-pin') as HTMLInputElement | null;
    const pinErrorEl = document.getElementById('setup-pin-error') as HTMLElement | null;
    bindPinInputValidation(pinInput, pinErrorEl);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = pinInput?.value ?? '';
      const domain = (
        (document.getElementById('setup-domain') as HTMLInputElement | null)?.value ?? ''
      ).trim();
      const tz =
        (document.getElementById('setup-tz') as HTMLSelectElement | null)?.value || 'Asia/Tokyo';
      const locale =
        (document.getElementById('setup-locale') as HTMLSelectElement | null)?.value || 'ja-JP';
      // 未選択・想定外値は「標準」へフォールバック（サーバー既定と同一）
      const qualityPreset = normalizeQualityPreset(
        (document.getElementById('setup-quality-preset') as HTMLSelectElement | null)?.value,
      );
      const errDiv = document.getElementById('setup-error') as HTMLElement | null;

      const pinError = validatePinInput(pin);
      if (pinError) {
        setPinFieldError(pinInput, pinErrorEl, pinError);
        if (errDiv) {
          errDiv.textContent = pinError;
          errDiv.style.display = 'block';
        }
        pinInput?.focus?.();
        return;
      }
      setPinFieldError(pinInput, pinErrorEl, null);
      if (errDiv) {
        errDiv.textContent = '';
        errDiv.style.display = 'none';
      }

      const allowedDomains = domain
        ? domain
            .split(',')
            .map((d) => d.trim())
            .filter(Boolean)
        : [];

      try {
        const res = await fetch('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pin,
            allowedDomains,
            timezone: tz,
            locale,
            qualityPreset,
          }),
        });

        const data = await res.json();
        if (res.ok && data.success) {
          // 先行バッファ深度・表示拡大率のローカル初期値を同一プリセット値へ揃える
          applyQualityPresetLocalDefaults(qualityPreset);
          onCompleted();
        } else if (errDiv) {
          errDiv.textContent = data.error || 'セットアップに失敗しました。';
          errDiv.style.display = 'block';
        }
      } catch {
        if (errDiv) {
          errDiv.textContent = 'サーバーとの通信に失敗しました。';
          errDiv.style.display = 'block';
        }
      }
    });
  };

  renderCurrentStep();
}
