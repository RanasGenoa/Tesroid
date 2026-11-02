import { ICONS, showToast } from './icons.js';
import { sleep, resume, encoderRestart, browserRestart } from './power-actions.js';

export function openSettingsWithAuth(
  container: HTMLElement,
  authToken: string | null,
  onRequireAuth: (callback: (token: string) => void) => void,
  onClose: () => void
): void {
  if (authToken) {
    showSettingsModal(container, authToken, onClose);
  } else {
    onRequireAuth((token: string) => {
      showSettingsModal(container, token, onClose);
    });
  }
}

async function showSettingsModal(container: HTMLElement, token: string, onClose: () => void): Promise<void> {
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
          ${ICONS.globe} ブラウザ & 電源
        </button>
        <button id="tab-general" class="btn btn-secondary" style="padding: 8px 14px; font-size: 13px; display: flex; align-items: center; gap: 6px;">
          ${ICONS.settings} ストリーミング & PIN
        </button>
        <button id="tab-metrics" class="btn btn-secondary" style="padding: 8px 14px; font-size: 13px; display: flex; align-items: center; gap: 6px;">
          ${ICONS.activity} 品質統計
        </button>
      </div>

      <!-- Tab Content: Browser & Power -->
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

        <hr style="border: 0; border-top: 1px solid var(--border-color); margin: 20px 0;" />

        <h3 style="font-size: 15px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
          ${ICONS.power} 省電力 & リソース制御
        </h3>
        <p style="font-size: 13px; margin-bottom: 12px; color: var(--text-muted);">車を離れる際や一時停止時にCPU/GPU負荷を0%に凍結します。</p>
        <div style="display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap;">
          <button id="power-sleep-btn" class="btn btn-secondary" style="flex: 1; min-width: 140px; display: flex; align-items: center; justify-content: center; gap: 6px;">
            ${ICONS.pause} 一時停止 (CPU 0%)
          </button>
          <button id="power-resume-btn" class="btn btn-primary" style="flex: 1; min-width: 140px; display: flex; align-items: center; justify-content: center; gap: 6px;">
            ${ICONS.play} 再開 (Resume)
          </button>
          <button id="encoder-restart-btn" class="btn btn-secondary" style="flex: 1; min-width: 140px; display: flex; align-items: center; justify-content: center; gap: 6px;" title="通信瞬断等による映像ノイズを修復するために動画エンコーダを再起動します">
            ${ICONS.zap} 再エンコード
          </button>
          <button id="browser-restart-btn" class="btn btn-danger" style="flex: 1; min-width: 140px; display: flex; align-items: center; justify-content: center; gap: 6px;">
            ${ICONS.refresh} ブラウザ再起動
          </button>
        </div>

        <hr style="border: 0; border-top: 1px solid var(--border-color); margin: 20px 0;" />

        <h3 style="font-size: 15px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
          ${ICONS.volume2} 音声テスト
        </h3>
        <p style="font-size: 13px; margin-bottom: 12px; color: var(--text-muted);">PulseAudio仮想シンク経由でテスト音を鳴らし、音声出力を確認します。</p>
        <button id="audio-test-btn" class="btn btn-secondary" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;">
          ${ICONS.volume2} テストトーン再生 (1秒)
        </button>
      </div>

      <!-- Tab Content: General & PIN -->
      <div id="content-general" style="display: none;">
        <label style="display: block; font-size: 14px; margin-bottom: 6px;">新しいPINコード (4〜8桁 / 空欄で維持)</label>
        <input type="password" id="cfg-pin" placeholder="変更する場合のみ入力" maxlength="8" />

        <label style="display: block; font-size: 14px; margin-bottom: 6px; margin-top: 12px;">ストリーミング ビットレート</label>
        <select id="cfg-bitrate">
          <option value="500000">0.5 Mbps (超節約 / 低速回線)</option>
          <option value="750000">0.75 Mbps (節約)</option>
          <option value="1000000" selected>1 Mbps (標準・推奨)</option>
          <option value="1500000">1.5 Mbps (高画質)</option>
          <option value="2000000">2 Mbps (超高画質)</option>
        </select>

        <label style="display: block; font-size: 14px; margin-bottom: 6px; margin-top: 12px;">フレームレート (FPS)</label>
        <select id="cfg-fps">
          <option value="30" selected>30 FPS (省負荷・高安定性)</option>
          <option value="60">60 FPS (高滑らか・高負荷)</option>
        </select>

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
      </div>
    </div>
  `;

  container.appendChild(overlay);

  // Metrics polling timer
  let metricsTimer: any = null;

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

      const lastUpdatedStr = data.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : 'N/A';
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
            <div style="font-size: 14px; font-weight: 600; color: ${(data.totalDroppedFrames || data.totalDecoderErrors) ? '#f87171' : 'inherit'};">
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
    { btn: overlay.querySelector('#tab-browser') as HTMLElement, content: overlay.querySelector('#content-browser') as HTMLElement },
    { btn: overlay.querySelector('#tab-general') as HTMLElement, content: overlay.querySelector('#content-general') as HTMLElement },
    { btn: overlay.querySelector('#tab-metrics') as HTMLElement, content: overlay.querySelector('#content-metrics') as HTMLElement },
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

  // Power actions
  overlay.querySelector('#power-sleep-btn')?.addEventListener('click', () => {
    sleep(token);
  });

  overlay.querySelector('#power-resume-btn')?.addEventListener('click', () => {
    resume(token);
  });

  overlay.querySelector('#encoder-restart-btn')?.addEventListener('click', () => {
    encoderRestart(token);
  });

  overlay.querySelector('#browser-restart-btn')?.addEventListener('click', () => {
    browserRestart(token);
  });

  // Audio test
  overlay.querySelector('#audio-test-btn')?.addEventListener('click', async () => {
    try {
      await fetch('/api/audio/test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      showToast('テストトーンを送信しました', 'info');
    } catch (err: any) {
      showToast(`テスト音声再生失敗: ${err.message}`, 'error');
    }
  });

  // Load current settings
  const savedLocalScale = localStorage.getItem('tesroid_display_scale');
  if (savedLocalScale && overlay.querySelector('#cfg-display-scale')) {
    (overlay.querySelector('#cfg-display-scale') as HTMLSelectElement).value = savedLocalScale;
  }

  try {
    const res = await fetch('/api/settings', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.browserUrl) urlInput.value = data.browserUrl;
      if (data.stream?.bitrate) (overlay.querySelector('#cfg-bitrate') as HTMLSelectElement).value = String(data.stream.bitrate);
      if (data.stream?.maxFps) (overlay.querySelector('#cfg-fps') as HTMLSelectElement).value = String(data.stream.maxFps);
      if (data.displayScale) {
        (overlay.querySelector('#cfg-display-scale') as HTMLSelectElement).value = String(data.displayScale);
        localStorage.setItem('tesroid_display_scale', String(data.displayScale));
      }
    }
  } catch {}

  // Save settings
  overlay.querySelector('#cfg-save-btn')?.addEventListener('click', async () => {
    const newPin = (overlay.querySelector('#cfg-pin') as HTMLInputElement).value.trim();
    const bitrate = Number((overlay.querySelector('#cfg-bitrate') as HTMLSelectElement).value);
    const maxFps = Number((overlay.querySelector('#cfg-fps') as HTMLSelectElement).value);
    const displayScale = Number((overlay.querySelector('#cfg-display-scale') as HTMLSelectElement)?.value || 120);

    const body: any = {
      displayScale,
      stream: { bitrate, maxFps },
    };
    if (newPin) body.pin = newPin;

    localStorage.setItem('tesroid_display_scale', String(displayScale));

    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        window.dispatchEvent(
          new CustomEvent('tesroid:settings-updated', {
            detail: { displayScale, stream: { bitrate, maxFps } },
          })
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
