import {
  AUDIO_BITRATE_OPTIONS,
  addFavorite,
  CLIENT_PROFILE_NAMES,
  type ClientProfileName,
  CPU_PERFORMANCE_PRESETS,
  DEFAULT_FAVORITES,
  DISPLAY_SCALE_UI_OPTIONS,
  type EncoderBackend,
  type FavoriteItem,
  GPU_PERFORMANCE_PRESETS,
  isAllowedHttpUrl,
  isPresetCompatibleWithBackend,
  isValidPin,
  normalizeDisplayScaleForUi,
  removeFavorite,
  resolveClientProfile,
  STREAM_BOUNDS,
  setHomeFavorite,
  TARGET_BUFFER_MS_OPTIONS,
  type VideoPerformancePreset,
  validateFavorites,
} from "@tesroid/shared";
import type { AppState, AppStore, SettingsTabId } from "../../state/index.js";
import { el, getDoc, touchButton } from "../dom.js";
import { escapeHtml } from "../escape.js";
import {
  openTouchPicker,
  pickerControl,
  type TouchPickerHandle,
  type TouchPickerOption,
} from "../touch-picker.js";

export interface SettingsPollingTimerHandle {
  cancel(): void;
}

export interface SettingsPollingClock {
  nowMs(): number;
  setTimeout(callback: () => void, delayMs: number): SettingsPollingTimerHandle;
  clearTimeout(handle: SettingsPollingTimerHandle): void;
}

export interface SettingsModalViewOptions {
  readonly clock?: SettingsPollingClock;
}

const HEALTH_POLL_INTERVAL_MS = 5_000;
const METRICS_POLL_INTERVAL_MS = 3_000;
const TWO_TAP_WINDOW_MS = 5_000;

const PRESET_LABELS: Readonly<Record<VideoPerformancePreset, string>> = {
  high: "高画質 GPU (max 1920)",
  balanced: "標準 GPU (max 1280)",
  low_power: "省電力 GPU (max 960)",
  cpu_balanced: "標準 CPU (max 1280)",
  cpu_low_power: "省電力 CPU (max 960)",
  custom: "カスタム (custom)",
};

const PROFILE_LABELS: Readonly<Record<ClientProfileName, string>> = {
  standard: "標準 (standard)",
  lightweight: "軽量 (lightweight)",
  custom: "カスタム (custom)",
};

function displayScaleLabel(scale: number): string {
  return scale === 100 ? "100% (既定)" : `${scale}%`;
}

function targetBufferLabel(ms: number): string {
  return ms === 10_000 ? "10,000 ms (既定)" : `${ms.toLocaleString("en-US")} ms`;
}

function audioBitrateLabel(bps: number): string {
  const kbps = Math.round(bps / 1_000);
  return bps === 128_000 ? `${kbps} kbps (既定)` : `${kbps} kbps`;
}

function defaultPollingClock(): SettingsPollingClock {
  return {
    nowMs: () => Date.now(),
    setTimeout: (callback, delayMs) => {
      const id = globalThis.setTimeout(callback, delayMs);
      return {
        cancel: () => {
          globalThis.clearTimeout(id);
        },
      };
    },
    clearTimeout: (handle) => {
      handle.cancel();
    },
  };
}

interface GeneralDraft {
  pin: string;
  displayScale: number;
  targetBufferMs: number;
  audioBitrate: number;
  preset: VideoPerformancePreset;
  maxSize: number;
  vaapiCompressionLevel: number;
  vaapiLowPower: boolean;
  vaapiGpuColorConvert: boolean;
  clientProfileActive: ClientProfileName;
  customScale: number;
  customAllowedFpsText: string;
}

function createDraftFromState(state: AppState): GeneralDraft | null {
  const settings = state.settings;
  if (settings === null) {
    return null;
  }
  const backend = state.health?.encoder.backend;
  const rawPreset = settings.stream.preset;
  const preset =
    backend !== undefined && !isPresetCompatibleWithBackend(rawPreset, backend)
      ? "custom"
      : rawPreset;

  return {
    pin: "",
    displayScale: normalizeDisplayScaleForUi(settings.stream.displayScale),
    targetBufferMs: settings.stream.targetBufferMs,
    audioBitrate: settings.stream.audioBitrate,
    preset,
    maxSize: settings.stream.maxSize,
    vaapiCompressionLevel: settings.stream.vaapi.compressionLevel,
    vaapiLowPower: settings.stream.vaapi.lowPower,
    vaapiGpuColorConvert: settings.stream.vaapi.gpuColorConvert,
    clientProfileActive: settings.stream.clientProfile.active,
    customScale: settings.stream.clientProfile.custom.scale,
    customAllowedFpsText: settings.stream.clientProfile.custom.allowedFps.join(","),
  };
}

