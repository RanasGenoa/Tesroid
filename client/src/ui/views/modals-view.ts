import { AUTH_SECURITY_CONSTANTS, isValidPin } from "@tesroid/shared";
import { type AppState, type AppStore, isPrimaryAuthorityRole } from "../../state/index.js";
import { el, getDoc, touchButton } from "../dom.js";
import { buildOnboardingGuideElement } from "../guide-content.js";

export class AppModalsView {
  private readonly store: AppStore;
  private container: HTMLElement | null = null;
  private reauthPinBuffer = "";
  private reauthError: string | null = null;
  private lastModalKind = "none";

  // Spec: docs/specs/07-ui-hud-settings.md#2.2
  constructor(store: AppStore) {
    this.store = store;
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.2
  mount(container: HTMLElement): void {
    this.container = container;
    this.render(this.store.getState());
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.2
  unmount(): void {
    if (this.container !== null) {
      this.container.replaceChildren();
    }
    this.container = null;
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.2
  render(state: AppState): void {
    if (this.container === null) {
      return;
    }

    const modalKind = state.activeModal.kind;
    if (modalKind === "none" || modalKind === "settings") {
      if (this.lastModalKind !== modalKind) {
        this.reauthPinBuffer = "";
        this.reauthError = null;
      }
      this.lastModalKind = modalKind;
      if (modalKind === "none") {
        this.container.replaceChildren();
      }
      return;
    }

    if (this.lastModalKind !== modalKind && modalKind === "pin_reauth") {
      this.reauthPinBuffer = "";
      this.reauthError = null;
    }
    this.lastModalKind = modalKind;

    const doc = getDoc(this.container);
    const backdrop = el(doc, "div", {
      className: "modal-backdrop",
      attrs: { "data-testid": `modal-backdrop-${modalKind}` },
    });
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        this.store.closeModal();
      }
    });

    const card = el(doc, "section", {
      className: "modal-card",
      attrs: { "data-testid": `modal-${modalKind}` },
    });

    switch (state.activeModal.kind) {
      case "onboarding_guide":
        card.appendChild(
          el(doc, "div", { className: "screen-topbar" }, [
            el(doc, "strong", { text: "操作ガイド" }),
            touchButton(doc, "閉じる", () => this.store.closeModal(), {
              className: "btn",
              attrs: { "data-action": "close-modal" },
            }),
          ]),
        );
        card.appendChild(buildOnboardingGuideElement(doc));
        break;

      case "power_control": {
        const isPrimary = isPrimaryAuthorityRole(state.role);
        card.appendChild(
          el(doc, "div", { className: "screen-topbar" }, [
            el(doc, "strong", { text: "省電力 & リソース制御" }),
            touchButton(doc, "閉じる", () => this.store.closeModal(), {
              className: "btn",
              attrs: { "data-action": "close-modal" },
            }),
          ]),
        );
        card.appendChild(
          el(doc, "p", {
            text: "操作を選択してください（後席待機中および通常セカンダリでは停止・再起動は無効です）。",
          }),
        );
        card.appendChild(
          el(doc, "div", { className: "form-field" }, [
            touchButton(
              doc,
              "ワンタップ停止",
              () => {
                void this.store.sleepSystem();
              },
              {
                className: "btn btn--warn",
                disabled: !isPrimary,
                attrs: { "data-action": "power-sleep" },
              },
            ),
            touchButton(
              doc,
              "ブラウザ＆配信再起動",
              () => {
                this.store.openModal({ kind: "restart_confirm" });
              },
              {
                className: "btn btn--primary",
                disabled: !isPrimary,
                attrs: { "data-action": "power-restart-open" },
              },
            ),
            touchButton(
              doc,
              "セッション切断",
              () => {
                this.store.disconnectExplicit();
              },
              {
                className: "btn btn--danger",
                attrs: { "data-action": "power-disconnect" },
              },
            ),
          ]),
        );
        break;
      }

      case "restart_confirm":
        card.appendChild(
          el(doc, "div", { className: "screen-topbar" }, [
            el(doc, "strong", { text: "ブラウザ＆配信再起動の確認" }),
          ]),
        );
        card.appendChild(
          el(doc, "p", {
            text: "仮想ブラウザと映像・音声エンコーダを再起動します。よろしいですか？",
          }),
        );
        card.appendChild(
          el(doc, "div", { className: "row-actions" }, [
            touchButton(doc, "キャンセル", () => this.store.closeModal(), {
              className: "btn",
              attrs: { "data-action": "restart-cancel" },
            }),
            touchButton(
              doc,
              "再起動を実行",
              () => {
                void this.store.restartBrowser();
              },
              {
                className: "btn btn--danger",
                attrs: { "data-action": "restart-execute" },
              },
            ),
          ]),
        );
        break;

      case "pin_reauth": {
        const isWarning =
          state.remainingPinAttempts < AUTH_SECURITY_CONSTANTS.warningRemainingThreshold;
        card.appendChild(
          el(doc, "div", { className: "screen-topbar" }, [
            el(doc, "strong", { text: "設定コンソール PIN 再認証" }),
            touchButton(doc, "閉じる", () => this.store.closeModal(), {
              className: "btn",
              attrs: { "data-action": "close-modal" },
            }),
          ]),
        );
        card.appendChild(
          el(doc, "div", {
            className: isWarning ? "attempts-badge attempts-badge--warn" : "attempts-badge",
            text: `残り試行回数: ${state.remainingPinAttempts} 回`,
            attrs: { "data-testid": "reauth-attempts" },
          }),
        );
        const err = this.reauthError ?? state.errorBanner;
        if (err !== null) {
          card.appendChild(
            el(doc, "div", {
              className: "error-banner",
              text: err,
              attrs: { "data-testid": "reauth-error" },
            }),
          );
        }
        card.appendChild(
          el(doc, "div", {
            className: "pin-display",
            text:
              this.reauthPinBuffer.length > 0
                ? "●".repeat(this.reauthPinBuffer.length)
                : "PIN を入力",
            attrs: { "data-testid": "reauth-pin-display" },
          }),
        );
        const keypad = el(doc, "div", {
          className: "keypad-grid",
          attrs: { "data-testid": "reauth-keypad" },
        });
        const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "クリア", "0", "⌫"];
        for (const key of keys) {
          keypad.appendChild(
            touchButton(
              doc,
              key,
              () => {
                this.handleReauthKey(key);
              },
              { className: "btn keypad-btn", attrs: { "data-reauth-key": key } },
            ),
          );
        }
        card.appendChild(keypad);
        card.appendChild(
          el(doc, "div", { className: "row-actions" }, [
            touchButton(doc, "キャンセル", () => this.store.closeModal(), {
              className: "btn",
              attrs: { "data-action": "reauth-cancel" },
            }),
            touchButton(
              doc,
              "認証",
              () => {
                void this.submitReauth();
              },
              { className: "btn btn--primary", attrs: { "data-action": "reauth-submit" } },
            ),
          ]),
        );
        break;
      }
    }

    backdrop.appendChild(card);
    this.container.replaceChildren(backdrop);
  }

  private handleReauthKey(key: string): void {
    this.reauthError = null;
    if (key === "クリア") {
      this.reauthPinBuffer = "";
    } else if (key === "⌫") {
      this.reauthPinBuffer = this.reauthPinBuffer.slice(0, -1);
    } else if (this.reauthPinBuffer.length < 8) {
      this.reauthPinBuffer += key;
    }
    this.render(this.store.getState());
  }

  private async submitReauth(): Promise<void> {
    if (!isValidPin(this.reauthPinBuffer)) {
      this.reauthError = "PIN は 4〜8 桁の半角数字で入力してください";
      this.render(this.store.getState());
      return;
    }
    this.reauthError = null;
    const ok = await this.store.submitPinReauth(this.reauthPinBuffer);
    if (!ok) {
      this.reauthPinBuffer = "";
      this.render(this.store.getState());
    }
  }
}
