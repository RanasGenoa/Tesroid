import type { AppState, AppStore } from "../../state/index.js";

export class PinAndStatusViews {
  // Spec: docs/specs/01-auth-security.md#2.2
  constructor(store: AppStore) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  mount(container: HTMLElement): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  unmount(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  render(state: AppState): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