function parseAllowedFpsText(text: string): number[] {
  const values = text
    .split(",")
    .map((part) => Number(part.trim()))
    .filter(
      (num) => Number.isFinite(num) && num >= STREAM_BOUNDS.fps.min && num <= STREAM_BOUNDS.fps.max,
    );
  return values.length > 0 ? values : [24, 30];
}

export class SettingsModalView {
  private readonly store: AppStore;
  private readonly clock: SettingsPollingClock;
  private container: HTMLElement | null = null;
  private healthTimer: SettingsPollingTimerHandle | null = null;
  private metricsTimer: SettingsPollingTimerHandle | null = null;

  private wasOpen = false;
  private lastTab: SettingsTabId | null = null;
  private lastSyncedSettings: AppState["settings"] = null;
  private lastSyncedBackend: EncoderBackend | null = null;
  private generalDraft: GeneralDraft | null = null;
  private directUrlDraft = "";
  private newFavTitleDraft = "";
  private newFavUrlDraft = "";
  private editingFavId: string | null = null;
  private editingFavTitle = "";
  private editingFavUrl = "";
  private browserTabError: string | null = null;
  private generalTabError: string | null = null;
  private generalStatusMessage: string | null = null;
  private resetPresetsArmedUntilMs: number | null = null;
  private clearLogsArmedUntilMs: number | null = null;
  private activePicker: TouchPickerHandle | null = null;

  // Spec: docs/specs/07-ui-hud-settings.md#2.4
  constructor(store: AppStore, options?: SettingsModalViewOptions) {
    this.store = store;
    this.clock = options?.clock ?? defaultPollingClock();
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.4
  mount(container: HTMLElement): void {
    this.container = container;
    this.render(this.store.getState());
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.4
  unmount(): void {
    this.stopPolling();
    this.activePicker?.dismiss();
    this.activePicker = null;
    if (this.container !== null) {
      this.container.replaceChildren();
    }
    this.container = null;
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.4
  render(state: AppState): void {
    if (this.container === null) {
      return;
    }

    if (state.activeModal.kind !== "settings") {
      if (this.wasOpen) {
        this.wasOpen = false;
        this.lastTab = null;
        this.stopPolling();
        this.resetTransientUiState();
      }
      if (state.activeModal.kind === "none") {
        this.container.replaceChildren();
      }
      return;
    }

    const activeTab = state.activeModal.activeTab;
    const justOpened = !this.wasOpen;
    this.wasOpen = true;

    const currentBackend = state.health?.encoder.backend ?? null;
    if (
      justOpened ||
      this.generalDraft === null ||
      this.lastSyncedSettings !== state.settings ||
      (currentBackend !== null && this.lastSyncedBackend !== currentBackend)
    ) {
      this.lastSyncedSettings = state.settings;
      this.lastSyncedBackend = currentBackend;
      if (justOpened || this.lastSyncedSettings === state.settings) {
        this.generalDraft = createDraftFromState(state);
      }
    }

    this.ensureHealthPolling();
    if (activeTab === "metrics") {
      if (this.lastTab !== "metrics") {
        void this.store.fetchMetricsSummary();
      }
      this.ensureMetricsPolling();
    } else {
      this.stopMetricsPolling();
    }
    this.lastTab = activeTab;

    const doc = getDoc(this.container);
    const backdrop = el(doc, "div", {
      className: "modal-backdrop",
      attrs: { "data-testid": "settings-modal-backdrop" },
    });
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        this.store.closeModal();
      }
    });

    const card = el(doc, "section", {
      className: "modal-card",
      attrs: { "data-testid": "settings-modal" },
    });

    card.appendChild(
      el(doc, "div", { className: "screen-topbar" }, [
        el(doc, "strong", { text: "設定・管理コンソール" }),
        touchButton(doc, "閉じる", () => this.store.closeModal(), {
          className: "btn",
          attrs: { "data-action": "close-settings" },
        }),
      ]),
    );

    const tabs: readonly { readonly id: SettingsTabId; readonly label: string }[] = [
      { id: "browser", label: "Web ブラウザ" },
      { id: "general", label: "一般・配信設定" },
      { id: "metrics", label: "品質メトリクス" },
    ];
    const tabBar = el(doc, "div", {
      className: "tab-bar",
      attrs: { "data-testid": "settings-tabs" },
    });
    for (const tab of tabs) {
      tabBar.appendChild(
        touchButton(
          doc,
          tab.label,
          () => {
            this.store.openModal({ kind: "settings", activeTab: tab.id });
          },
          {
            className: activeTab === tab.id ? "btn tab-btn--active" : "btn",
            attrs: { "data-settings-tab": tab.id },
          },
        ),
      );
    }
    card.appendChild(tabBar);

    switch (activeTab) {
      case "browser":
        card.appendChild(this.renderBrowserTab(doc, state));
        break;
      case "general":
        card.appendChild(this.renderGeneralTab(doc, state));
        break;
      case "metrics":
        card.appendChild(this.renderMetricsTab(doc, state));
        break;
    }

    backdrop.appendChild(card);
    this.container.replaceChildren(backdrop);
  }

