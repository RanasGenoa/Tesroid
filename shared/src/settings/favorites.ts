import type { FavoriteItem, SettingsValidationResult } from "./schema.js";

// Spec: docs/specs/06-browser-input-cdp.md#2.1
export function isAllowedHttpUrl(url: string): boolean {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/07-ui-hud-settings.md#2.1
export function isStrictYouTubeUrl(url: string): boolean {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/07-ui-hud-settings.md#2.3
export function validateFavorites(
  favorites: unknown,
): SettingsValidationResult<readonly FavoriteItem[]> {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/07-ui-hud-settings.md#2.3
export function addFavorite(
  favorites: readonly FavoriteItem[],
  item: Omit<FavoriteItem, "isHome">,
): SettingsValidationResult<readonly FavoriteItem[]> {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/07-ui-hud-settings.md#2.3
export function setHomeFavorite(
  favorites: readonly FavoriteItem[],
  id: string,
): readonly FavoriteItem[] {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/07-ui-hud-settings.md#2.3
export function removeFavorite(
  favorites: readonly FavoriteItem[],
  id: string,
): readonly FavoriteItem[] {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/06-browser-input-cdp.md#2.1
export function resolveHomeUrl(favorites: readonly FavoriteItem[]): string {
  throw new Error("NOT_IMPLEMENTED");
}
