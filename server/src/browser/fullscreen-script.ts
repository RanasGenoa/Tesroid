import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const FULLSCREEN_CORE_START_MARKER = '// === TESROID_FULLSCREEN_CORE_START ===';
export const FULLSCREEN_CORE_END_MARKER = '// === TESROID_FULLSCREEN_CORE_END ===';

const cachedSections = new Map<string, string>();

export function resolveContentScriptPath(): string {
  const candidates = [
    path.resolve(__dirname, '../../extension/content.js'),
    path.resolve(__dirname, '../extension/content.js'),
    path.resolve(__dirname, '../../../server/extension/content.js'),
    path.resolve('/app/server/extension/content.js'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `[content-script-loader] Could not locate server/extension/content.js in candidates: ${candidates.join(', ')}`,
    );
  }
  return found;
}

/**
 * Extracts and caches a marker-delimited section from `server/extension/content.js`
 * so BrowserManager, CdpTouchBridge, and the Chrome MV3 extension share one Single Source of Truth.
 */
export function loadContentScriptSection(
  startMarker: string,
  endMarker: string,
  sectionLabel = 'section',
): string {
  const cacheKey = `${startMarker}\0${endMarker}`;
  const cached = cachedSections.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const contentScriptPath = resolveContentScriptPath();
  const source = fs.readFileSync(contentScriptPath, 'utf-8');
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`[${sectionLabel}] Missing ${startMarker} marker in ${contentScriptPath}`);
  }

  const bodyStart = startIdx + startMarker.length;
  const endIdx = source.indexOf(endMarker, bodyStart);
  if (endIdx === -1) {
    throw new Error(`[${sectionLabel}] Missing ${endMarker} marker in ${contentScriptPath}`);
  }

  const extracted = source.slice(bodyStart, endIdx).trim();
  if (!extracted) {
    throw new Error(`[${sectionLabel}] Empty block between markers in ${contentScriptPath}`);
  }

  cachedSections.set(cacheKey, extracted);
  return extracted;
}

/**
 * Loads the canonical fullscreen & zoom controller block from `server/extension/content.js`
 * so BrowserManager, CdpTouchBridge, and the Chrome MV3 extension share one Single Source of Truth.
 */
export function loadFullscreenCoreScript(): string {
  return loadContentScriptSection(
    FULLSCREEN_CORE_START_MARKER,
    FULLSCREEN_CORE_END_MARKER,
    'fullscreen-script',
  );
}

export function clampDisplayScale(scalePercent: unknown): number {
  const num = Number(scalePercent);
  return !Number.isNaN(num) && num >= 50 && num <= 250 ? Math.round(num) : 120;
}

/**
 * Generates the browser-side Web Fullscreen + Car Display Zoom script.
 * When `displayScale` is provided (from BrowserManager), updates the configured zoom
 * even if the fullscreen controller was already installed by content.js.
 */
export function buildCarFullscreenScript(displayScale?: number): string {
  const hasExplicitScale = displayScale !== undefined;
  const clampedScale = hasExplicitScale ? clampDisplayScale(displayScale) : 120;

  const scalePrelude = hasExplicitScale
    ? `
    window.__tesroidDisplayScale = ${clampedScale};
    if (typeof window.tesroidSetZoom === 'function') {
      window.tesroidSetZoom(${clampedScale});
    }`
    : `
    if (typeof window.__tesroidDisplayScale !== 'number') {
      window.__tesroidDisplayScale = 120;
    }`;

  return `${scalePrelude}\n\n${loadFullscreenCoreScript()}`;
}