  private renderBrowserTab(doc: Document, state: AppState): HTMLElement {
    const root = el(doc, "div", {
      className: "form-field",
      attrs: { "data-testid": "settings-tab-browser" },
    });
    const favorites = state.settings?.favorites ?? [];
    const isStandby = state.role === "SECONDARY_STANDBY";

    if (this.browserTabError !== null) {
      root.appendChild(
        el(doc, "div", {
          className: "error-banner",
          text: this.browserTabError,
          attrs: { "data-testid": "settings-browser-error" },
        }),
      );
    }

    const navInput = el(doc, "input", {
      className: "form-input",
      attrs: {
        type: "url",
        placeholder: "https://example.com",
        "data-testid": "settings-direct-url-input",
      },
    });
    navInput.value = this.directUrlDraft;
    navInput.addEventListener("input", () => {
      this.directUrlDraft = navInput.value;
    });

    root.appendChild(
      el(doc, "div", { className: "form-field" }, [
        el(doc, "label", { text: "任意 URL へ移動 (http/https のみ)" }),
        el(doc, "div", { className: "row-actions" }, [
          navInput,
          touchButton(
            doc,
            "移動",
            () => {
              const trimmed = this.directUrlDraft.trim();
              if (!isAllowedHttpUrl(trimmed)) {
                this.browserTabError = "有効な http(s):// URL を入力してください";
                this.render(this.store.getState());
                return;
              }
              this.browserTabError = null;
              this.store.navigateToUrl(trimmed);
            },
            {
              className: "btn btn--primary",
              disabled: isStandby,
              attrs: { "data-action": "settings-navigate-url" },
            },
          ),
        ]),
      ]),
    );

    const addTitleInput = el(doc, "input", {
      className: "form-input",
      attrs: {
        type: "text",
        placeholder: "サイト名",
        "data-testid": "settings-fav-add-title",
      },
    });
    addTitleInput.value = this.newFavTitleDraft;
    addTitleInput.addEventListener("input", () => {
      this.newFavTitleDraft = addTitleInput.value;
    });

    const addUrlInput = el(doc, "input", {
      className: "form-input",
      attrs: {
        type: "url",
        placeholder: "https://...",
        "data-testid": "settings-fav-add-url",
      },
    });
    addUrlInput.value = this.newFavUrlDraft;
    addUrlInput.addEventListener("input", () => {
      this.newFavUrlDraft = addUrlInput.value;
    });

    root.appendChild(
      el(doc, "div", { className: "form-field" }, [
        el(doc, "label", { text: "お気に入り追加" }),
        addTitleInput,
        addUrlInput,
        el(doc, "div", { className: "row-actions" }, [
          touchButton(
            doc,
            "＋ 現在のページを追加",
            () => {
              void this.handleAddFavorite(
                favorites,
                state.hud.currentTitle?.trim() || state.hud.currentUrl || "",
                state.hud.currentUrl ?? "",
              );
            },
            {
              className: "btn",
              disabled: state.settings === null,
              attrs: { "data-action": "settings-fav-add-current" },
            },
          ),
          touchButton(
            doc,
            "手動追加",
            () => {
              void this.handleAddFavorite(favorites, this.newFavTitleDraft, this.newFavUrlDraft);
            },
            {
              className: "btn btn--primary",
              disabled: state.settings === null,
              attrs: { "data-action": "settings-fav-add-manual" },
            },
          ),
        ]),
      ]),
    );

    const listWrap = el(doc, "div", {
      className: "form-field",
      attrs: { "data-testid": "settings-favorites-list" },
    });

    for (let index = 0; index < favorites.length; index += 1) {
      const fav = favorites[index];
      if (fav === undefined) {
        continue;
      }
      if (this.editingFavId === fav.id) {
        listWrap.appendChild(this.renderFavoriteEditRow(doc, favorites, fav));
      } else {
        listWrap.appendChild(this.renderFavoriteRow(doc, favorites, fav, index, isStandby));
      }
    }
    root.appendChild(listWrap);

    const nowMs = this.clock.nowMs();
    const isResetArmed =
      this.resetPresetsArmedUntilMs !== null && nowMs <= this.resetPresetsArmedUntilMs;
    root.appendChild(
      el(doc, "div", { className: "row-actions" }, [
        touchButton(
          doc,
          isResetArmed ? "もう一度タップしてプリセット初期化を確定" : "プリセット初期化",
          () => {
            void this.handlePresetResetTap();
          },
          {
            className: isResetArmed ? "btn btn--danger" : "btn btn--warn",
            attrs: { "data-action": "settings-reset-presets" },
          },
        ),
      ]),
    );

    return root;
  }

