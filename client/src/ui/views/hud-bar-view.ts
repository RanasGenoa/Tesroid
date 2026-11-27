import {
  addFavorite,
  DEFAULT_STREAM_SETTINGS,
  type FavoriteItem,
  type SpecialKey,
} from "@tesroid/shared";
import {
  type AppState,
  type AppStore,
  buildYouTubeSearchUrl,
  formatBitrateLabel,
  formatHudModeLabel,
  type HudDrawerState,
  isPrimaryAuthorityRole,
  type SignalQualityLevel,
} from "../../state/index.js";
import { el, getDoc, touchButton } from "../dom.js";
import { escapeHtml } from "../escape.js";

function signalBarsActiveCount(level: SignalQualityLevel): number {
  switch (level) {
    case "good":
      return 4;
    case "degraded":
      return 2;
    case "stall":
    case "reconnecting":
      return 1;
    case "disconnected":
      return 0;
  }
}

function formatSignalText(state: AppState): string {
  if (state.wsStatus === "DISCONNECTED" || state.wsStatus === "TERMINAL_CLOSED") {
    return "切断";
  }
  if (state.wsStatus === "CONNECTING" || state.hud.rttMs === null) {
    return "接続中";
  }
  return `${Math.round(state.hud.rttMs)}ms`;
}

