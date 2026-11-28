import {
  addFavorite,
  type FavoriteItem,
  removeFavorite,
  setHomeFavorite,
  validateFavorites,
} from "@tesroid/shared";
import { el, touchButton } from "../../dom.js";
import { escapeHtml } from "../../escape.js";
import type { BrowserTabState } from "./browser-tab.js";
import type { SettingsTabContext } from "./context.js";

export async function persistFavorites(
  ctx: SettingsTabContext,
  tab: BrowserTabState,
  nextFavorites: readonly FavoriteItem[],
): Promise<boolean> {
  tab.error = null;
  const ok = await ctx.store.saveSettings({ favorites: nextFavorites });
  if (!ok) {
    tab.error = ctx.store.getState().errorBanner ?? "お気に入りの保存に失敗しました";
    ctx.rerender();
    return false;
  }
  return true;
}

export async function handleAddFavorite(
  ctx: SettingsTabContext,
  tab: BrowserTabState,
  favorites: readonly FavoriteItem[],
  title: string,
  url: string,
): Promise<void> {
  const id = `fav-${ctx.clock.nowMs()}-${Math.random().toString(36).slice(2, 6)}`;
  const result = addFavorite(favorites, { id, title, url });
  if (!result.ok) {
    tab.error = result.message;
    ctx.rerender();
    return;
  }
  const ok = await persistFavorites(ctx, tab, result.value);
  if (ok) {
    tab.newFavTitleDraft = "";
    tab.newFavUrlDraft = "";
  }
}

export async function handleSaveEditedFavorite(
  ctx: SettingsTabContext,
  tab: BrowserTabState,
  favorites: readonly FavoriteItem[],
  targetId: string,
): Promise<void> {
  const updated = favorites.map((item) =>
    item.id === targetId ? { ...item, title: tab.editingFavTitle, url: tab.editingFavUrl } : item,
  );
  const validation = validateFavorites(updated);
  if (!validation.ok) {
    tab.error = validation.message;
    ctx.rerender();
    return;
  }
  const ok = await persistFavorites(ctx, tab, validation.value);
  if (ok) {
    tab.editingFavId = null;
  }
}

export async function moveFavorite(
  ctx: SettingsTabContext,
  tab: BrowserTabState,
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
  await persistFavorites(ctx, tab, next);
}

export function renderFavoriteRow(
  doc: Document,
  ctx: SettingsTabContext,
  tab: BrowserTabState,
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
        ctx.store.navigateToUrl(fav.url);
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
        void persistFavorites(ctx, tab, setHomeFavorite(favorites, fav.id));
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
        void moveFavorite(ctx, tab, favorites, index, -1);
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
        void moveFavorite(ctx, tab, favorites, index, 1);
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
        tab.editingFavId = fav.id;
        tab.editingFavTitle = fav.title;
        tab.editingFavUrl = fav.url;
        tab.error = null;
        ctx.rerender();
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
        void persistFavorites(ctx, tab, removeFavorite(favorites, fav.id));
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

export function renderFavoriteEditRow(
  doc: Document,
  ctx: SettingsTabContext,
  tab: BrowserTabState,
  favorites: readonly FavoriteItem[],
  fav: FavoriteItem,
): HTMLElement {
  const titleInput = el(doc, "input", {
    className: "form-input",
    attrs: { type: "text", "data-testid": "fav-edit-title" },
  });
  titleInput.value = tab.editingFavTitle;
  titleInput.addEventListener("input", () => {
    tab.editingFavTitle = titleInput.value;
  });

  const urlInput = el(doc, "input", {
    className: "form-input",
    attrs: { type: "url", "data-testid": "fav-edit-url" },
  });
  urlInput.value = tab.editingFavUrl;
  urlInput.addEventListener("input", () => {
    tab.editingFavUrl = urlInput.value;
  });

  return el(doc, "div", { className: "favorite-row" }, [
    titleInput,
    urlInput,
    el(doc, "div", { className: "row-actions" }, [
      touchButton(
        doc,
        "保存",
        () => {
          void handleSaveEditedFavorite(ctx, tab, favorites, fav.id);
        },
        { className: "btn btn--primary", attrs: { "data-action": "fav-edit-save" } },
      ),
      touchButton(
        doc,
        "キャンセル",
        () => {
          tab.editingFavId = null;
          tab.error = null;
          ctx.rerender();
        },
        { className: "btn", attrs: { "data-action": "fav-edit-cancel" } },
      ),
    ]),
  ]);
}