  private renderFavoriteRow(
    doc: Document,
    favorites: readonly FavoriteItem[],
    fav: FavoriteItem,
    index: number,
    isStandby: boolean,
  ): HTMLElement {
    const meta = el(doc, "div", { className: "favorite-meta" });
    const titleSpan = el(doc, "strong");
    const safeTitle = escapeHtml(fav.title);
    titleSpan.innerHTML = fav.isHome
      ? `${safeTitle} <span class="home-badge">ホーム</span>`
      : safeTitle;
    const urlSpan = el(doc, "span", { className: "favorite-url" });
    urlSpan.innerHTML = escapeHtml(fav.url);
    meta.appendChild(titleSpan);
    meta.appendChild(urlSpan);

    const actions = el(doc, "div", { className: "row-actions" }, [
      touchButton(
        doc,
        "開く",
        () => {
          this.store.navigateToUrl(fav.url);
        },
        {
          className: "btn",
          disabled: isStandby,
          attrs: { "data-action": "fav-open", "data-fav-id": fav.id },
        },
      ),
      touchButton(
        doc,
        "ホーム",
        () => {
          void this.persistFavorites(setHomeFavorite(favorites, fav.id));
        },
        {
          className: "btn",
          disabled: fav.isHome,
          attrs: { "data-action": "fav-home", "data-fav-id": fav.id },
        },
      ),
      touchButton(
        doc,
        "↑",
        () => {
          void this.moveFavorite(favorites, index, -1);
        },
        {
          className: "btn",
          disabled: index === 0,
          attrs: { "data-action": "fav-up", "data-fav-id": fav.id },
        },
      ),
      touchButton(
        doc,
        "↓",
        () => {
          void this.moveFavorite(favorites, index, 1);
        },
        {
          className: "btn",
          disabled: index === favorites.length - 1,
          attrs: { "data-action": "fav-down", "data-fav-id": fav.id },
        },
      ),
      touchButton(
        doc,
        "編集",
        () => {
          this.editingFavId = fav.id;
          this.editingFavTitle = fav.title;
          this.editingFavUrl = fav.url;
          this.browserTabError = null;
          this.render(this.store.getState());
        },
        {
          className: "btn",
          attrs: { "data-action": "fav-edit", "data-fav-id": fav.id },
        },
      ),
      touchButton(
        doc,
        "削除",
        () => {
          void this.persistFavorites(removeFavorite(favorites, fav.id));
        },
        {
          className: "btn btn--danger",
          attrs: { "data-action": "fav-delete", "data-fav-id": fav.id },
        },
      ),
    ]);

    return el(
      doc,
      "div",
      { className: "favorite-row", attrs: { "data-testid": `favorite-row-${fav.id}` } },
      [meta, actions],
    );
  }

  private renderFavoriteEditRow(
    doc: Document,
    favorites: readonly FavoriteItem[],
    fav: FavoriteItem,
  ): HTMLElement {
    const titleInput = el(doc, "input", {
      className: "form-input",
      attrs: { type: "text", "data-testid": "fav-edit-title" },
    });
    titleInput.value = this.editingFavTitle;
    titleInput.addEventListener("input", () => {
      this.editingFavTitle = titleInput.value;
    });

    const urlInput = el(doc, "input", {
      className: "form-input",
      attrs: { type: "url", "data-testid": "fav-edit-url" },
    });
    urlInput.value = this.editingFavUrl;
    urlInput.addEventListener("input", () => {
      this.editingFavUrl = urlInput.value;
    });

    return el(doc, "div", { className: "favorite-row" }, [
      titleInput,
      urlInput,
      el(doc, "div", { className: "row-actions" }, [
        touchButton(
          doc,
          "保存",
          () => {
            void this.handleSaveEditedFavorite(favorites, fav.id);
          },
          { className: "btn btn--primary", attrs: { "data-action": "fav-edit-save" } },
        ),
        touchButton(
          doc,
          "キャンセル",
          () => {
            this.editingFavId = null;
            this.browserTabError = null;
            this.render(this.store.getState());
          },
          { className: "btn", attrs: { "data-action": "fav-edit-cancel" } },
        ),
      ]),
    ]);
  }

