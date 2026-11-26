import { DEFAULT_HOME_URL, MAX_FAVORITES } from "./constants.js";
import type { FavoriteItem, SettingsValidationResult } from "./schema.js";

interface UrlLike {
  readonly protocol: string;
  readonly hostname: string;
  readonly href: string;
}

type UrlCtor = new (input: string) => UrlLike;

function isUrlConstructor(value: unknown): value is UrlCtor {
  return typeof value === "function";
}

function getUrlConstructor(): UrlCtor {
  const ctor: unknown = Object.getOwnPropertyDescriptor(globalThis, "URL")?.value;
  if (!isUrlConstructor(ctor)) {
    throw new Error("Global URL constructor is unavailable");
  }
  return ctor;
}

const UrlConstructor = getUrlConstructor();

function parseHttpUrl(url: string): UrlLike | null {
  if (typeof url !== "string" || url.length === 0 || url.trim() !== url) {
    return null;
  }
  try {
    const parsed = new UrlConstructor(url);
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Spec: docs/specs/06-browser-input-cdp.md#2.1
export function isAllowedHttpUrl(url: string): boolean {
  return parseHttpUrl(url) !== null;
}

// Spec: docs/specs/07-ui-hud-settings.md#2.1
export function isStrictYouTubeUrl(url: string): boolean {
  const parsed = parseHttpUrl(url);
  if (parsed === null) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return (
    host === "youtube.com" ||
    host === "youtu.be" ||
    (host.endsWith(".youtube.com") && host.length > ".youtube.com".length)
  );
}

// Spec: docs/specs/07-ui-hud-settings.md#2.3
export function validateFavorites(
  favorites: unknown,
): SettingsValidationResult<readonly FavoriteItem[]> {
  if (!Array.isArray(favorites)) {
    return {
      ok: false,
      code: "INVALID_FAVORITE",
      message: "favorites must be an array",
      field: "favorites",
    };
  }
  if (favorites.length > MAX_FAVORITES) {
    return {
      ok: false,
      code: "FAVORITES_LIMIT_EXCEEDED",
      message: `favorites cannot exceed ${MAX_FAVORITES} items`,
      field: "favorites",
    };
  }

  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const normalized: FavoriteItem[] = [];
  let hasHome = false;

  for (let index = 0; index < favorites.length; index += 1) {
    const entry: unknown = favorites[index];
    if (!isRecord(entry)) {
      return {
        ok: false,
        code: "INVALID_FAVORITE",
        message: `Favorite at index ${index} must be an object`,
        field: `favorites[${index}]`,
      };
    }
    if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
      return {
        ok: false,
        code: "INVALID_FAVORITE",
        message: `Favorite id at index ${index} must be a non-empty string`,
        field: `favorites[${index}].id`,
      };
    }
    const id = entry.id.trim();
    if (seenIds.has(id)) {
      return {
        ok: false,
        code: "INVALID_FAVORITE",
        message: `Duplicate favorite id: ${id}`,
        field: `favorites[${index}].id`,
      };
    }
    if (typeof entry.title !== "string" || entry.title.trim().length === 0) {
      return {
        ok: false,
        code: "INVALID_FAVORITE",
        message: `Favorite title at index ${index} must be a non-empty string`,
        field: `favorites[${index}].title`,
      };
    }
    if (typeof entry.url !== "string") {
      return {
        ok: false,
        code: "INVALID_FAVORITE",
        message: `Favorite url at index ${index} must be a string`,
        field: `favorites[${index}].url`,
      };
    }
    const trimmedUrl = entry.url.trim();
    const parsedUrl = parseHttpUrl(trimmedUrl);
    if (parsedUrl === null) {
      return {
        ok: false,
        code: "INVALID_URL_SCHEME",
        message: `Favorite url at index ${index} must be a valid http/https URL`,
        field: `favorites[${index}].url`,
      };
    }
    if (seenUrls.has(parsedUrl.href)) {
      return {
        ok: false,
        code: "DUPLICATE_FAVORITE_URL",
        message: `Duplicate favorite URL: ${trimmedUrl}`,
        field: `favorites[${index}].url`,
      };
    }
    if (typeof entry.isHome !== "boolean") {
      return {
        ok: false,
        code: "INVALID_FAVORITE",
        message: `Favorite isHome at index ${index} must be a boolean`,
        field: `favorites[${index}].isHome`,
      };
    }

    seenIds.add(id);
    seenUrls.add(parsedUrl.href);

    const isHome = entry.isHome && !hasHome;
    if (isHome) {
      hasHome = true;
    }

    normalized.push({
      id,
      title: entry.title.trim(),
      url: trimmedUrl,
      isHome,
    });
  }

  return { ok: true, value: normalized };
}

// Spec: docs/specs/07-ui-hud-settings.md#2.3
export function addFavorite(
  favorites: readonly FavoriteItem[],
  item: Omit<FavoriteItem, "isHome">,
): SettingsValidationResult<readonly FavoriteItem[]> {
  if (favorites.length >= MAX_FAVORITES) {
    return {
      ok: false,
      code: "FAVORITES_LIMIT_EXCEEDED",
      message: `favorites cannot exceed ${MAX_FAVORITES} items`,
      field: "favorites",
    };
  }
  if (typeof item.id !== "string" || item.id.trim().length === 0) {
    return {
      ok: false,
      code: "INVALID_FAVORITE",
      message: "Favorite id must be a non-empty string",
      field: "id",
    };
  }
  const id = item.id.trim();
  if (favorites.some((existing) => existing.id === id)) {
    return {
      ok: false,
      code: "INVALID_FAVORITE",
      message: `Duplicate favorite id: ${id}`,
      field: "id",
    };
  }
  if (typeof item.title !== "string" || item.title.trim().length === 0) {
    return {
      ok: false,
      code: "INVALID_FAVORITE",
      message: "Favorite title must be a non-empty string",
      field: "title",
    };
  }
  const trimmedUrl = typeof item.url === "string" ? item.url.trim() : "";
  const parsedUrl = parseHttpUrl(trimmedUrl);
  if (parsedUrl === null) {
    return {
      ok: false,
      code: "INVALID_URL_SCHEME",
      message: "Favorite url must be a valid http/https URL",
      field: "url",
    };
  }

  for (const existing of favorites) {
    const parsedExisting = parseHttpUrl(existing.url.trim());
    if (parsedExisting !== null && parsedExisting.href === parsedUrl.href) {
      return {
        ok: false,
        code: "DUPLICATE_FAVORITE_URL",
        message: `Duplicate favorite URL: ${trimmedUrl}`,
        field: "url",
      };
    }
  }

  const newEntry: FavoriteItem = {
    id,
    title: item.title.trim(),
    url: trimmedUrl,
    isHome: false,
  };
  const insertIndex = favorites[0]?.isHome === true ? 1 : 0;
  const next = [...favorites];
  next.splice(insertIndex, 0, newEntry);
  return { ok: true, value: next };
}

// Spec: docs/specs/07-ui-hud-settings.md#2.3
export function setHomeFavorite(
  favorites: readonly FavoriteItem[],
  id: string,
): readonly FavoriteItem[] {
  const target = favorites.find((item) => item.id === id);
  if (target === undefined) {
    return favorites;
  }

  const others = favorites
    .filter((item) => item.id !== id)
    .map((item) => (item.isHome ? { ...item, isHome: false } : item));

  return [{ ...target, isHome: true }, ...others];
}

// Spec: docs/specs/07-ui-hud-settings.md#2.3
export function removeFavorite(
  favorites: readonly FavoriteItem[],
  id: string,
): readonly FavoriteItem[] {
  const target = favorites.find((item) => item.id === id);
  if (target === undefined) {
    return favorites;
  }

  const remaining = favorites.filter((item) => item.id !== id);
  if (!target.isHome || remaining.length === 0) {
    return remaining;
  }

  return remaining.map((item, index) => ({
    ...item,
    isHome: index === 0,
  }));
}

// Spec: docs/specs/06-browser-input-cdp.md#2.1
export function resolveHomeUrl(favorites: readonly FavoriteItem[]): string {
  const home = favorites.find((item) => item.isHome && isAllowedHttpUrl(item.url));
  return home !== undefined ? home.url : DEFAULT_HOME_URL;
}
