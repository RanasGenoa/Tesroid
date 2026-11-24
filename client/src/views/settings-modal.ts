import {
  describeEncoderStatus,
  type EncoderStatusPayload,
  resolveDisplayPreset,
  vaapiControlsEnabled,
  visiblePresetIds,
} from './encoder-policy.js';
import {
  clearElementChildren,
  DEFAULT_FAVORITES,
  DEFAULT_HOME_FAVORITE_ID,
  escapeHtml,
  type FavoriteItem,
  ICONS,
  insertFavoritePreservingHome,
  isSafeHttpUrl,
  pinHomeFavoriteFirst,
  resolveHomeFavorite,
  sanitizeFavorites,
  showToast,
} from './icons.js';
import { bindPinInputValidation, setPinFieldError, validatePinInput } from './pin-validation.js';

export function openSettingsWithAuth(
  container: HTMLElement,
  authToken: string | null,
  onRequireAuth: (callback: (token: string) => void) => void,
  onClose: () => void,
): void {
  if (authToken) {
    showSettingsModal(container, authToken, onClose);
  } else {
    onRequireAuth((token: string) => {
      showSettingsModal(container, token, onClose);
    });
  }
}

async function showSettingsModal(
  container: HTMLElement,
  token: string,
  onClose: () => void,
): Promise<void> {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  overlay.innerHTML = `
    <div class="card" style="max-width: 680px; max-height: 85vh; overflow-y: auto; position: relative;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h2 style="margin: 0; font-size: 20px; display: flex; align-items: center; gap: 8px;">
          ${ICONS.settings} Tesroid v2 設定・管理コンソール
        </h2>
        <button id="modal-close-btn" class="hud-btn" style="font-size: 20px; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center;">✕</button>
      </div>

      <!-- Tabs -->
      <div style="display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 8px; flex-wrap: wrap;">
        <button id="tab-browser" class="btn btn-secondary" style="padding: 8px 14px; font-size: 13px; display: flex; align-items: center; gap: 6px;">
          ${ICONS.globe} Webブラウザ
        </button>
        <button id="tab-general" class="btn btn-secondary" style="padding: 8px 14px; font-size: 13px; display: flex; align-items: center; gap: 6px;">
          ${ICONS.settings} 一般 & PIN
        </button>
        <button id="tab-metrics" class="btn btn-secondary" style="padding: 8px 14px; font-size: 13px; display: flex; align-items: center; gap: 6px;">
          ${ICONS.activity} 品質統計
        </button>
      </div>

      <!-- Tab Content: Browser -->
      <div id="content-browser">
        <h3 style="font-size: 15px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
          ${ICONS.globe} ブラウザURL移動
        </h3>
        <p style="font-size: 13px; margin-bottom: 12px; color: var(--text-muted);">ブラウザで開くWebページを指定します。</p>
        <div style="display: flex; gap: 8px; margin-bottom: 16px;">
          <input type="text" id="browser-url-input" placeholder="https://www.youtube.com" style="flex: 1;" />
          <button id="browser-url-btn" class="btn btn-primary" style="padding: 0 16px; display: flex; align-items: center; gap: 6px;">
            移動 ${ICONS.arrowRight}
          </button>
        </div>

        <div class="fav-manage-section">
          <div class="fav-manage-header">
            <h3 style="font-size: 15px; margin: 0; display: flex; align-items: center; gap: 6px;">
              ${ICONS.star} お気に入り管理 & ホーム設定
            </h3>
            <button id="fav-reset-btn" type="button" class="btn btn-secondary" style="font-size: 12px; padding: 6px 12px; min-height: 36px; display: inline-flex; align-items: center; gap: 6px;">
              ${ICONS.refresh} 初期プリセットに戻す
            </button>
          </div>

          <div class="fav-form-card">
            <div class="fav-form-inputs">
              <input type="text" id="fav-title-input" placeholder="サイト名 (例: YouTube)" autocomplete="off" />
              <input type="text" id="fav-url-input" placeholder="https://www.youtube.com" autocomplete="off" />
            </div>
            <div class="fav-form-actions">
              <button id="fav-add-btn" type="button" class="btn btn-primary" style="padding: 8px 16px; min-height: 40px; font-size: 13px; gap: 6px;">
                ${ICONS.plus} 追加
              </button>
              <button id="fav-cancel-edit-btn" type="button" class="btn btn-secondary" style="display: none; padding: 8px 14px; min-height: 40px; font-size: 13px;">
                キャンセル
              </button>
              <button id="fav-add-current-modal-btn" type="button" class="btn btn-secondary" style="padding: 8px 14px; min-height: 40px; font-size: 13px; gap: 6px; margin-left: auto;">
                ${ICONS.plus} 現在のページを追加
              </button>
            </div>
          </div>

          <div id="favorites-manage-list" class="fav-manage-list"></div>
        </div>
      </div>

      <!-- Tab Content: General & PIN -->
      <div id="content-general" style="display: none;">
        <label style="display: block; font-size: 14px; margin-bottom: 6px;">新しいPINコード (半角数字 4〜8桁 / 空欄で維持)</label>
        <input
          type="password"
          id="cfg-pin"
          inputmode="numeric"
          pattern="[0-9]*"
          autocomplete="new-password"
          placeholder="変更する場合のみ入力（例: 1234）"
          maxlength="8"
          style="margin-bottom: 6px;"
        />
        <div id="cfg-pin-error" style="color: var(--danger-color); font-size: 13px; margin-bottom: 6px; display: none;"></div>
        <p style="font-size: 11px; color: var(--text-muted); margin: 0 0 4px 0;">※ 車載ログイン画面の数字テンキーで入力するため、0〜9 の半角数字のみ設定できます。</p>

        <label style="display: block; font-size: 14px; margin-bottom: 6px; margin-top: 12px;">ブラウザ表示拡大率 (文字サイズ・UI拡大)</label>
        <select id="cfg-display-scale">
          <option value="80">80% (縮小 / 情報量重視)</option>
          <option value="100">100% (等倍)</option>
          <option value="110">110% (やや拡大)</option>
          <option value="120" selected>120% (標準・車載画面推奨)</option>
          <option value="130">130% (拡大)</option>
          <option value="140">140% (大文字)</option>
          <option value="150">150% (特大)</option>
        </select>

        <label style="display: block; font-size: 14px; margin-bottom: 6px; margin-top: 12px;">システム表示言語 (ブラウザ言語)</label>
        <select id="cfg-locale">
          <option value="ja-JP" selected>日本語 (ja-JP)</option>
          <option value="en-US">English (en-US)</option>
        </select>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 6px; gap: 8px;">
          <p style="font-size: 11px; color: var(--text-muted); margin: 0;">※ 言語の変更は次回ブラウザ起動時または再起動時に反映されます。</p>
          <button type="button" id="cfg-restart-browser-btn" class="btn btn-secondary" style="font-size: 11px; padding: 4px 8px; white-space: nowrap;">
            ブラウザ再起動
          </button>
        </div>

        <label style="display: block; font-size: 14px; margin-bottom: 6px; margin-top: 12px;">先行バッファ深度 (回線瞬断・トンネル対策 / メモリ調整)</label>
        <select id="cfg-buffer-depth">
          <option value="0">オフ (0.1秒 / 超低遅延優先)</option>
          <option value="2000">軽量 2秒 (Intel / MCU2車両向け・省メモリ約280KB)</option>
          <option value="5000">標準 5秒 (市街地走行向け・メモリ約700KB)</option>
          <option value="10000" selected>推奨 10秒 (トンネル・郊外向け / Ryzen推奨)</option>
          <option value="20000">拡張 20秒 (山間部・長大トンネル向け / メモリ約13MB)</option>
          <option value="30000">最大 30秒 (弱電波・極限耐障害 / メモリ約19MB・Ryzen推奨)</option>
        </select>

        <label style="display: block; font-size: 14px; margin-bottom: 6px; margin-top: 12px;">音声ビットレート (音質調整 / 128k〜320k)</label>
        <select id="cfg-audio-bitrate">
          <option value="128000" selected>128 kbps (標準・低遅延推奨)</option>
          <option value="192000">192 kbps (高音質)</option>
          <option value="256000">256 kbps (超高音質)</option>
          <option value="320000">320 kbps (最高音質・スタジオ品質)</option>
        </select>
        <p style="font-size: 11px; color: var(--text-muted); margin-top: 4px; margin-bottom: 0;">※ 車内での音楽鑑賞等で音質を優先する場合は192k〜320kを選択してください。</p>

        <!-- Issue #11: クライアント負荷設定 (車載ブラウザ側のデコード/描画負荷) -->
        <div style="margin-top: 16px; border-top: 1px solid var(--border-color); padding-top: 14px;">
          <h4 style="font-size:14px;margin:0 0 6px 0;">📺 クライアント負荷設定 (車載ブラウザのデコード・描画負荷)</h4>
          <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px 0;line-height:1.5;">
            車載ディスプレイ側でデコード・表示する映像の解像度とFPSを決めます。リモートブラウザの表示レイアウト（操作性）は変えず、映像のみを縮小します。<br/>
            Intel搭載車 (MCU2) には「軽量」を選択してください。下のサーバー負荷設定とは別軸で、配信解像度は両者の厳しい方が採用されます。
          </p>
          <select id="cfg-client-profile">
            <option value="standard" selected>標準 (Ryzen / MCU3 推奨・現行品質)</option>
            <option value="lightweight">軽量 (Intel / MCU2 推奨・解像度65%・FPS上限30)</option>
            <option value="custom">カスタム (詳細設定を表示)</option>
          </select>
          <div id="cfg-client-resolved-note" style="font-size:12px;color:var(--text-muted);margin-top:6px;line-height:1.5;"></div>
          <div id="cfg-client-custom-panel" style="display:none;margin-top:10px;padding:10px;border-radius:8px;background:rgba(0,0,0,0.2);border:1px solid var(--border-color);">
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px;">エンコード解像度倍率 (レイアウトに対する比率・低いほど車載側が軽量)</label>
            <select id="cfg-client-scale">
              <option value="1">100% (フル解像度)</option>
              <option value="0.85">85% (画素数約72%)</option>
              <option value="0.75">75% (画素数約56%)</option>
              <option value="0.65" selected>65% (画素数約42%・MCU2推奨)</option>
              <option value="0.5">50% (画素数25%・最軽量)</option>
            </select>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin:10px 0 6px 0;">HUDで選べるFPS (24未満にはできません)</label>
            <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:13px;">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="cfg-client-fps-24" style="width:16px;height:16px;accent-color:var(--accent-primary,#38bdf8);" /> 24</label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="cfg-client-fps-30" checked style="width:16px;height:16px;accent-color:var(--accent-primary,#38bdf8);" /> 30</label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="cfg-client-fps-60" checked style="width:16px;height:16px;accent-color:var(--accent-primary,#38bdf8);" /> 60</label>
            </div>
          </div>
        </div>

        <div style="margin-top: 16px; border-top: 1px solid var(--border-color); padding-top: 14px;">
          <div id="encoder-status-panel" style="font-size: 12px; line-height: 1.6; padding: 8px 10px; margin-bottom: 10px; border-radius: 8px; background: rgba(0, 0, 0, 0.25); border: 1px solid var(--border-color); color: var(--text-muted);">
            エンコーダー状態を読み込み中...
          </div>
          <div id="cfg-encoder-cpu-warning" style="display:none; font-size:12px; color:#fbbf24; line-height:1.5; margin-bottom:10px;">
            ⚠ サーバーは現在 CPU で映像を処理しています（ソフトウェアエンコード）。サーバーのスペックによっては動作が快適ではないかもしれません。稼働中の負荷（CPU・GPU使用率）を確認してください。
          </div>
          <label style="display: block; font-size: 14px; margin-bottom: 6px;">サーバー映像パフォーマンス (iGPU負荷調整)</label>
          <select id="cfg-perf-preset">
            <option value="high" data-preset-scope="gpu">最高 (最大 1920px / GPU変換・高画質)</option>
            <option value="balanced" data-preset-scope="gpu" selected>標準 (最大 1280px / GPU変換・高効率)</option>
            <option value="low_power" data-preset-scope="gpu">軽量・省電力 (最大 960px / GPU変換・最速エンコード)</option>
            <option value="cpu_balanced" data-preset-scope="cpu" hidden>CPU・標準 (libx264 veryfast / 最大 1280px)</option>
            <option value="cpu_low_power" data-preset-scope="cpu" hidden>CPU・軽量 (libx264 ultrafast / 最大 960px)</option>
            <option value="custom">カスタム (詳細設定を表示)</option>
          </select>

          <!-- 注意: カスタム設定内の VAAPI負荷優先度・scale_vaapi・-low_power 1 は Intel UHD 等・環境依存であり、環境によっては正しく動作しない場合があります（scale_vaapi / -low_power 1 は自動フォールバック対応） -->
          <div id="cfg-perf-custom-panel" style="display: none; margin-top: 10px; padding: 10px; border-radius: 8px; background: rgba(0, 0, 0, 0.2); border: 1px solid var(--border-color);">
            <div id="cfg-vaapi-disabled-note" style="display: none; font-size: 12px; color: #fbbf24; margin-bottom: 8px; line-height: 1.5;">
              ※ 現在のエンコーダーは CPU (libx264) のため、以下の VAAPI 設定は適用されません。
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
              <div>
                <label style="display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 4px;">最大解像度 (長辺上限)</label>
                <select id="cfg-max-size">
                  <option value="640">640px (最軽量・MCU2 / 弱回線向け)</option>
                  <option value="960">960px (軽量・省電力)</option>
                  <option value="1280" selected>1280px (標準)</option>
                  <option value="1440">1440px (高画質)</option>
                  <option value="1920">1920px (最高・フルHD)</option>
                </select>
              </div>
              <div>
                <label style="display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 4px;">VAAPI負荷優先度 (1-7・Intel UHD等 / VAAPI環境依存)</label>
                <select id="cfg-vaapi-compression">
                  <option value="1">1 (最高画質・重)</option>
                  <option value="4">4 (高画質)</option>
                  <option value="6">6 (高速・軽量)</option>
                  <option value="7" selected>7 (標準・最軽量)</option>
                </select>
              </div>
            </div>

            <label style="display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13px; cursor: pointer;">
              <input type="checkbox" id="cfg-vaapi-gpu-csc" checked style="width: 16px; height: 16px; accent-color: var(--accent-primary, #38bdf8);" />
              <span>GPU 色空間変換 (<code>scale_vaapi</code>・Intel UHD等 / VAAPI環境依存) で CPU 負荷を削減</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 13px; cursor: pointer;">
              <input type="checkbox" id="cfg-vaapi-low-power" style="width: 16px; height: 16px; accent-color: var(--accent-primary, #38bdf8);" />
              <span>Intel VDEnc 低電力モード (<code>-low_power 1</code>・Intel UHD等 / 環境依存) を使用</span>
            </label>
            <p style="font-size: 11px; color: #fbbf24; margin-top: 8px; margin-bottom: 0; line-height: 1.5;">
              ※ VAAPI 負荷優先度・<code>scale_vaapi</code>・<code>-low_power 1</code> は Intel UHD 等・環境依存のオプションです（環境によっては正しく動作しない場合があります）。<code>scale_vaapi</code> と <code>-low_power 1</code> は起動失敗時に自動で安全側へフォールバックします。
            </p>
          </div>
        </div>

        <button id="cfg-save-btn" class="btn btn-primary" style="width: 100%; margin-top: 20px; display: flex; align-items: center; justify-content: center; gap: 6px;">
          ${ICONS.check} 設定を保存
        </button>
      </div>

      <!-- Tab Content: Metrics -->
      <div id="content-metrics" style="display: none;">
        <h3 style="font-size: 15px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
          ${ICONS.activity} リアルタイム品質統計
        </h3>
        <div id="metrics-display" style="background: rgba(0,0,0,0.3); border-radius: 8px; padding: 14px; font-family: monospace; font-size: 13px; line-height: 1.6;">
          読み込み中...
        </div>

        <!-- Developer Telemetry Options (Load Reduction) -->
        <div style="margin-top: 16px; border-top: 1px solid var(--border-color); padding-top: 14px;">
          <h4 style="font-size: 14px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
            <span>🛠️ 開発者向けオプション: 詳細テレメトリ収集</span>
            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; font-size: 13px; font-weight: normal;">
              <input type="checkbox" id="cfg-telemetry-toggle" style="width: 18px; height: 18px; cursor: pointer; accent-color: var(--accent-primary, #38bdf8);" />
              <span>有効化 (ON)</span>
            </label>
          </h4>
          <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px; line-height: 1.5;">
            A/V同期シフト量、バッファリング出入、デコーダ・FramePacerのミリ秒トレースをサーバーへJSONL形式で記録します。<br/>
            <strong style="color: #fbbf24;">※ 通常運用時はクライアント・サーバー双方の負荷低減のため「OFF」を推奨します。</strong>
          </p>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button id="cfg-telemetry-clear-btn" class="btn btn-secondary" style="font-size: 12px; padding: 7px 12px; display: flex; align-items: center; gap: 6px; color: #f87171;">
              ${ICONS.trash} サーバーログ全消去
            </button>
          </div>
          <div id="telemetry-action-msg" style="font-size: 12px; margin-top: 8px; min-height: 18px;"></div>
        </div>
      </div>
    </div>
  `;

  container.appendChild(overlay);

  // Metrics polling timer & clear confirmation timer
  let metricsTimer: any = null;
  let clearConfirmTimer: any = null;
  let favResetConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  const favoritesManageList = overlay.querySelector('#favorites-manage-list') as HTMLElement | null;

  // Issue #90: エンコーダーバックエンド連動UI（グレーアウト / プリセット選択肢切替 / 状態併記）
  let encoderStatus: EncoderStatusPayload | null = null;
  let encoderStatusTimer: ReturnType<typeof setInterval> | null = null;
  let encoderModalClosed = false;
  let encoderStatusInFlight = false;
  let savedPerformancePreset: string | undefined;
  let presetTouched = false;

  const applyEncoderBackendUi = () => {
    const statusPanel = overlay.querySelector('#encoder-status-panel');
    if (statusPanel) {
      statusPanel.textContent = describeEncoderStatus(encoderStatus);
    }

    // VAAPI依存3項目のグレーアウト（backend === 'software' のときのみ明確に無効化）
    const vaapiEnabled = vaapiControlsEnabled(encoderStatus);
    for (const selector of [
      '#cfg-vaapi-compression',
      '#cfg-vaapi-gpu-csc',
      '#cfg-vaapi-low-power',
    ]) {
      const el = overlay.querySelector(selector) as HTMLInputElement | HTMLSelectElement | null;
      if (!el) continue;
      el.disabled = !vaapiEnabled;
      el.style.opacity = vaapiEnabled ? '' : '0.4';
    }
    const disabledNote = overlay.querySelector('#cfg-vaapi-disabled-note') as HTMLElement | null;
    if (disabledNote) {
      disabledNote.style.display = vaapiEnabled ? 'none' : 'block';
    }

    // Issue #11: CPU (ソフトウェア) 動作時の車載向け注意アナウンス（黄文字）
    const cpuWarningEl = overlay.querySelector('#cfg-encoder-cpu-warning') as HTMLElement | null;
    if (cpuWarningEl) {
      cpuWarningEl.style.display =
        encoderStatus && encoderStatus.backend === 'software' ? 'block' : 'none';
    }

    // プリセット選択肢の表示/非表示切替（GPU前提 / CPU向け / custom）
    const presetSelect = overlay.querySelector('#cfg-perf-preset') as HTMLSelectElement | null;
    if (presetSelect) {
      const visible = visiblePresetIds(encoderStatus);
      const optionEls = presetSelect.options ? Array.from(presetSelect.options) : [];
      for (const opt of optionEls) {
        const show = (visible as readonly string[]).includes(opt.value);
        opt.hidden = !show;
        opt.disabled = !show;
      }
      const visibleValues = optionEls.map((o) => o.value);
      if (
        optionEls.length > 0 &&
        visibleValues.some((v) => (visible as readonly string[]).includes(v))
      ) {
        // 未操作時は常に保存値から再評価する。/api/settings が /api/health より先に
        // 完了すると、ステータス未取得（=GPU前提一覧）で 'custom' に書き換わった後、
        // health 再適用時に 'custom' が可視値のため元へ戻らないレースがある (Issue #90 review)。
        const targetPreset =
          !presetTouched && savedPerformancePreset
            ? resolveDisplayPreset(savedPerformancePreset, encoderStatus)
            : !(visible as readonly string[]).includes(presetSelect.value)
              ? resolveDisplayPreset(savedPerformancePreset ?? presetSelect.value, encoderStatus)
              : presetSelect.value;
        if (presetSelect.value !== targetPreset) {
          presetSelect.value = targetPreset;
          const customPanelEl = overlay.querySelector(
            '#cfg-perf-custom-panel',
          ) as HTMLElement | null;
          if (customPanelEl) {
            customPanelEl.style.display = presetSelect.value === 'custom' ? 'block' : 'none';
          }
        }
      }
    }
  };

  const fetchEncoderStatus = async () => {
    // 5秒間隔のポーリングが多重実行されても、進行中の1本だけ通す (Issue #90 review)
    if (encoderStatusInFlight) return;
    encoderStatusInFlight = true;
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        encoderStatus = data?.encoder ?? null;
      }
    } catch {
      // 通信失敗時は現在の表示を維持する
    } finally {
      encoderStatusInFlight = false;
    }
    // クローズ後のdetached DOMへの適用を避ける (Issue #90 review)
    if (encoderModalClosed) return;
    applyEncoderBackendUi();
  };

  fetchEncoderStatus();
  encoderStatusTimer = setInterval(fetchEncoderStatus, 5000);

  // Issue #11: クライアント負荷プロファイル UI (標準 / 軽量(MCU2推奨) / カスタム)
  let clientProfileTouched = false;

  const readClientProfileForm = (): {
    profile: 'standard' | 'lightweight' | 'custom';
    resolutionScale?: number;
    fpsOptions?: number[];
  } => {
    const raw = (overlay.querySelector('#cfg-client-profile') as HTMLSelectElement | null)?.value;
    const profile = raw === 'lightweight' || raw === 'custom' ? raw : 'standard';
    if (profile !== 'custom') {
      return { profile };
    }
    const scale = Number(
      (overlay.querySelector('#cfg-client-scale') as HTMLSelectElement | null)?.value || 1,
    );
    const fpsOptions = [24, 30, 60].filter(
      (fps) =>
        (overlay.querySelector(`#cfg-client-fps-${fps}`) as HTMLInputElement | null)?.checked,
    );
    return { profile, resolutionScale: scale, fpsOptions };
  };

  const applyClientProfilePanel = () => {
    const raw = (overlay.querySelector('#cfg-client-profile') as HTMLSelectElement | null)?.value;
    const panelEl = overlay.querySelector('#cfg-client-custom-panel') as HTMLElement | null;
    if (panelEl) {
      panelEl.style.display = raw === 'custom' ? 'block' : 'none';
    }
  };

  const updateClientResolvedNote = () => {
    const noteEl = overlay.querySelector('#cfg-client-resolved-note') as HTMLElement | null;
    if (!noteEl) return;
    const form = readClientProfileForm();
    let scalePct = 100;
    let fps: number[] = [24, 30, 60];
    if (form.profile === 'lightweight') {
      scalePct = 65;
      fps = [24, 30];
    } else if (form.profile === 'custom') {
      scalePct = Math.round(
        (Number.isFinite(form.resolutionScale) ? form.resolutionScale! : 1) * 100,
      );
      if (form.fpsOptions && form.fpsOptions.length > 0) fps = form.fpsOptions;
    }
    noteEl.textContent = `適用時プレビュー: エンコード解像度 ${scalePct}% / HUD FPS選択肢 ${fps.join('・')}（変更は「設定を保存」で即反映されます）`;
  };

  for (const detailId of [
    'cfg-client-profile',
    'cfg-client-scale',
    'cfg-client-fps-24',
    'cfg-client-fps-30',
    'cfg-client-fps-60',
  ]) {
    overlay.querySelector(`#${detailId}`)?.addEventListener('change', () => {
      clientProfileTouched = true;
      applyClientProfilePanel();
      updateClientResolvedNote();
    });
  }
  applyClientProfilePanel();
  updateClientResolvedNote();

  const updateMetricsDisplay = async () => {
    const displayEl = overlay.querySelector('#metrics-display');
    if (!displayEl) return;

    try {
      const res = await fetch('/api/metrics/summary', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        displayEl.innerHTML = `<span style="color: var(--accent-danger);">統計データの取得に失敗しました (${res.status})</span>`;
        return;
      }
      const data = await res.json();
      if (!data || data.sampleCount === 0) {
        displayEl.innerHTML = `
          <div style="color: var(--text-muted); text-align: center; padding: 12px;">
            まだ品質測定サンプルが蓄積されていません。<br/>
            ストリーミングを開始すると約10秒ごとに自動収集されます。
          </div>
        `;
        return;
      }

      const lastUpdatedStr = data.lastUpdated
        ? new Date(data.lastUpdated).toLocaleTimeString()
        : 'N/A';
      displayEl.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 12px;">
          <div style="background: rgba(255,255,255,0.05); padding: 8px 10px; border-radius: 6px;">
            <div style="font-size: 11px; color: var(--text-muted);">描画 FPS (現在)</div>
            <div style="font-size: 18px; font-weight: 700; color: #4ade80;">${data.currentFps ?? 0} <span style="font-size: 12px; font-weight: normal;">fps</span></div>
          </div>
          <div style="background: rgba(255,255,255,0.05); padding: 8px 10px; border-radius: 6px;">
            <div style="font-size: 11px; color: var(--text-muted);">平均 / 最小 / 最大 FPS</div>
            <div style="font-size: 14px; font-weight: 600;">${data.averageFps ?? 0} / ${data.minFps ?? 0} / ${data.maxFps ?? 0}</div>
          </div>
          <div style="background: rgba(255,255,255,0.05); padding: 8px 10px; border-radius: 6px;">
            <div style="font-size: 11px; color: var(--text-muted);">RTT 往復遅延 (平均/最大)</div>
            <div style="font-size: 14px; font-weight: 600; color: #38bdf8;">${data.averageRttMs ?? 0}ms / ${data.maxRttMs ?? 0}ms</div>
          </div>
          <div style="background: rgba(255,255,255,0.05); padding: 8px 10px; border-radius: 6px;">
            <div style="font-size: 11px; color: var(--text-muted);">平均ビットレート</div>
            <div style="font-size: 14px; font-weight: 600;">${data.averageBitrateKbps ? Math.round(data.averageBitrateKbps) : 0} kbps</div>
          </div>
          <div style="background: rgba(255,255,255,0.05); padding: 8px 10px; border-radius: 6px;">
            <div style="font-size: 11px; color: var(--text-muted);">ドロップフレーム / エラー</div>
            <div style="font-size: 14px; font-weight: 600; color: ${data.totalDroppedFrames || data.totalDecoderErrors ? '#f87171' : 'inherit'};">
              ${data.totalDroppedFrames ?? 0} / ${data.totalDecoderErrors ?? 0}
            </div>
          </div>
          <div style="background: rgba(255,255,255,0.05); padding: 8px 10px; border-radius: 6px;">
            <div style="font-size: 11px; color: var(--text-muted);">音ズレ (AV Drift)</div>
            <div style="font-size: 14px; font-weight: 600;">${data.averageAvDriftMs ?? 0} ms</div>
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-muted); text-align: right;">
          サンプル数: ${data.sampleCount} (計測時間: ${data.durationSeconds}s) | 最終更新: ${lastUpdatedStr}
        </div>
      `;
    } catch (err: any) {
      displayEl.innerHTML = `<span style="color: var(--accent-danger);">通信エラー: ${err.message}</span>`;
    }
  };

  // Tab switching
  const tabs = [
    {
      btn: overlay.querySelector('#tab-browser') as HTMLElement,
      content: overlay.querySelector('#content-browser') as HTMLElement,
    },
    {
      btn: overlay.querySelector('#tab-general') as HTMLElement,
      content: overlay.querySelector('#content-general') as HTMLElement,
    },
    {
      btn: overlay.querySelector('#tab-metrics') as HTMLElement,
      content: overlay.querySelector('#content-metrics') as HTMLElement,
    },
  ];

  const switchTab = (activeIdx: number) => {
    if (metricsTimer) {
      clearInterval(metricsTimer);
      metricsTimer = null;
    }

    tabs.forEach((t, i) => {
      if (i === activeIdx) {
        t.btn.classList.add('btn-primary');
        t.btn.classList.remove('btn-secondary');
        t.content.style.display = 'block';
      } else {
        t.btn.classList.remove('btn-primary');
        t.btn.classList.add('btn-secondary');
        t.content.style.display = 'none';
      }
    });

    if (activeIdx === 2) {
      updateMetricsDisplay();
      metricsTimer = setInterval(updateMetricsDisplay, 3000);
    }
  };

  tabs.forEach((t, i) => t.btn.addEventListener('click', () => switchTab(i)));
  switchTab(0);

  // Close handler
  const closeModal = () => {
    encoderModalClosed = true;
    if (metricsTimer) {
      clearInterval(metricsTimer);
      metricsTimer = null;
    }
    if (encoderStatusTimer) {
      clearInterval(encoderStatusTimer);
      encoderStatusTimer = null;
    }
    if (clearConfirmTimer) {
      clearTimeout(clearConfirmTimer);
      clearConfirmTimer = null;
    }
    if (favResetConfirmTimer) {
      clearTimeout(favResetConfirmTimer);
      favResetConfirmTimer = null;
    }
    if (favoritesManageList) {
      clearElementChildren(favoritesManageList);
    }
    overlay.remove();
    onClose();
  };
  overlay.querySelector('#modal-close-btn')?.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  // Navigate URL
  const urlInput = overlay.querySelector('#browser-url-input') as HTMLInputElement;
  const navigateTo = async (url: string) => {
    if (!isSafeHttpUrl(url)) {
      showToast('有効な http:// または https:// のURLを入力してください', 'error');
      return;
    }
    try {
      const res = await fetch('/api/browser/navigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url }),
      });
      if (res.ok) {
        currentBrowserUrl = url;
        showToast(`URLを移動しました: ${url}`, 'success');
      } else {
        showToast(`移動失敗: HTTP ${res.status}`, 'error');
      }
    } catch (err: any) {
      showToast(`移動失敗: ${err.message}`, 'error');
    }
  };

  overlay.querySelector('#browser-url-btn')?.addEventListener('click', () => {
    if (urlInput.value.trim()) navigateTo(urlInput.value.trim());
  });

  // Favorites Management State & Handlers
  let favorites: FavoriteItem[] = DEFAULT_FAVORITES.map((f) => ({ ...f }));
  let homeFavoriteId = DEFAULT_HOME_FAVORITE_ID;
  let currentBrowserUrl = '';
  let currentBrowserTitle = '';
  let editingFavoriteId: string | null = null;
  let isSavingFavorites = false;

  const favTitleInput = overlay.querySelector('#fav-title-input') as HTMLInputElement | null;
  const favUrlInput = overlay.querySelector('#fav-url-input') as HTMLInputElement | null;
  const favAddBtn = overlay.querySelector('#fav-add-btn') as HTMLButtonElement | null;
  const favCancelEditBtn = overlay.querySelector(
    '#fav-cancel-edit-btn',
  ) as HTMLButtonElement | null;
  const favAddCurrentModalBtn = overlay.querySelector(
    '#fav-add-current-modal-btn',
  ) as HTMLButtonElement | null;
  const favResetBtn = overlay.querySelector('#fav-reset-btn') as HTMLButtonElement | null;

  const findModalElement = (rawId: string, escapedId: string): HTMLElement | null => {
    return (
      document.getElementById(rawId) ||
      document.getElementById(escapedId) ||
      (() => {
        try {
          return overlay.querySelector(`#${escapedId}`) as HTMLElement | null;
        } catch {
          return null;
        }
      })()
    );
  };

  const resetEditMode = () => {
    editingFavoriteId = null;
    if (favTitleInput) favTitleInput.value = '';
    if (favUrlInput) favUrlInput.value = '';
    if (favAddBtn) favAddBtn.innerHTML = `${ICONS.plus} 追加`;
    if (favCancelEditBtn) favCancelEditBtn.style.display = 'none';
  };

  const renderFavoritesManageList = () => {
    if (!favoritesManageList) return;
    clearElementChildren(favoritesManageList);

    if (favorites.length === 0) {
      favoritesManageList.innerHTML =
        '<div class="hud-favorites-empty">お気に入りが登録されていません。上のフォームから追加するか「初期プリセットに戻す」を押してください。</div>';
      return;
    }

    const resolvedHome = resolveHomeFavorite(favorites, homeFavoriteId);
    favoritesManageList.innerHTML = favorites
      .map((item, idx) => {
        const isHome = item.id === resolvedHome.id;
        const disableUp = idx === 0;
        const disableDown = idx === favorites.length - 1;
        const safeId = escapeHtml(item.id);
        const safeTitle = escapeHtml(item.title);
        const safeUrl = escapeHtml(item.url);
        return `
          <div class="fav-manage-row${isHome ? ' is-home' : ''}" data-favorite-id="${safeId}">
            <button id="fav-launch-${safeId}" type="button" class="fav-manage-launch" title="このページを開く (${safeUrl})">
              <span class="fav-manage-launch-title">${safeTitle}</span>
              <span class="fav-manage-launch-url">${safeUrl}</span>
            </button>
            <div class="fav-manage-controls">
              <button
                id="fav-home-${safeId}"
                type="button"
                class="fav-icon-btn${isHome ? ' is-home' : ''}"
                title="${isHome ? '現在のホーム設定' : 'ホームに設定'}"
              >
                ${ICONS.home}
              </button>
              <button
                id="fav-up-${safeId}"
                type="button"
                class="fav-icon-btn"
                title="上へ移動"
                ${disableUp ? 'disabled' : ''}
              >
                ${ICONS.arrowUp}
              </button>
              <button
                id="fav-down-${safeId}"
                type="button"
                class="fav-icon-btn"
                title="下へ移動"
                ${disableDown ? 'disabled' : ''}
              >
                ${ICONS.arrowDown}
              </button>
              <button
                id="fav-edit-${safeId}"
                type="button"
                class="fav-icon-btn"
                title="編集"
              >
                ${ICONS.edit}
              </button>
              <button
                id="fav-delete-${safeId}"
                type="button"
                class="fav-icon-btn fav-delete-btn"
                title="削除"
              >
                ${ICONS.trash}
              </button>
            </div>
          </div>
        `;
      })
      .join('');

    favorites.forEach((item, idx) => {
      const safeId = escapeHtml(item.id);

      findModalElement(`fav-launch-${item.id}`, `fav-launch-${safeId}`)?.addEventListener(
        'click',
        () => {
          if (urlInput) urlInput.value = item.url;
          navigateTo(item.url);
        },
      );

      findModalElement(`fav-home-${item.id}`, `fav-home-${safeId}`)?.addEventListener(
        'click',
        () => {
          const nextFavorites = pinHomeFavoriteFirst(favorites, item.id);
          void persistFavoritesUpdate(
            { favorites: nextFavorites, homeFavoriteId: item.id },
            `ホームを「${item.title}」に設定しました`,
          );
        },
      );

      findModalElement(`fav-up-${item.id}`, `fav-up-${safeId}`)?.addEventListener('click', () => {
        if (idx <= 0) return;
        const reordered = favorites.map((f) => ({ ...f }));
        const prev = reordered[idx - 1];
        reordered[idx - 1] = reordered[idx];
        reordered[idx] = prev;
        void persistFavoritesUpdate({ favorites: reordered }, '並び順を更新しました');
      });

      findModalElement(`fav-down-${item.id}`, `fav-down-${safeId}`)?.addEventListener(
        'click',
        () => {
          if (idx >= favorites.length - 1) return;
          const reordered = favorites.map((f) => ({ ...f }));
          const next = reordered[idx + 1];
          reordered[idx + 1] = reordered[idx];
          reordered[idx] = next;
          void persistFavoritesUpdate({ favorites: reordered }, '並び順を更新しました');
        },
      );

      findModalElement(`fav-edit-${item.id}`, `fav-edit-${safeId}`)?.addEventListener(
        'click',
        () => {
          editingFavoriteId = item.id;
          if (favTitleInput) favTitleInput.value = item.title;
          if (favUrlInput) favUrlInput.value = item.url;
          if (favAddBtn) favAddBtn.innerHTML = `${ICONS.check} 保存`;
          if (favCancelEditBtn) favCancelEditBtn.style.display = 'inline-flex';
          favTitleInput?.focus?.();
        },
      );

      findModalElement(`fav-delete-${item.id}`, `fav-delete-${safeId}`)?.addEventListener(
        'click',
        () => {
          const remaining = favorites.filter((f) => f.id !== item.id);
          const nextHomeId =
            homeFavoriteId === item.id
              ? remaining[0]?.id || DEFAULT_HOME_FAVORITE_ID
              : homeFavoriteId;
          if (editingFavoriteId === item.id) {
            resetEditMode();
          }
          void persistFavoritesUpdate(
            { favorites: remaining, homeFavoriteId: nextHomeId },
            `「${item.title}」を削除しました`,
          );
        },
      );
    });
  };

  const persistFavoritesUpdate = async (
    payload: {
      favorites?: FavoriteItem[];
      homeFavoriteId?: string;
      resetFavorites?: boolean;
    },
    successMessage: string,
  ): Promise<boolean> => {
    if (isSavingFavorites) return false;
    isSavingFavorites = true;
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        showToast(errData?.error || `保存に失敗しました (HTTP ${res.status})`, 'error');
        return false;
      }
      const data = await res.json().catch(() => null);
      const returnedFavorites = sanitizeFavorites(data?.settings?.favorites);
      if (returnedFavorites !== null) {
        favorites = returnedFavorites;
      } else if (payload.resetFavorites) {
        favorites = DEFAULT_FAVORITES.map((f) => ({ ...f }));
      } else if (payload.favorites !== undefined) {
        favorites = payload.favorites.map((f) => ({ ...f }));
      }

      if (
        typeof data?.settings?.homeFavoriteId === 'string' &&
        data.settings.homeFavoriteId.trim()
      ) {
        homeFavoriteId = data.settings.homeFavoriteId.trim();
      } else if (payload.resetFavorites) {
        homeFavoriteId = DEFAULT_HOME_FAVORITE_ID;
      } else if (payload.homeFavoriteId !== undefined) {
        homeFavoriteId = payload.homeFavoriteId;
      }

      if (favorites.length > 0 && !favorites.some((f) => f.id === homeFavoriteId)) {
        homeFavoriteId = favorites[0].id;
      }

      renderFavoritesManageList();
      window.dispatchEvent(
        new CustomEvent('tesroid:settings-updated', {
          detail: { favorites: favorites.map((f) => ({ ...f })), homeFavoriteId },
        }),
      );
      showToast(successMessage, 'success');
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '通信失敗';
      showToast(`保存エラー: ${msg}`, 'error');
      return false;
    } finally {
      isSavingFavorites = false;
    }
  };

  favAddBtn?.addEventListener('click', async () => {
    const title = favTitleInput?.value?.trim() || '';
    const url = favUrlInput?.value?.trim() || '';
    if (!title) {
      showToast('表示タイトルを入力してください', 'error');
      return;
    }
    if (!isSafeHttpUrl(url)) {
      showToast('有効な http:// または https:// のURLを入力してください', 'error');
      return;
    }

    if (editingFavoriteId) {
      const nextFavorites = favorites.map((f) =>
        f.id === editingFavoriteId ? { ...f, title, url } : f,
      );
      const saved = await persistFavoritesUpdate(
        { favorites: nextFavorites },
        `「${title}」を更新しました`,
      );
      if (saved) {
        resetEditMode();
      }
      return;
    }

    if (favorites.length >= 100) {
      showToast('お気に入りは最大100件まで登録できます', 'error');
      return;
    }

    let newId = `fav-${Date.now()}`;
    let suffix = 1;
    while (favorites.some((f) => f.id === newId)) {
      newId = `fav-${Date.now()}-${suffix++}`;
    }
    const nextFavorites = insertFavoritePreservingHome(
      favorites,
      { id: newId, title, url },
      homeFavoriteId,
    );
    const saved = await persistFavoritesUpdate(
      { favorites: nextFavorites },
      `お気に入りに追加しました: ${title}`,
    );
    if (saved) {
      resetEditMode();
    }
  });

  favCancelEditBtn?.addEventListener('click', () => {
    resetEditMode();
  });

  favAddCurrentModalBtn?.addEventListener('click', async () => {
    let targetUrl = currentBrowserUrl;
    let targetTitle = currentBrowserTitle;
    if (!isSafeHttpUrl(targetUrl)) {
      try {
        const statusRes = await fetch('/api/browser/status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (statusRes.ok) {
          const statusData = await statusRes.json();
          if (typeof statusData?.url === 'string' && isSafeHttpUrl(statusData.url)) {
            targetUrl = statusData.url;
            currentBrowserUrl = targetUrl;
          }
          if (typeof statusData?.title === 'string') {
            targetTitle = statusData.title;
            currentBrowserTitle = targetTitle;
          }
        }
      } catch {}
    }

    if (!isSafeHttpUrl(targetUrl)) {
      showToast('現在のブラウザURLを取得できませんでした', 'error');
      return;
    }
    if (favorites.some((f) => f.url === targetUrl)) {
      showToast('このページは既にお気に入りに登録されています', 'info');
      return;
    }
    if (favorites.length >= 100) {
      showToast('お気に入りは最大100件まで登録できます', 'error');
      return;
    }

    let host = targetUrl;
    try {
      host = new URL(targetUrl).hostname;
    } catch {}
    let newId = `fav-${Date.now()}`;
    let suffix = 1;
    while (favorites.some((f) => f.id === newId)) {
      newId = `fav-${Date.now()}-${suffix++}`;
    }
    const newFav: FavoriteItem = {
      id: newId,
      title: targetTitle.trim() || host,
      url: targetUrl,
    };
    await persistFavoritesUpdate(
      { favorites: insertFavoritePreservingHome(favorites, newFav, homeFavoriteId) },
      `お気に入りに追加しました: ${newFav.title}`,
    );
  });

  let isFavResetConfirmPending = false;
  const resetFavResetConfirm = () => {
    isFavResetConfirmPending = false;
    if (favResetConfirmTimer) {
      clearTimeout(favResetConfirmTimer);
      favResetConfirmTimer = null;
    }
    if (favResetBtn) {
      favResetBtn.innerHTML = `${ICONS.refresh} 初期プリセットに戻す`;
      favResetBtn.style.borderColor = '';
      favResetBtn.style.background = '';
    }
  };

  favResetBtn?.addEventListener('click', async () => {
    if (!isFavResetConfirmPending) {
      isFavResetConfirmPending = true;
      favResetBtn.innerHTML = `${ICONS.refresh} もう一度タップで初期化を実行`;
      favResetBtn.style.borderColor = '#f87171';
      favResetBtn.style.background = 'rgba(248, 113, 113, 0.15)';
      showToast('もう一度タップすると初期プリセットに戻ります（5秒後にキャンセル）', 'info');
      favResetConfirmTimer = setTimeout(() => {
        resetFavResetConfirm();
      }, 5000);
      return;
    }

    resetFavResetConfirm();
    resetEditMode();
    await persistFavoritesUpdate(
      { resetFavorites: true },
      'お気に入りを初期プリセットに戻しました',
    );
  });

  renderFavoritesManageList();

  // Load current settings
  const savedLocalScale = localStorage.getItem('tesroid_display_scale');
  if (savedLocalScale && overlay.querySelector('#cfg-display-scale')) {
    (overlay.querySelector('#cfg-display-scale') as HTMLSelectElement).value = savedLocalScale;
  }

  const savedBufferDepth = localStorage.getItem('tesroid_prefetch_buffer_ms') || '10000';
  const bufferDepthSelect = overlay.querySelector('#cfg-buffer-depth') as HTMLSelectElement | null;
  if (bufferDepthSelect) {
    bufferDepthSelect.value = savedBufferDepth;
    if (bufferDepthSelect.value !== savedBufferDepth) {
      bufferDepthSelect.value = '10000';
    }
  }

  const savedAudioBitrate = localStorage.getItem('tesroid_audio_bitrate') || '128000';
  if (overlay.querySelector('#cfg-audio-bitrate')) {
    (overlay.querySelector('#cfg-audio-bitrate') as HTMLSelectElement).value = savedAudioBitrate;
  }

  // Developer Telemetry options handler
  const telemetryToggle = overlay.querySelector('#cfg-telemetry-toggle') as HTMLInputElement | null;
  if (telemetryToggle) {
    const savedTelemetry = localStorage.getItem('tesroid_detailed_telemetry');
    telemetryToggle.checked = savedTelemetry === 'true' || savedTelemetry === '1';
    telemetryToggle.addEventListener('change', () => {
      const isChecked = telemetryToggle.checked;
      localStorage.setItem('tesroid_detailed_telemetry', isChecked ? 'true' : 'false');
      window.dispatchEvent(
        new CustomEvent('tesroid:settings-updated', {
          detail: { telemetryEnabled: isChecked },
        }),
      );
      showToast(
        isChecked
          ? '詳細テレメトリ収集を有効化しました (ON)'
          : '詳細テレメトリ収集を停止しました (OFF: 負荷低減)',
        'info',
      );
    });
  }

  const clearBtn = overlay.querySelector('#cfg-telemetry-clear-btn') as HTMLButtonElement | null;
  let isClearConfirmPending = false;
  const resetClearConfirm = () => {
    isClearConfirmPending = false;
    if (clearConfirmTimer) {
      clearTimeout(clearConfirmTimer);
      clearConfirmTimer = null;
    }
    if (clearBtn) {
      clearBtn.innerHTML = `${ICONS.trash} サーバーログ全消去`;
      clearBtn.style.borderColor = '';
      clearBtn.style.background = '';
    }
  };

  clearBtn?.addEventListener('click', async () => {
    const msgEl = overlay.querySelector('#telemetry-action-msg') as HTMLElement;
    if (!isClearConfirmPending) {
      isClearConfirmPending = true;
      clearBtn.innerHTML = `${ICONS.trash} もう一度タップで全消去を実行`;
      clearBtn.style.borderColor = '#f87171';
      clearBtn.style.background = 'rgba(248, 113, 113, 0.15)';
      if (msgEl) {
        msgEl.innerHTML =
          '<span style="color: #fbbf24;">本当にサーバー上の全セッションログを消去しますか？（5秒後にキャンセル）</span>';
      }
      clearConfirmTimer = setTimeout(() => {
        resetClearConfirm();
        if (msgEl) msgEl.textContent = '';
      }, 5000);
      return;
    }

    resetClearConfirm();
    try {
      const res = await fetch('/api/telemetry/sessions', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        if (msgEl)
          msgEl.innerHTML =
            '<span style="color: #4ade80;">すべてのセッションログを消去しました。</span>';
        showToast('セッションログを消去しました', 'info');
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err: any) {
      if (msgEl)
        msgEl.innerHTML = `<span style="color: var(--accent-danger);">消去失敗: ${err.message}</span>`;
    }
  });

  let initialLocale = 'ja-JP';

  // Manual browser restart button
  overlay.querySelector('#cfg-restart-browser-btn')?.addEventListener('click', async () => {
    try {
      showToast('ブラウザを再起動しています...', 'info');
      const res = await fetch('/api/browser/restart', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        showToast('ブラウザを再起動しました（新しい言語が適用されます）', 'success');
      } else {
        showToast(`再起動失敗: HTTP ${res.status}`, 'error');
      }
    } catch (err: any) {
      showToast(`再起動エラー: ${err.message}`, 'error');
    }
  });

  try {
    const res = await fetch('/api/settings', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.browserUrl) {
        urlInput.value = data.browserUrl;
        if (isSafeHttpUrl(data.browserUrl)) {
          currentBrowserUrl = data.browserUrl;
        }
      }
      if (typeof data.browserTitle === 'string') {
        currentBrowserTitle = data.browserTitle;
      }
      const fetchedFavorites = sanitizeFavorites(data.favorites);
      if (fetchedFavorites !== null) {
        favorites = fetchedFavorites;
      }
      if (typeof data.homeFavoriteId === 'string' && data.homeFavoriteId.trim()) {
        homeFavoriteId = data.homeFavoriteId.trim();
      }
      renderFavoritesManageList();
      if (data.displayScale) {
        (overlay.querySelector('#cfg-display-scale') as HTMLSelectElement).value = String(
          data.displayScale,
        );
        localStorage.setItem('tesroid_display_scale', String(data.displayScale));
      }
      if (data.locale && overlay.querySelector('#cfg-locale')) {
        initialLocale = data.locale;
        (overlay.querySelector('#cfg-locale') as HTMLSelectElement).value = data.locale;
      }
      if (data.stream?.audioBitrate && overlay.querySelector('#cfg-audio-bitrate')) {
        (overlay.querySelector('#cfg-audio-bitrate') as HTMLSelectElement).value = String(
          data.stream.audioBitrate,
        );
        localStorage.setItem('tesroid_audio_bitrate', String(data.stream.audioBitrate));
      }
      if (data.stream) {
        const presetEl = overlay.querySelector('#cfg-perf-preset') as HTMLSelectElement | null;
        const customPanelEl = overlay.querySelector('#cfg-perf-custom-panel') as HTMLElement | null;
        const maxSizeEl = overlay.querySelector('#cfg-max-size') as HTMLSelectElement | null;
        const compEl = overlay.querySelector('#cfg-vaapi-compression') as HTMLSelectElement | null;
        const gpuCscEl = overlay.querySelector('#cfg-vaapi-gpu-csc') as HTMLInputElement | null;
        const lowPowerEl = overlay.querySelector('#cfg-vaapi-low-power') as HTMLInputElement | null;
        if (typeof data.stream.performancePreset === 'string') {
          savedPerformancePreset = data.stream.performancePreset;
        }
        if (presetEl && data.stream.performancePreset) {
          presetEl.value = data.stream.performancePreset;
        }
        if (customPanelEl) {
          customPanelEl.style.display =
            data.stream.performancePreset === 'custom' ? 'block' : 'none';
        }
        if (maxSizeEl && data.stream.maxSize) {
          const savedMaxSize = String(data.stream.maxSize);
          // 旧バージョンで保存された任意値 (グリッド外) は「現在の保存値」として明示し、
          // ユーザーが変更するまで実値を保持する (セレクト化に伴う非破壊反映)
          const optionEls = maxSizeEl.options ? Array.from(maxSizeEl.options) : [];
          if (optionEls.length > 0 && !optionEls.some((o) => o.value === savedMaxSize)) {
            const legacyOption = document.createElement('option');
            legacyOption.value = savedMaxSize;
            legacyOption.textContent = `${savedMaxSize}px (現在の保存値)`;
            maxSizeEl.appendChild(legacyOption);
          }
          maxSizeEl.value = savedMaxSize;
        }
        if (compEl && data.stream.vaapiCompressionLevel) {
          compEl.value = String(data.stream.vaapiCompressionLevel);
        }
        if (gpuCscEl && data.stream.vaapiGpuColorConversion !== undefined) {
          gpuCscEl.checked = Boolean(data.stream.vaapiGpuColorConversion);
        }
        if (lowPowerEl && data.stream.vaapiLowPower !== undefined) {
          lowPowerEl.checked = Boolean(data.stream.vaapiLowPower);
        }
        // Issue #11: クライアント負荷プロファイルの保存値反映
        const clientProfileSaved = data.stream.clientProfile;
        if (clientProfileSaved && typeof clientProfileSaved.profile === 'string') {
          const profileEl = overlay.querySelector(
            '#cfg-client-profile',
          ) as HTMLSelectElement | null;
          if (profileEl) {
            profileEl.value = clientProfileSaved.profile;
          }
          if (clientProfileSaved.profile === 'custom' && data.clientProfileResolved) {
            const scaleEl = overlay.querySelector('#cfg-client-scale') as HTMLSelectElement | null;
            if (scaleEl) {
              const targetScale = String(data.clientProfileResolved.resolutionScale);
              // 選択肢外の保存値 (API経由等) も「現在の保存値」として明示し非破壊保持 (cfg-max-size と同一方針)
              const scaleOptionEls = scaleEl.options ? Array.from(scaleEl.options) : [];
              if (
                scaleOptionEls.length > 0 &&
                !scaleOptionEls.some((o) => o.value === targetScale)
              ) {
                const legacyOption = document.createElement('option');
                legacyOption.value = targetScale;
                legacyOption.textContent = `${Math.round(Number(targetScale) * 100)}% (現在の保存値)`;
                scaleEl.appendChild(legacyOption);
              }
              scaleEl.value = targetScale;
            }
            for (const fps of [24, 30, 60]) {
              const cb = overlay.querySelector(`#cfg-client-fps-${fps}`) as HTMLInputElement | null;
              if (cb) {
                cb.checked = Array.isArray(data.clientProfileResolved.fpsOptions)
                  ? data.clientProfileResolved.fpsOptions.includes(fps)
                  : false;
              }
            }
          }
        }
        applyClientProfilePanel();
        updateClientResolvedNote();
        // 読み込んだ保存値と現在のバックエンド状態を突き合わせてUIを整合させる (Issue #90)
        applyEncoderBackendUi();
      }
    }
  } catch {}

  overlay.querySelector('#cfg-perf-preset')?.addEventListener('change', (e) => {
    presetTouched = true;
    const preset = (e.target as HTMLSelectElement).value;
    const customPanelEl = overlay.querySelector('#cfg-perf-custom-panel') as HTMLElement | null;
    const maxSizeEl = overlay.querySelector('#cfg-max-size') as HTMLSelectElement | null;
    const compEl = overlay.querySelector('#cfg-vaapi-compression') as HTMLSelectElement | null;
    const gpuCscEl = overlay.querySelector('#cfg-vaapi-gpu-csc') as HTMLInputElement | null;
    const lowPowerEl = overlay.querySelector('#cfg-vaapi-low-power') as HTMLInputElement | null;

    if (customPanelEl) {
      customPanelEl.style.display = preset === 'custom' ? 'block' : 'none';
    }

    if (preset === 'high') {
      if (maxSizeEl) maxSizeEl.value = '1920';
      if (compEl) compEl.value = '4';
      if (gpuCscEl) gpuCscEl.checked = true;
      if (lowPowerEl) lowPowerEl.checked = false;
    } else if (preset === 'balanced') {
      if (maxSizeEl) maxSizeEl.value = '1280';
      if (compEl) compEl.value = '7';
      if (gpuCscEl) gpuCscEl.checked = true;
      if (lowPowerEl) lowPowerEl.checked = false;
    } else if (preset === 'low_power') {
      if (maxSizeEl) maxSizeEl.value = '960';
      if (compEl) compEl.value = '7';
      if (gpuCscEl) gpuCscEl.checked = true;
      if (lowPowerEl) lowPowerEl.checked = false;
    } else if (preset === 'cpu_balanced' || preset === 'cpu_low_power') {
      // CPUプリセットはVAAPI設定を一切変更しない（libx264側の値はサーバー側定義で適用） (Issue #90)
      if (maxSizeEl) maxSizeEl.value = preset === 'cpu_balanced' ? '1280' : '960';
    }
  });

  // 詳細値を直接編集したら、プリセット選択も即座に 'custom' へ切り替える。
  // プリセット名だけ balanced のまま値だけ乖離する曖昧状態を防ぐ (Issue #90 review)。
  // ※ 表示上の 'custom' 展開を触っただけ（未編集）の場合は presetTouched が立たないため、
  //   保存時に保存済みプリセット名がそのまま送信され、誤った custom 永続化は起きない。
  const markCustomTouched = () => {
    const presetSelectEl = overlay.querySelector('#cfg-perf-preset') as HTMLSelectElement | null;
    if (presetSelectEl && presetSelectEl.value !== 'custom') {
      presetSelectEl.value = 'custom';
      const customPanelEl = overlay.querySelector('#cfg-perf-custom-panel') as HTMLElement | null;
      if (customPanelEl) {
        customPanelEl.style.display = 'block';
      }
    }
    presetTouched = true;
  };
  for (const detailId of [
    'cfg-max-size',
    'cfg-vaapi-compression',
    'cfg-vaapi-gpu-csc',
    'cfg-vaapi-low-power',
  ]) {
    overlay.querySelector(`#${detailId}`)?.addEventListener('change', markCustomTouched);
  }

  const cfgPinInput = overlay.querySelector('#cfg-pin') as HTMLInputElement | null;
  const cfgPinErrorEl = overlay.querySelector('#cfg-pin-error') as HTMLElement | null;
  bindPinInputValidation(cfgPinInput, cfgPinErrorEl);

  // Save settings
  overlay.querySelector('#cfg-save-btn')?.addEventListener('click', async () => {
    const newPin = cfgPinInput?.value ?? '';
    const pinError = validatePinInput(newPin, { allowEmpty: true });
    if (pinError) {
      setPinFieldError(cfgPinInput, cfgPinErrorEl, pinError);
      showToast(pinError, 'error');
      cfgPinInput?.focus?.();
      return;
    }
    setPinFieldError(cfgPinInput, cfgPinErrorEl, null);
    const displayScale = Number(
      (overlay.querySelector('#cfg-display-scale') as HTMLSelectElement)?.value || 120,
    );
    const rawBufferDepth = Number(
      (overlay.querySelector('#cfg-buffer-depth') as HTMLSelectElement)?.value ?? 10000,
    );
    const bufferDepth = Number.isFinite(rawBufferDepth)
      ? Math.max(0, Math.min(30000, Math.round(rawBufferDepth)))
      : 10000;
    const audioBitrate = Number(
      (overlay.querySelector('#cfg-audio-bitrate') as HTMLSelectElement)?.value || 128000,
    );
    const presetSelectValue =
      (overlay.querySelector('#cfg-perf-preset') as HTMLSelectElement)?.value || 'balanced';
    // 未操作時はサーバー保存値をそのまま送信する（バックエンド非対応で表示上 'custom' 相当に
    // 開いているだけの状態が、誤って 'custom' として永続化されるのを防ぐ）(Issue #90)
    const performancePreset =
      !presetTouched && savedPerformancePreset ? savedPerformancePreset : presetSelectValue;
    const maxSize = Number(
      (overlay.querySelector('#cfg-max-size') as HTMLSelectElement)?.value || 1280,
    );
    const vaapiCompressionLevel = Number(
      (overlay.querySelector('#cfg-vaapi-compression') as HTMLSelectElement)?.value || 7,
    );
    const vaapiGpuColorConversion = Boolean(
      (overlay.querySelector('#cfg-vaapi-gpu-csc') as HTMLInputElement)?.checked,
    );
    const vaapiLowPower = Boolean(
      (overlay.querySelector('#cfg-vaapi-low-power') as HTMLInputElement)?.checked,
    );
    const locale = (overlay.querySelector('#cfg-locale') as HTMLSelectElement)?.value;

    // Issue #11: クライアント負荷プロファイル (操作した場合のみ送信し、未操作時は保存値を維持)
    let clientProfilePayload:
      | { profile: string; resolutionScale?: number; fpsOptions?: number[] }
      | undefined;
    if (clientProfileTouched) {
      const form = readClientProfileForm();
      clientProfilePayload =
        form.profile === 'custom'
          ? {
              profile: 'custom',
              resolutionScale: form.resolutionScale,
              fpsOptions: form.fpsOptions,
            }
          : { profile: form.profile };
    }

    interface SettingsUpdatePayload {
      displayScale: number;
      stream: {
        audioBitrate: number;
        performancePreset: string;
        maxSize: number;
        vaapiCompressionLevel: number;
        vaapiLowPower: boolean;
        vaapiGpuColorConversion: boolean;
        clientProfile?: { profile: string; resolutionScale?: number; fpsOptions?: number[] };
      };
      pin?: string;
      locale?: string;
    }

    const body: SettingsUpdatePayload = {
      displayScale,
      stream: {
        audioBitrate,
        performancePreset,
        maxSize,
        vaapiCompressionLevel,
        vaapiLowPower,
        vaapiGpuColorConversion,
      },
    };
    if (clientProfilePayload) body.stream.clientProfile = clientProfilePayload;
    if (newPin) body.pin = newPin;
    if (locale) body.locale = locale;

    localStorage.setItem('tesroid_display_scale', String(displayScale));
    localStorage.setItem('tesroid_prefetch_buffer_ms', String(bufferDepth));
    localStorage.setItem('tesroid_audio_bitrate', String(audioBitrate));

    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        if (newPin && cfgPinInput) {
          cfgPinInput.value = '';
        }
        window.dispatchEvent(
          new CustomEvent('tesroid:settings-updated', {
            detail: { displayScale, bufferDepth, audioBitrate, stream: body.stream },
          }),
        );
        if (initialLocale && locale && locale !== initialLocale) {
          showToast('設定を保存しました。ブラウザを再起動して言語を反映中...', 'info');
          try {
            const restartRes = await fetch('/api/browser/restart', {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
            });
            if (restartRes.ok) {
              initialLocale = locale;
              showToast('ブラウザを再起動し、新しい言語を適用しました。', 'success');
            } else {
              showToast(
                `設定は保存されましたが、ブラウザ再起動に失敗しました (HTTP ${restartRes.status})。手動で再起動してください。`,
                'error',
              );
            }
          } catch {
            showToast('設定を保存しました（次回ブラウザ起動時に反映されます）。', 'success');
          }
        } else {
          showToast('設定を保存しました。', 'success');
        }
      } else {
        const errData = await res.json().catch(() => null);
        showToast(errData?.error || '保存に失敗しました。', 'error');
      }
    } catch (err: any) {
      showToast(`エラー: ${err.message}`, 'error');
    }
  });
}
