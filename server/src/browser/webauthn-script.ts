import { loadContentScriptSection } from './fullscreen-script.js';

export const WEBAUTHN_CORE_START_MARKER = '// === TESROID_WEBAUTHN_CORE_START ===';
export const WEBAUTHN_CORE_END_MARKER = '// === TESROID_WEBAUTHN_CORE_END ===';

/**
 * Loads the canonical WebAuthn / Passkey suppressor block from `server/extension/content.js`
 * so BrowserManager, CdpTouchBridge, and the Chrome MV3 extension share one Single Source of Truth.
 */
export function loadWebAuthnCoreScript(): string {
  return loadContentScriptSection(
    WEBAUTHN_CORE_START_MARKER,
    WEBAUTHN_CORE_END_MARKER,
    'webauthn-script',
  );
}

/**
 * Generates the browser-side WebAuthn / Passkey Dialog Suppressor script.
 */
export function buildWebAuthnSuppressorScript(): string {
  return loadWebAuthnCoreScript();
}
