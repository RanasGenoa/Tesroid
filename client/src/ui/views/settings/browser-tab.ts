import { DEFAULT_FAVORITES, isAllowedHttpUrl } from "@tesroid/shared";
import type { AppState } from "../../../state/index.js";
import { el, touchButton } from "../../dom.js";
import { type SettingsTabContext, TWO_TAP_WINDOW_MS } from "./context.js";
import {
  handleAddFavorite,
  persistFavorites,
  renderFavoriteEditRow,
  renderFavoriteRow,
} from "./favorites-section.js";

export interface BrowserTabState {
  directUrlDraft: string;
  newFavTitleDraft: string;
  newFavUrlDraft: string;
  editingFavId: string | null;
  editingFavTitle: string;
  editingFavUrl: string;
  error: string | null;
  resetPresetsArmedUntilMs: number | null;
}

export function createBrowserTabState(): BrowserTabState {
  return {
    directUrlDraft: "",
    newFavTitleDraft: "",
    newFavUrlDraft: "",
    editingFavId: null,
    editingFavTitle: "",
    editingFavUrl: "",
    error: null,
    resetPresetsArmedUntilMs: null,
  };
}

export function resetBrowserTabState(tab: BrowserTabState): void {
  tab.directUrlDraft = "";
  tab.newFavTitleDraft = "";
  tab.newFavUrlDraft = "";
  tab.editingFavId = null;
  tab.editingFavTitle = "";
  tab.editingFavUrl = "";
  tab.error = null;
  tab.resetPresetsArmedUntilMs = null;
}

async function handlePresetResetTap(ctx: SettingsTabContext, tab: BrowserTabState): Promise<void> {
  const nowMs = ctx.clock.nowMs();
  if (tab.resetPresetsArmedUntilMs !== null && nowMs <= tab.resetPresetsArmedUntilMs) {
    tab.resetPresetsArmedUntilMs = null;
    await persistFavorites(ctx, tab, DEFAULT_FAVORITES);
    return;
  }
  tab.resetPresetsArmedUntilMs = nowMs + TWO_TAP_WINDOW_MS;
  ctx.rerender();
}

export function renderBrowserTab(
  doc: Document,
  state: AppState,
  ctx: SettingsTabContext,
  tab: BrowserTabState,
): HTMLElement {
  const root = el(doc, "div", {
    className: "form-field",
    attrs: { "data-testid": "settings-tab-browser" },
  });
  const favorites = state.settings?.favorites ?? [];
  const isStandby = state.role === "SECONDARY_STANDBY";

  if (tab.error !== null) {
    root.appendChild(
      el(doc, "div", {
        className: "error-banner",
        text: tab.error,
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
  navInput.value = tab.directUrlDraft;
  navInput.addEventListener("input", () => {
    tab.directUrlDraft = navInput.value;
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
            const trimmed = tab.directUrlDraft.trim();
            if (!isAllowedHttpUrl(trimmed)) {
              tab.error = "有効な http(s):// URL を入力してください";
              ctx.rerender();
              return;
            }
            tab.error = null;
            ctx.store.navigateToUrl(trimmed);
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
  addTitleInput.value = tab.newFavTitleDraft;
  addTitleInput.addEventListener("input", () => {
    tab.newFavTitleDraft = addTitleInput.value;
  });

  const addUrlInput = el(doc, "input", {
    className: "form-input",
    attrs: {
      type: "url",
      placeholder: "https://...",
      "data-testid": "settings-fav-add-url",
    },
  });
  addUrlInput.value = tab.newFavUrlDraft;
  addUrlInput.addEventListener("input", () => {
    tab.newFavUrlDraft = addUrlInput.value;
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
            void handleAddFavorite(
              ctx,
              tab,
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
            void handleAddFavorite(ctx, tab, favorites, tab.newFavTitleDraft, tab.newFavUrlDraft);
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
    if (tab.editingFavId === fav.id) {
      listWrap.appendChild(renderFavoriteEditRow(doc, ctx, tab, favorites, fav));
    } else {
      listWrap.appendChild(renderFavoriteRow(doc, ctx, tab, favorites, fav, index, isStandby));
    }
  }
  root.appendChild(listWrap);

  const nowMs = ctx.clock.nowMs();
  const isResetArmed =
    tab.resetPresetsArmedUntilMs !== null && nowMs <= tab.resetPresetsArmedUntilMs;
  root.appendChild(
    el(doc, "div", { className: "row-actions" }, [
      touchButton(
        doc,
        isResetArmed ? "もう一度タップしてプリセット初期化を確定" : "プリセット初期化",
        () => {
          void handlePresetResetTap(ctx, tab);
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
