import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const FULLSCREEN_CORE_START_MARKER = '// === TESROID_FULLSCREEN_CORE_START ===';
export const FULLSCREEN_CORE_END_MARKER = '// === TESROID_FULLSCREEN_CORE_END ===';

let cachedFullscreenCoreScript: string | null = null;

function resolveContentScriptPath(): string {
  const candidates = [
    path.resolve(__dirname, '../../extension/content.js'),
    path.resolve(__dirname, '../extension/content.js'),
    path.resolve(__dirname, '../../../server/extension/content.js'),
    path.resolve('/app/server/extension/content.js'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `[fullscreen-script] Could not locate server/extension/content.js in candidates: ${candidates.join(', ')}`,
    );
  }
  return found;
}

/**
 * Loads the canonical fullscreen & zoom controller block from `server/extension/content.js`
 * so BrowserManager, CdpTouchBridge, and the Chrome MV3 extension share one Single Source of Truth.
 */
export function loadFullscreenCoreScript(): string {
  if (cachedFullscreenCoreScript !== null) {
    return cachedFullscreenCoreScript;
  }

  const contentScriptPath = resolveContentScriptPath();
  const source = fs.readFileSync(contentScriptPath, 'utf-8');
  const startIdx = source.indexOf(FULLSCREEN_CORE_START_MARKER);
  if (startIdx === -1) {
    throw new Error(
      `[fullscreen-script] Missing ${FULLSCREEN_CORE_START_MARKER} marker in ${contentScriptPath}`,
    );
  }

  const bodyStart = startIdx + FULLSCREEN_CORE_START_MARKER.length;
  const endIdx = source.indexOf(FULLSCREEN_CORE_END_MARKER, bodyStart);
  if (endIdx === -1) {
    throw new Error(
      `[fullscreen-script] Missing ${FULLSCREEN_CORE_END_MARKER} marker in ${contentScriptPath}`,
    );
  }

  const extracted = source.slice(bodyStart, endIdx).trim();
  if (!extracted) {
    throw new Error(
      `[fullscreen-script] Empty fullscreen core block between markers in ${contentScriptPath}`,
    );
  }

  cachedFullscreenCoreScript = extracted;
  return extracted;
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