  private renderGeneralTab(doc: Document, state: AppState): HTMLElement {
    const root = el(doc, "div", {
      className: "form-field",
      attrs: { "data-testid": "settings-tab-general" },
    });

    if (this.generalDraft === null) {
      root.appendChild(el(doc, "p", { text: "設定を読み込み中..." }));
      return root;
    }
    const draft = this.generalDraft;
    const health = state.health;
    const backend: EncoderBackend = health?.encoder.backend ?? "vaapi";

    const err = this.generalTabError ?? state.errorBanner;
    if (err !== null) {
      root.appendChild(
        el(doc, "div", {
          className: "error-banner",
          text: err,
          attrs: { "data-testid": "settings-general-error" },
        }),
      );
    }
    if (this.generalStatusMessage !== null) {
      root.appendChild(
        el(doc, "div", {
          className: "warn-banner",
          text: this.generalStatusMessage,
          attrs: { "data-testid": "settings-general-status" },
        }),
      );
    }

    // New PIN
    const pinInput = el(doc, "input", {
      className: "form-input",
      attrs: {
        type: "password",
        inputmode: "numeric",
        placeholder: "空欄で維持 (4〜8 桁半角数字)",
        "data-testid": "settings-pin-input",
      },
    });
    pinInput.value = draft.pin;
    pinInput.addEventListener("input", () => {
      draft.pin = pinInput.value;
    });
    root.appendChild(
      el(doc, "div", { className: "form-field" }, [
        el(doc, "label", { text: "新しい PIN コード（空欄で現在の PIN を維持）" }),
        pinInput,
      ]),
    );

    // Display Scale (60..130%, 8 options, fallback 100%, no dynamic option)
    const scaleControl = pickerControl(
      doc,
      "settings-display-scale",
      displayScaleLabel(draft.displayScale),
      () => {
        void this.openOptionPicker(
          doc,
          "settings-display-scale",
          "ブラウザ表示拡大率",
          DISPLAY_SCALE_UI_OPTIONS.map((scale) => ({
            label: displayScaleLabel(scale),
            value: String(scale),
          })),
          String(draft.displayScale),
        ).then((value) => {
          if (value === null) {
            return;
          }
          draft.displayScale = Number(value);
          void this.store.saveSettings({ stream: { displayScale: Number(value) } });
        });
      },
    );
    root.appendChild(
      el(doc, "div", { className: "form-field" }, [
        el(doc, "label", { text: "ブラウザ表示拡大率" }),
        scaleControl,
      ]),
    );

    // Target Buffer Depth
    const bufferControl = pickerControl(
      doc,
      "settings-target-buffer",
      targetBufferLabel(draft.targetBufferMs),
      () => {
        void this.openOptionPicker(
          doc,
          "settings-target-buffer",
          "先行バッファ深度",
          TARGET_BUFFER_MS_OPTIONS.map((ms) => ({
            label: targetBufferLabel(ms),
            value: String(ms),
          })),
          String(draft.targetBufferMs),
        ).then((value) => {
          if (value === null) {
            return;
          }
          draft.targetBufferMs = Number(value);
          void this.store.saveSettings({ stream: { targetBufferMs: Number(value) } });
        });
      },
    );
    root.appendChild(
      el(doc, "div", { className: "form-field" }, [
        el(doc, "label", { text: "先行バッファ深度" }),
        bufferControl,
      ]),
    );

    // Audio Bitrate
    const audioControl = pickerControl(
      doc,
      "settings-audio-bitrate",
      audioBitrateLabel(draft.audioBitrate),
      () => {
        void this.openOptionPicker(
          doc,
          "settings-audio-bitrate",
          "音声ビットレート",
          AUDIO_BITRATE_OPTIONS.map((bps) => ({
            label: audioBitrateLabel(bps),
            value: String(bps),
          })),
          String(draft.audioBitrate),
        ).then((value) => {
          if (value === null) {
            return;
          }
          draft.audioBitrate = Number(value);
          void this.store.saveSettings({ stream: { audioBitrate: Number(value) } });
        });
      },
    );
    root.appendChild(
      el(doc, "div", { className: "form-field" }, [
        el(doc, "label", { text: "音声ビットレート" }),
        audioControl,
      ]),
    );

    // Server video performance preset & health info
    const backendLabel = health === null ? "取得中..." : health.encoder.backend.toUpperCase();
    const resInfo =
      health !== null
        ? `キャプチャ ${health.encoder.captureResolution.width}x${health.encoder.captureResolution.height} → エンコード ${health.encoder.encodeResolution.width}x${health.encoder.encodeResolution.height}`
        : "エンコード解像度: 取得中";
    root.appendChild(
      el(
        doc,
        "div",
        { className: "form-field", attrs: { "data-testid": "settings-encoder-health" } },
        [
          el(doc, "strong", { text: `サーバー映像パフォーマンス (${backendLabel})` }),
          el(doc, "span", { text: `${resInfo}（プリセットに応じてエンコード寸法を縮小）` }),
        ],
      ),
    );

    if (health?.encoder.backend === "software") {
      root.appendChild(
        el(doc, "div", {
          className: "warn-banner",
          text: "ソフトウェアエンコード (libx264) で動作中です。CPU 負荷を抑えるため軽量プリセットを推奨します。",
          attrs: { "data-testid": "settings-software-warning" },
        }),
      );
    }

    const availablePresets: readonly VideoPerformancePreset[] =
      backend === "software" ? CPU_PERFORMANCE_PRESETS : GPU_PERFORMANCE_PRESETS;
    const currentPresetValue: VideoPerformancePreset = isPresetCompatibleWithBackend(
      draft.preset,
      backend,
    )
      ? draft.preset
      : "custom";
    const presetControl = pickerControl(
      doc,
      "settings-video-preset",
      PRESET_LABELS[currentPresetValue],
      () => {
        void this.openOptionPicker(
          doc,
          "settings-video-preset",
          "サーバー映像プリセット",
          availablePresets.map((p) => ({ label: PRESET_LABELS[p], value: p })),
          currentPresetValue,
        ).then((value) => {
          if (value === null) {
            return;
          }
          draft.preset = value as VideoPerformancePreset;
          void this.store.saveSettings({ stream: { preset: value as VideoPerformancePreset } });
          this.render(this.store.getState());
        });
      },
    );
    root.appendChild(
      el(doc, "div", { className: "form-field" }, [
        el(doc, "label", { text: "サーバー映像プリセット" }),
        presetControl,
      ]),
    );

    const maxSizeInput = el(doc, "input", {
      className: "form-input",
      attrs: { type: "number", "data-testid": "settings-max-size" },
    });
    maxSizeInput.value = String(draft.maxSize);
    maxSizeInput.addEventListener("input", () => {
      const parsed = Number(maxSizeInput.value);
      if (Number.isFinite(parsed)) {
        draft.maxSize = parsed;
      }
      draft.preset = "custom";
      presetControl.textContent = PRESET_LABELS.custom;
    });
    root.appendChild(
      el(doc, "div", { className: "form-field" }, [
        el(doc, "label", { text: "最大エンコード辺長 (640〜1920 px、変更時 custom 切替)" }),
        maxSizeInput,
      ]),
    );

    if (backend !== "vaapi") {
      root.appendChild(
        el(doc, "div", {
          className: "metric-label",
          text:
            backend === "nvenc"
              ? "VAAPI 詳細設定は NVENC バックエンド使用中のため無効化されています。"
              : "VAAPI 詳細設定はソフトウェア (CPU) バックエンド使用中のため無効化されています。",
          attrs: { "data-testid": "settings-vaapi-disabled-reason" },
        }),
      );
    }

    // Client Load Profile
    const profileControl = pickerControl(
      doc,
      "settings-client-profile",
      PROFILE_LABELS[draft.clientProfileActive],
      () => {
        void this.openOptionPicker(
          doc,
          "settings-client-profile",
          "クライアント負荷プロファイル",
          CLIENT_PROFILE_NAMES.map((name) => ({ label: PROFILE_LABELS[name], value: name })),
          draft.clientProfileActive,
        ).then((value) => {
          if (value === null) {
            return;
          }
          draft.clientProfileActive = value as ClientProfileName;
          void this.store.saveSettings({
            stream: { clientProfile: { active: value as ClientProfileName } },
          });
          this.render(this.store.getState());
        });
      },
    );

    const resolvedProfile = resolveClientProfile({
      active: draft.clientProfileActive,
      custom: {
        scale: draft.customScale,
        allowedFps: parseAllowedFpsText(draft.customAllowedFpsText),
      },
    });
    const previewText = `実効倍率: ${resolvedProfile.scale.toFixed(2)} / 許容 FPS: [${resolvedProfile.allowedFps.join(", ")}]${
      resolvedProfile.defaultBitrateBps !== null
        ? ` / 基準ビットレート: ${Math.round(resolvedProfile.defaultBitrateBps / 1_000)} kbps`
        : ""
    }`;

    root.appendChild(
      el(doc, "div", { className: "form-field" }, [
        el(doc, "label", { text: "クライアント負荷プロファイル" }),
        profileControl,
        el(doc, "span", {
          className: "metric-label",
          text: previewText,
          attrs: { "data-testid": "settings-profile-preview" },
        }),
      ]),
    );

    if (draft.clientProfileActive === "custom") {
      const customScaleInput = el(doc, "input", {
        className: "form-input",
        attrs: { type: "number", step: "0.05", "data-testid": "settings-custom-scale" },
      });
      customScaleInput.value = String(draft.customScale);
      customScaleInput.addEventListener("input", () => {
        const val = Number(customScaleInput.value);
        if (Number.isFinite(val)) {
          draft.customScale = val;
        }
      });

      const customFpsInput = el(doc, "input", {
        className: "form-input",
        attrs: { type: "text", placeholder: "24,30,60", "data-testid": "settings-custom-fps" },
      });
      customFpsInput.value = draft.customAllowedFpsText;
      customFpsInput.addEventListener("input", () => {
        draft.customAllowedFpsText = customFpsInput.value;
      });

      root.appendChild(
        el(doc, "div", { className: "form-field" }, [
          el(doc, "label", { text: "カスタム負荷倍率 (0.4〜1.0)" }),
          customScaleInput,
          el(doc, "label", { text: "カスタム許容 FPS（カンマ区切り）" }),
          customFpsInput,
        ]),
      );
    }

    root.appendChild(
      el(doc, "div", { className: "row-actions" }, [
        touchButton(
          doc,
          "設定を保存",
          () => {
            void this.handleSaveGeneralSettings(draft);
          },
          { className: "btn btn--primary", attrs: { "data-action": "settings-general-save" } },
        ),
      ]),
    );

    return root;
  }

