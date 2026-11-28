import { type EncoderBackend, isValidPin, normalizeDisplayScaleForUi } from "@tesroid/shared";
import type { AppState, AppStore, SettingsTabId } from "../../state/index.js";
import { el, getDoc, touchButton } from "../dom.js";
import { showToast } from "../toast-view.js";
import { TouchPickerHost, type TouchPickerOption } from "../touch-picker.js";
import {
  type BrowserTabState,
  createBrowserTabState,
  renderBrowserTab,
  resetBrowserTabState,
} from "./settings/browser-tab.js";
import {
  defaultPollingClock,
  type SettingsPollingClock,
  type SettingsPollingTimerHandle,
} from "./settings/clock.js";
import type { GeneralTabContext, SettingsTabContext } from "./settings/context.js";
import { createDraftFromState, type GeneralDraft, parseAllowedFpsText } from "./settings/draft.js";
import {
  createGeneralTabState,
  type GeneralTabState,
  renderGeneralTab,
  resetGeneralTabState,
} from "./settings/general-tab.js";
import {
  createMetricsTabState,
  type MetricsTabState,
  renderMetricsTab,
  resetMetricsTabState,
} from "./settings/metrics-tab.js";

export type {
  SettingsPollingClock,
  SettingsPollingTimerHandle,
} from "./settings/clock.js";

export interface SettingsModalViewOptions {
  readonly clock?: SettingsPollingClock;
}

const HEALTH_POLL_INTERVAL_MS = 5_000;
const METRICS_POLL_INTERVAL_MS = 3_000;

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
  private readonly browserTabState: BrowserTabState = createBrowserTabState();
  private readonly generalTabState: GeneralTabState = createGeneralTabState();
  private readonly metricsTabState: MetricsTabState = createMetricsTabState();
  private readonly pickerHost = new TouchPickerHost();

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
    this.pickerHost.dismiss();
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

    const tabContext: SettingsTabContext = {
      store: this.store,
      clock: this.clock,
      rerender: () => this.render(this.store.getState()),
    };
    const generalTabContext: GeneralTabContext = {
      ...tabContext,
      openOptionPicker: (doc, testid, title, options, selectedValue) =>
        this.openOptionPicker(doc, testid, title, options, selectedValue),
    };

    switch (activeTab) {
      case "browser":
        card.appendChild(renderBrowserTab(doc, state, tabContext, this.browserTabState));
        break;
      case "general":
        card.appendChild(
          renderGeneralTab(
            doc,
            state,
            this.generalDraft,
            generalTabContext,
            this.generalTabState,
            (draft) => this.handleSaveGeneralSettings(draft),
          ),
        );
        break;
      case "metrics":
        card.appendChild(renderMetricsTab(doc, state, tabContext, this.metricsTabState));
        break;
    }

    backdrop.appendChild(card);
    this.container.replaceChildren(backdrop);
  }

  private async handleSaveGeneralSettings(draft: GeneralDraft): Promise<void> {
    if (draft.pin.length > 0 && !isValidPin(draft.pin)) {
      this.generalTabState.error = "PIN は 4〜8 桁の半角数字で入力してください";
      this.render(this.store.getState());
      return;
    }
    this.generalTabState.error = null;
    this.generalTabState.statusMessage = null;

    const safeDisplayScale = normalizeDisplayScaleForUi(draft.displayScale);
    const ok = await this.store.saveSettings({
      ...(draft.pin.length > 0 ? { pin: draft.pin } : {}),
      stream: {
        displayScale: safeDisplayScale,
        targetBufferMs: draft.targetBufferMs,
        audioBitrate: draft.audioBitrate,
        preset: draft.preset,
        maxSize: draft.maxSize,
        vaapi: {
          compressionLevel: draft.vaapiCompressionLevel,
          lowPower: draft.vaapiLowPower,
          gpuColorConvert: draft.vaapiGpuColorConvert,
        },
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
      this.generalTabState.error = this.store.getState().errorBanner ?? "設定の保存に失敗しました";
      this.toast(this.generalTabState.error, "error");
      this.render(this.store.getState());
      return;
    }

    draft.pin = "";
    this.generalTabState.statusMessage = "設定を保存しました";
    this.toast("設定を保存しました", "success");
    this.render(this.store.getState());
  }

  private toast(message: string, kind: Parameters<typeof showToast>[2]): void {
    if (this.container === null) {
      return;
    }
    showToast(getDoc(this.container), message, kind);
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
    resetBrowserTabState(this.browserTabState);
    resetGeneralTabState(this.generalTabState);
    resetMetricsTabState(this.metricsTabState);
    this.pickerHost.dismiss();
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.4 (AC-06) — 開いているピッカーは host 側で常に単一。
  private openOptionPicker(
    doc: Document,
    testid: string,
    title: string,
    options: readonly TouchPickerOption[],
    selectedValue: string,
  ): Promise<string | null> {
    return this.pickerHost.open(doc, { title, testid, options, selectedValue });
  }
}
