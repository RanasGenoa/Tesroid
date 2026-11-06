import { ICONS, showToast } from './icons.js';

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

        <div style="display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap;">
          <button class="btn btn-secondary quick-url-btn" data-url="https://www.youtube.com">YouTube</button>
          <button class="btn btn-secondary quick-url-btn" data-url="https://tver.jp">TVer</button>
          <button class="btn btn-secondary quick-url-btn" data-url="https://www.netflix.com">Netflix</button>
          <button class="btn btn-secondary quick-url-btn" data-url="https://www.amazon.co.jp/primevideo">Prime Video</button>
        </div>
      </div>

      <!-- Tab Content: General & PIN -->
      <div id="content-general" style="display: none;">
        <label style="display: block; font-size: 14px; margin-bottom: 6px;">新しいPINコード (4〜8桁 / 空欄で維持)</label>
        <input type="password" id="cfg-pin" placeholder="変更する場合のみ入力" maxlength="8" />

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
        <p style="font-size: 11px; color: var(--text-muted); margin-top: 4px; margin-bottom: 0;">※ 言語の変更は次回ブラウザ起動時または再起動時に反映されます。</p>

        <label style="display: block; font-size: 14px; margin-bottom: 6px; margin-top: 12px;">先行バッファ深度 (回線瞬断・トンネル対策 / メモリ調整)</label>
        <select id="cfg-buffer-depth">
          <option value="0">オフ (0.1秒 / 超低遅延優先)</option>
          <option value="2000">軽量 2秒 (Intel / MCU2車両向け・省メモリ約280KB)</option>
          <option value="5000">標準 5秒 (市街地走行向け・メモリ約700KB)</option>
          <option value="10000" selected>最大 10秒 (長大トンネル・耐障害最優先 / Ryzen推奨)</option>
        </select>

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
    if (metricsTimer) {
      clearInterval(metricsTimer);
      metricsTimer = null;
    }
    if (clearConfirmTimer) {
      clearTimeout(clearConfirmTimer);
      clearConfirmTimer = null;
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
    try {
      const res = await fetch('/api/browser/navigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url }),
      });
      if (res.ok) {
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

  overlay.querySelectorAll('.quick-url-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const url = btn.getAttribute('data-url');
      if (url) {
        urlInput.value = url;
        navigateTo(url);
      }
    });
  });

  // Load current settings
  const savedLocalScale = localStorage.getItem('tesroid_display_scale');
  if (savedLocalScale && overlay.querySelector('#cfg-display-scale')) {
    (overlay.querySelector('#cfg-display-scale') as HTMLSelectElement).value = savedLocalScale;
  }

  const savedBufferDepth = localStorage.getItem('tesroid_prefetch_buffer_ms') || '10000';
  if (overlay.querySelector('#cfg-buffer-depth')) {
    (overlay.querySelector('#cfg-buffer-depth') as HTMLSelectElement).value = savedBufferDepth;
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

  try {
    const res = await fetch('/api/settings', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.browserUrl) urlInput.value = data.browserUrl;
      if (data.displayScale) {
        (overlay.querySelector('#cfg-display-scale') as HTMLSelectElement).value = String(
          data.displayScale,
        );
        localStorage.setItem('tesroid_display_scale', String(data.displayScale));
      }
      if (data.locale && overlay.querySelector('#cfg-locale')) {
        (overlay.querySelector('#cfg-locale') as HTMLSelectElement).value = data.locale;
      }
    }
  } catch {}

  // Save settings
  overlay.querySelector('#cfg-save-btn')?.addEventListener('click', async () => {
    const newPin = (overlay.querySelector('#cfg-pin') as HTMLInputElement).value.trim();
    const displayScale = Number(
      (overlay.querySelector('#cfg-display-scale') as HTMLSelectElement)?.value || 120,
    );
    const bufferDepth = Number(
      (overlay.querySelector('#cfg-buffer-depth') as HTMLSelectElement)?.value ?? 10000,
    );
    const locale = (overlay.querySelector('#cfg-locale') as HTMLSelectElement)?.value;

    const body: any = {
      displayScale,
    };
    if (newPin) body.pin = newPin;
    if (locale) body.locale = locale;

    localStorage.setItem('tesroid_display_scale', String(displayScale));
    localStorage.setItem('tesroid_prefetch_buffer_ms', String(bufferDepth));

    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        window.dispatchEvent(
          new CustomEvent('tesroid:settings-updated', {
            detail: { displayScale, bufferDepth },
          }),
        );
        showToast('設定を保存しました。', 'success');
      } else {
        showToast('保存に失敗しました。', 'error');
      }
    } catch (err: any) {
      showToast(`エラー: ${err.message}`, 'error');
    }
  });
}