  private renderMetricsTab(doc: Document, state: AppState): HTMLElement {
    const root = el(doc, "div", {
      className: "form-field",
      attrs: { "data-testid": "settings-tab-metrics" },
    });

    const summary = state.metricsSummary;
    const grid = el(doc, "div", { className: "metrics-grid" });
    const cards: readonly [string, string][] =
      summary === null
        ? [["ステータス", "集計データを取得中..."]]
        : [
            ["現在 / 平均 FPS", `${summary.currentFps.toFixed(1)} / ${summary.avgFps.toFixed(1)}`],
            [
              "平均 / 最大 RTT",
              `${summary.avgRttMs.toFixed(1)} / ${summary.maxRttMs.toFixed(1)} ms`,
            ],
            ["ドロップフレーム合計", `${summary.totalDroppedFrames}`],
            ["デコーダエラー合計", `${summary.totalDecoderErrors}`],
            ["平均ビットレート", `${summary.avgBitrateKbps.toFixed(0)} kbps`],
            ["平均 A/V ズレ", `${summary.avgAvDriftMs.toFixed(1)} ms`],
            ["サンプル数", `${summary.sampleCount}`],
          ];
    for (const [label, value] of cards) {
      grid.appendChild(
        el(doc, "div", { className: "metric-card" }, [
          el(doc, "span", { className: "metric-label", text: label }),
          el(doc, "span", { className: "metric-value", text: value }),
        ]),
      );
    }
    root.appendChild(grid);

    const telemetryEnabled = state.settings?.stream.telemetryEnabled ?? false;
    root.appendChild(
      el(doc, "div", { className: "row-actions" }, [
        touchButton(
          doc,
          telemetryEnabled ? "詳細テレメトリ収集: ON" : "詳細テレメトリ収集: OFF",
          () => {
            void this.store.saveSettings({
              stream: { telemetryEnabled: !telemetryEnabled },
            });
          },
          {
            className: telemetryEnabled ? "btn btn--primary" : "btn",
            disabled: state.settings === null,
            attrs: { "data-action": "settings-toggle-telemetry" },
          },
        ),
      ]),
    );

    const nowMs = this.clock.nowMs();
    const isClearArmed = this.clearLogsArmedUntilMs !== null && nowMs <= this.clearLogsArmedUntilMs;
    root.appendChild(
      el(doc, "div", { className: "row-actions" }, [
        touchButton(
          doc,
          isClearArmed ? "もう一度タップしてログ全消去を確定" : "サーバーログ全消去",
          () => {
            void this.handleClearTelemetryTap();
          },
          {
            className: isClearArmed ? "btn btn--danger" : "btn btn--warn",
            attrs: { "data-action": "settings-clear-telemetry" },
          },
        ),
      ]),
    );

    return root;
  }

