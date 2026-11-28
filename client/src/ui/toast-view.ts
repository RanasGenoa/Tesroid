// Spec: docs/specs/07-ui-hud-settings.md#2.4 (AC-07) — 下部中央のアプリ共通トースト。
// 車載は完全タッチオンリーのため、ネイティブダイアログの代替として 1 操作 1 回の確認応答を返す。

export type ToastKind = "info" | "success" | "error";

const TOAST_AUTO_DISMISS_MS = 2_800;
const TOAST_MAX_VISIBLE = 3;

const TOAST_ICONS: Record<ToastKind, string> = {
  info: "ℹ",
  success: "✓",
  error: "✕",
};

const toastHosts = new WeakMap<Document, HTMLElement>();

function ensureHost(doc: Document): HTMLElement | null {
  const existing = toastHosts.get(doc);
  if (existing !== undefined && existing.parentNode !== null) {
    return existing;
  }
  const body = doc.body;
  if (body === undefined || body === null) {
    return null;
  }
  const host = doc.createElement("div");
  host.className = "toast-host";
  host.setAttribute("data-testid", "app-toast-host");
  body.appendChild(host);
  toastHosts.set(doc, host);
  return host;
}

export function showToast(doc: Document, message: string, kind: ToastKind = "info"): void {
  const container = ensureHost(doc);
  if (container === null) {
    return;
  }
  while (container.children.length >= TOAST_MAX_VISIBLE) {
    container.removeChild(container.children[0] as Node);
  }

  const toast = doc.createElement("div");
  toast.className = `toast toast--${kind}`;
  toast.setAttribute("data-testid", "app-toast");
  const icon = doc.createElement("span");
  icon.className = "toast__icon";
  icon.textContent = TOAST_ICONS[kind];
  const text = doc.createElement("span");
  text.className = "toast__text";
  text.textContent = message;
  toast.appendChild(icon);
  toast.appendChild(text);
  container.appendChild(toast);

  globalThis.setTimeout(() => {
    if (toast.parentNode !== null) {
      toast.parentNode.removeChild(toast);
    }
  }, TOAST_AUTO_DISMISS_MS);
}
