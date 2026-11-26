export const PROHIBITED_CHROME_FLAGS = [
  "--enable-gpu-rasterization",
  "--enable-zero-copy",
  "--disable-gpu-vsync",
] as const;

export interface PageScriptConfig {
  readonly displayScale: number;
}

// Spec: docs/specs/06-browser-input-cdp.md#2.3
export function buildWebAuthnSuppressionScript(): string {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/06-browser-input-cdp.md#2.4
export function buildDisplayScaleScript(displayScale: number): string {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/06-browser-input-cdp.md#2.4
export function buildVirtualFullscreenScript(): string {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/06-browser-input-cdp.md#2.4
export function buildVolumeLockScript(): string {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/06-browser-input-cdp.md#2.4
export function buildCombinedPageInitScript(config: PageScriptConfig): string {
  throw new Error("NOT_IMPLEMENTED");
}