  private async handleAddFavorite(
    favorites: readonly FavoriteItem[],
    title: string,
    url: string,
  ): Promise<void> {
    const id = `fav-${this.clock.nowMs()}-${Math.random().toString(36).slice(2, 6)}`;
    const result = addFavorite(favorites, { id, title, url });
    if (!result.ok) {
      this.browserTabError = result.message;
      this.render(this.store.getState());
      return;
    }
    const ok = await this.persistFavorites(result.value);
    if (ok) {
      this.newFavTitleDraft = "";
      this.newFavUrlDraft = "";
    }
  }

  private async handleSaveEditedFavorite(
    favorites: readonly FavoriteItem[],
    targetId: string,
  ): Promise<void> {
    const updated = favorites.map((item) =>
      item.id === targetId
        ? { ...item, title: this.editingFavTitle, url: this.editingFavUrl }
        : item,
    );
    const validation = validateFavorites(updated);
    if (!validation.ok) {
      this.browserTabError = validation.message;
      this.render(this.store.getState());
      return;
    }
    const ok = await this.persistFavorites(validation.value);
    if (ok) {
      this.editingFavId = null;
    }
  }

  private async moveFavorite(
    favorites: readonly FavoriteItem[],
    index: number,
    delta: -1 | 1,
  ): Promise<void> {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= favorites.length) {
      return;
    }
    const next = [...favorites];
    const currentItem = next[index];
    const swapItem = next[targetIndex];
    if (currentItem === undefined || swapItem === undefined) {
      return;
    }
    next[index] = swapItem;
    next[targetIndex] = currentItem;
    await this.persistFavorites(next);
  }

  private async persistFavorites(nextFavorites: readonly FavoriteItem[]): Promise<boolean> {
    this.browserTabError = null;
    const ok = await this.store.saveSettings({ favorites: nextFavorites });
    if (!ok) {
      this.browserTabError = this.store.getState().errorBanner ?? "お気に入りの保存に失敗しました";
      this.render(this.store.getState());
      return false;
    }
    return true;
  }

  private async handlePresetResetTap(): Promise<void> {
    const nowMs = this.clock.nowMs();
    if (this.resetPresetsArmedUntilMs !== null && nowMs <= this.resetPresetsArmedUntilMs) {
      this.resetPresetsArmedUntilMs = null;
      await this.persistFavorites(DEFAULT_FAVORITES);
      return;
    }
    this.resetPresetsArmedUntilMs = nowMs + TWO_TAP_WINDOW_MS;
    this.render(this.store.getState());
  }

  private async handleClearTelemetryTap(): Promise<void> {
    const nowMs = this.clock.nowMs();
    if (this.clearLogsArmedUntilMs !== null && nowMs <= this.clearLogsArmedUntilMs) {
      this.clearLogsArmedUntilMs = null;
      await this.store.deleteTelemetryLogs();
      this.render(this.store.getState());
      return;
    }
    this.clearLogsArmedUntilMs = nowMs + TWO_TAP_WINDOW_MS;
    this.render(this.store.getState());
  }

  private async handleSaveGeneralSettings(draft: GeneralDraft): Promise<void> {
    if (draft.pin.length > 0 && !isValidPin(draft.pin)) {
      this.generalTabError = "PIN は 4〜8 桁の半角数字で入力してください";
      this.render(this.store.getState());
      return;
    }
    this.generalTabError = null;
    this.generalStatusMessage = null;

    const safeDisplayScale = normalizeDisplayScaleForUi(draft.displayScale);
    const ok = await this.store.saveSettings({
      ...(draft.pin.length > 0 ? { pin: draft.pin } : {}),
      stream: {
        displayScale: safeDisplayScale,
        targetBufferMs: draft.targetBufferMs,
        audioBitrate: draft.audioBitrate,
        preset: draft.preset,
        maxSize: draft.maxSize,
        clientProfile: {
          active: draft.clientProfileActive,
          custom: {
            scale: draft.customScale,
            allowedFps: parseAllowedFpsText(draft.customAllowedFpsText),
          },
        },
      },
    });

    if (!ok) {
      this.generalTabError = this.store.getState().errorBanner ?? "設定の保存に失敗しました";
      this.render(this.store.getState());
      return;
    }

    draft.pin = "";
    this.generalStatusMessage = "設定を保存しました";
    this.render(this.store.getState());
  }

  private ensureHealthPolling(): void {
    if (this.healthTimer !== null) {
      return;
    }
    void this.store.fetchHealth();
    const schedule = () => {
      this.healthTimer = this.clock.setTimeout(() => {
        this.healthTimer = null;
        if (this.store.getState().activeModal.kind !== "settings") {
          return;
        }
        void this.store.fetchHealth();
        schedule();
      }, HEALTH_POLL_INTERVAL_MS);
    };
    schedule();
  }

  private ensureMetricsPolling(): void {
    if (this.metricsTimer !== null) {
      return;
    }
    const schedule = () => {
      this.metricsTimer = this.clock.setTimeout(() => {
        this.metricsTimer = null;
        const modal = this.store.getState().activeModal;
        if (modal.kind !== "settings" || modal.activeTab !== "metrics") {
          return;
        }
        void this.store.fetchMetricsSummary();
        schedule();
      }, METRICS_POLL_INTERVAL_MS);
    };
    schedule();
  }

  private stopMetricsPolling(): void {
    if (this.metricsTimer !== null) {
      this.clock.clearTimeout(this.metricsTimer);
      this.metricsTimer = null;
    }
  }

  private stopPolling(): void {
    if (this.healthTimer !== null) {
      this.clock.clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
    this.stopMetricsPolling();
  }

  private resetTransientUiState(): void {
    this.generalDraft = null;
    this.editingFavId = null;
    this.browserTabError = null;
    this.generalTabError = null;
    this.generalStatusMessage = null;
    this.resetPresetsArmedUntilMs = null;
    this.clearLogsArmedUntilMs = null;
    this.activePicker?.dismiss();
    this.activePicker = null;
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.4 (AC-06) — 開いているピッカーは常に単一。
  private openOptionPicker(
    doc: Document,
    testid: string,
    title: string,
    options: readonly TouchPickerOption[],
    selectedValue: string,
  ): Promise<string | null> {
    this.activePicker?.dismiss();
    const handle = openTouchPicker(doc, { title, testid, options, selectedValue });
    this.activePicker = handle;
    void handle.closed.then(() => {
      if (this.activePicker === handle) {
        this.activePicker = null;
      }
    });
    return handle.closed;
  }
}