export class HudBarView {
  private readonly store: AppStore;
  private container: HTMLElement | null = null;
  private lastDrawer: HudDrawerState = "none";
  private keyboardDraft = "";
  private youtubeQueryDraft = "";
  private favoriteError: string | null = null;
  private shouldFocusKeyboard = false;

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  constructor(store: AppStore) {
    this.store = store;
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  mount(container: HTMLElement): void {
    this.container = container;
    this.render(this.store.getState());
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  unmount(): void {
    if (this.container !== null) {
      this.container.replaceChildren();
    }
    this.container = null;
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  render(state: AppState): void {
    if (this.container === null) {
      return;
    }

    if (state.route !== "STREAMING") {
      this.lastDrawer = "none";
      this.favoriteError = null;
      this.container.replaceChildren();
      this.container.className = "hud-bar is-hidden";
      return;
    }

    const doc = getDoc(this.container);
    const prevKbInput = this.container.querySelector('[data-testid="virtual-keyboard-input"]');
    const hadKbFocus = prevKbInput !== null && doc.activeElement === prevKbInput;
    if (
      (state.hud.drawer === "keyboard" && this.lastDrawer !== "keyboard") ||
      (state.hud.drawer === "keyboard" && hadKbFocus)
    ) {
      this.shouldFocusKeyboard = true;
    }
    if (state.hud.drawer !== "favorites") {
      this.favoriteError = null;
    }
    this.lastDrawer = state.hud.drawer;

    this.container.className = state.hud.dimmed ? "hud-bar hud-bar--dimmed" : "hud-bar";

    const barInner = el(doc, "div", {
      className: "hud-bar__inner",
      attrs: { "data-testid": "hud-bar-inner" },
    });

    const isStandby = state.role === "SECONDARY_STANDBY";
    const isPrimary = isPrimaryAuthorityRole(state.role);
    const settings = state.settings;
    const targetFps = settings?.stream.fps ?? DEFAULT_STREAM_SETTINGS.fps;
    const currentBitrate = settings?.stream.videoBitrate ?? DEFAULT_STREAM_SETTINGS.videoBitrate;

    // Left controls (6 items)
    const leftGroup = el(doc, "div", {
      className: "hud-group",
      attrs: { "data-testid": "hud-left" },
    });

    leftGroup.appendChild(
      touchButton(
        doc,
        "停止",
        () => {
          this.store.openModal({ kind: "power_control" });
        },
        { className: "hud-btn", attrs: { "data-action": "open-power" } },
      ),
    );

    leftGroup.appendChild(this.buildSignalBadge(doc, state));

    leftGroup.appendChild(
      touchButton(
        doc,
        formatHudModeLabel(state.hud),
        () => {
          void this.store.requestStreamReset();
        },
        {
          className: "hud-btn",
          disabled: !isPrimary,
          attrs: { "data-action": "stream-reset", "data-testid": "hud-live-btn" },
        },
      ),
    );

    const fpsText = state.hud.isStaticScreen
      ? "静止中"
      : `${Math.round(state.hud.renderedFps)} FPS`;
    const fpsHealthy = state.hud.renderedFps >= targetFps * 0.8;
    leftGroup.appendChild(
      el(doc, "span", {
        className: state.hud.isStaticScreen
          ? "hud-badge"
          : fpsHealthy
            ? "hud-badge fps--ok"
            : "hud-badge fps--warn",
        text: fpsText,
        attrs: { "data-testid": "hud-fps-badge" },
      }),
    );

    leftGroup.appendChild(
      touchButton(
        doc,
        `${targetFps} FPS`,
        () => {
          void this.store.cycleFps();
        },
        {
          className: "hud-btn",
          disabled: settings === null,
          attrs: { "data-action": "cycle-fps", "data-testid": "hud-fps-toggle" },
        },
      ),
    );

    leftGroup.appendChild(
      touchButton(
        doc,
        formatBitrateLabel(currentBitrate),
        () => {
          void this.store.cycleBitrate();
        },
        {
          className: "hud-btn",
          disabled: settings === null,
          attrs: { "data-action": "cycle-bitrate", "data-testid": "hud-bitrate-toggle" },
        },
      ),
    );

    // Right controls (6 items)
    const rightGroup = el(doc, "div", {
      className: "hud-group",
      attrs: { "data-testid": "hud-right" },
    });

    rightGroup.appendChild(
      touchButton(
        doc,
        "キーボード",
        () => {
          this.store.toggleDrawer("keyboard");
        },
        {
          className: state.hud.drawer === "keyboard" ? "hud-btn btn--primary" : "hud-btn",
          attrs: { "data-action": "toggle-keyboard", "data-testid": "hud-keyboard-btn" },
        },
      ),
    );

    rightGroup.appendChild(
      touchButton(
        doc,
        "戻る",
        () => {
          this.store.navigateBack();
        },
        {
          className: "hud-btn",
          disabled: isStandby,
          attrs: { "data-action": "history-back" },
        },
      ),
    );

    rightGroup.appendChild(
      touchButton(
        doc,
        "ホーム",
        () => {
          this.store.navigateHome();
        },
        {
          className: "hud-btn",
          disabled: isStandby,
          attrs: { "data-action": "navigate-home" },
        },
      ),
    );

    rightGroup.appendChild(
      touchButton(
        doc,
        "お気に入り",
        () => {
          this.store.toggleDrawer("favorites");
        },
        {
          className: state.hud.drawer === "favorites" ? "hud-btn btn--primary" : "hud-btn",
          attrs: { "data-action": "toggle-favorites", "data-testid": "hud-favorites-btn" },
        },
      ),
    );

    if (state.hud.isYouTubePage) {
      rightGroup.appendChild(this.buildYouTubeSearchForm(doc, isStandby));
    }

    rightGroup.appendChild(
      touchButton(
        doc,
        "設定",
        () => {
          this.store.openSettingsWithAuthCheck();
        },
        {
          className: "hud-btn",
          attrs: { "data-action": "open-settings", "data-testid": "hud-settings-btn" },
        },
      ),
    );

    barInner.appendChild(leftGroup);
    barInner.appendChild(rightGroup);

    const nodes: HTMLElement[] = [barInner];
    if (state.hud.drawer === "keyboard") {
      nodes.push(this.buildKeyboardDrawer(doc, isStandby));
    } else if (state.hud.drawer === "favorites") {
      nodes.push(this.buildFavoritesDrawer(doc, state));
    }

    this.container.replaceChildren(...nodes);

    if (this.shouldFocusKeyboard) {
      this.shouldFocusKeyboard = false;
      const kbInput = this.container.querySelector(
        '[data-testid="virtual-keyboard-input"]',
      ) as HTMLInputElement | null;
      kbInput?.focus();
    }
  }

  private buildSignalBadge(doc: Document, state: AppState): HTMLElement {
    const activeBars = signalBarsActiveCount(state.hud.signalLevel);
    const bars = el(doc, "span", { className: "signal-bars" });
    for (let i = 1; i <= 4; i += 1) {
      bars.appendChild(
        el(doc, "span", {
          className:
            i <= activeBars
              ? `signal-bar signal-bar--${i} is-active`
              : `signal-bar signal-bar--${i}`,
        }),
      );
    }

    return el(
      doc,
      "span",
      {
        className: `hud-badge signal--${state.hud.signalLevel}`,
        attrs: { "data-testid": "hud-rtt-badge", "data-signal": state.hud.signalLevel },
      },
      [
        bars,
        el(doc, "span", { className: "status-dot" }),
        el(doc, "span", {
          text: formatSignalText(state),
          attrs: { "data-testid": "hud-rtt-text" },
        }),
      ],
    );
  }

  private buildYouTubeSearchForm(doc: Document, disabled: boolean): HTMLElement {
    const form = el(doc, "div", {
      className: "youtube-search-form",
      attrs: { "data-testid": "hud-youtube-search" },
    });
    const input = el(doc, "input", {
      className: "youtube-search-input",
      attrs: {
        type: "search",
        placeholder: "YouTube 検索 / URL",
        "data-testid": "hud-youtube-input",
      },
    });
    input.value = this.youtubeQueryDraft;
    input.disabled = disabled;
    input.addEventListener("input", () => {
      this.youtubeQueryDraft = input.value;
    });

    const submitBtn = touchButton(
      doc,
      "検索",
      () => {
        const targetUrl = buildYouTubeSearchUrl(this.youtubeQueryDraft);
        if (targetUrl !== null) {
          this.store.navigateToUrl(targetUrl);
        }
      },
      {
        className: "hud-btn",
        disabled,
        attrs: { "data-action": "youtube-search-submit" },
      },
    );

    form.appendChild(input);
    form.appendChild(submitBtn);
    return form;
  }

  private buildKeyboardDrawer(doc: Document, disabled: boolean): HTMLElement {
    const drawer = el(doc, "div", {
      className: "hud-drawer",
      attrs: { "data-testid": "drawer-keyboard" },
    });

    const input = el(doc, "input", {
      className: "virtual-keyboard-input",
      attrs: {
        type: "text",
        placeholder: "車載キーボードで文字を入力...",
        "data-testid": "virtual-keyboard-input",
      },
    });
    input.style.userSelect = "text";
    input.value = this.keyboardDraft;
    input.disabled = disabled;
    input.addEventListener("input", () => {
      this.keyboardDraft = input.value;
    });

    const sendKey = (key: SpecialKey) => {
      this.store.sendInputKey(key);
    };

    const row = el(doc, "div", { className: "keyboard-drawer-row" }, [
      input,
      touchButton(
        doc,
        "送信",
        () => {
          if (this.keyboardDraft.length > 0) {
            this.store.sendInputText(this.keyboardDraft);
            this.keyboardDraft = "";
            this.render(this.store.getState());
          }
        },
        {
          className: "btn btn--primary",
          disabled,
          attrs: { "data-action": "keyboard-send" },
        },
      ),
      touchButton(doc, "Enter ⏎", () => sendKey("Enter"), {
        className: "btn",
        disabled,
        attrs: { "data-action": "keyboard-enter" },
      }),
      touchButton(doc, "⌫", () => sendKey("Backspace"), {
        className: "btn",
        disabled,
        attrs: { "data-action": "keyboard-backspace" },
      }),
      touchButton(doc, "Tab ⇥", () => sendKey("Tab"), {
        className: "btn",
        disabled,
        attrs: { "data-action": "keyboard-tab" },
      }),
      touchButton(
        doc,
        "閉じる",
        () => {
          this.store.closeDrawer();
        },
        { className: "btn", attrs: { "data-action": "drawer-close" } },
      ),
    ]);

    drawer.appendChild(row);
    return drawer;
  }

  private buildFavoritesDrawer(doc: Document, state: AppState): HTMLElement {
    const drawer = el(doc, "div", {
      className: "hud-drawer",
      attrs: { "data-testid": "drawer-favorites" },
    });

    const isStandby = state.role === "SECONDARY_STANDBY";
    const favorites = state.settings?.favorites ?? [];

    const actions = el(doc, "div", { className: "favorites-drawer-actions" }, [
      touchButton(
        doc,
        "＋ 現在のページを追加",
        () => {
          void this.handleAddCurrentPage(state, favorites);
        },
        {
          className: "btn btn--primary",
          disabled: isStandby || state.settings === null,
          attrs: { "data-action": "favorites-add-current" },
        },
      ),
      touchButton(
        doc,
        "編集 / 管理",
        () => {
          this.store.closeDrawer();
          this.store.openSettingsWithAuthCheck();
        },
        { className: "btn", attrs: { "data-action": "favorites-manage" } },
      ),
      touchButton(
        doc,
        "閉じる",
        () => {
          this.store.closeDrawer();
        },
        { className: "btn", attrs: { "data-action": "drawer-close" } },
      ),
    ]);

    drawer.appendChild(actions);

    if (this.favoriteError !== null) {
      drawer.appendChild(
        el(doc, "div", {
          className: "error-banner",
          text: this.favoriteError,
          attrs: { "data-testid": "favorites-drawer-error" },
        }),
      );
    }

    const list = el(doc, "div", { className: "favorites-drawer-list" });
    for (const fav of favorites) {
      const btn = touchButton(
        doc,
        "",
        () => {
          this.store.navigateToUrl(fav.url);
          this.store.closeDrawer();
        },
        {
          className: "btn",
          disabled: isStandby,
          attrs: { "data-testid": `hud-favorite-${fav.id}` },
        },
      );
      const safeTitle = escapeHtml(fav.title);
      btn.innerHTML = fav.isHome
        ? `${safeTitle} <span class="home-badge">ホーム</span>`
        : safeTitle;
      list.appendChild(btn);
    }
    drawer.appendChild(list);

    return drawer;
  }

  private async handleAddCurrentPage(
    state: AppState,
    favorites: readonly FavoriteItem[],
  ): Promise<void> {
    const url = state.hud.currentUrl ?? "";
    const title = state.hud.currentTitle?.trim() || url;
    const id = `fav-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const result = addFavorite(favorites, { id, title, url });
    if (!result.ok) {
      this.favoriteError = result.message;
      this.render(this.store.getState());
      return;
    }
    this.favoriteError = null;
    const saved = await this.store.saveSettings({ favorites: result.value });
    if (!saved) {
      this.favoriteError = this.store.getState().errorBanner ?? "保存に失敗しました";
      this.render(this.store.getState());
    }
  }
}
