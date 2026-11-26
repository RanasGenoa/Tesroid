import type { AppState, AppStore } from "../../state/index.js";

export class ViewportOverlayView {
  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  constructor(store: AppStore) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  mount(container: HTMLElement): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  unmount(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  render(state: AppState): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
