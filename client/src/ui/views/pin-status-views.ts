import { AUTH_SECURITY_CONSTANTS, isValidPin } from "@tesroid/shared";
import type { AppRoute, AppState, AppStore } from "../../state/index.js";
import { el, getDoc, touchButton } from "../dom.js";

export class PinAndStatusViews {
  private readonly store: AppStore;
  private container: HTMLElement | null = null;
  private pinBuffer = "";
  private menuOpen = false;
  private localError: string | null = null;
  private lastRoute: AppRoute | null = null;

  // Spec: docs/specs/01-auth-security.md#2.2
  constructor(store: AppStore) {
    this.store = store;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  mount(container: HTMLElement): void {
    this.container = container;
    this.render(this.store.getState());
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  unmount(): void {
    if (this.container !== null) {
      this.container.replaceChildren();
    }
    this.container = null;
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  render(state: AppState): void {
    if (this.container === null) {
      return;
    }

    if (state.route === "STREAMING" || state.route === "SETUP") {
      if (this.lastRoute !== state.route) {
        this.pinBuffer = "";
        this.menuOpen = false;
        this.localError = null;
      }
      this.lastRoute = state.route;
      this.container.replaceChildren();
      this.container.className = "";
      return;
    }

    if (this.lastRoute !== state.route && state.route === "PIN") {
      this.pinBuffer = "";
      this.localError = null;
    }
    this.lastRoute = state.route;

    const doc = getDoc(this.container);
    this.container.className = "screen-shell";

    switch (state.route) {
      case "CONNECTING":
        this.container.replaceChildren(
          el(
            doc,
            "section",
            { className: "screen-card", attrs: { "data-testid": "route-connecting" } },
            [
              el(doc, "h2", { text: "接続中..." }),
              el(doc, "p", { text: "サーバーへ接続しています。" }),
            ],
          ),
        );
        return;

      case "CONNECTION_ERROR":
        this.container.replaceChildren(
          el(
            doc,
            "section",
            { className: "screen-card", attrs: { "data-testid": "route-connection-error" } },
            [
              el(doc, "h2", { text: "接続エラー" }),
              el(doc, "p", {
                text: "サーバーに接続できません（ロックアウト停止中または起動中の可能性があります）",
              }),
              ...(state.errorBanner !== null
                ? [el(doc, "div", { className: "error-banner", text: state.errorBanner })]
                : []),
              el(doc, "div", { className: "row-actions" }, [
                touchButton(
                  doc,
                  "再試行",
                  () => {
                    void this.store.bootstrap();
                  },
                  { className: "btn btn--primary", attrs: { "data-action": "retry-bootstrap" } },
                ),
              ]),
            ],
          ),
        );
        return;

      case "LOCKED":
        this.container.replaceChildren(
          el(
            doc,
            "section",
            { className: "screen-card", attrs: { "data-testid": "route-locked" } },
            [
              el(doc, "h2", { text: "セキュリティロックアウト" }),
              el(doc, "p", {
                text: "PIN 認証の連続失敗回数が上限（10 回）に達したため、サーバーが保護停止しました。",
              }),
              el(doc, "p", {
                text: "解除するには管理者がサーバー永続ボリューム内の lockout.json を削除し、コンテナを再起動する必要があります。",
              }),
              ...(state.errorBanner !== null
                ? [el(doc, "div", { className: "error-banner", text: state.errorBanner })]
                : []),
            ],
          ),
        );
        return;

      case "SUPERSEDED_4000":
        this.container.replaceChildren(
          el(
            doc,
            "section",
            { className: "screen-card", attrs: { "data-testid": "route-superseded-4000" } },
            [
              el(doc, "h2", { text: "接続が引き継がれました" }),
              el(doc, "p", {
                text: "新しい接続（別タブまたは再接続）に引き継がれました。自動再接続は停止しています。",
              }),
              el(doc, "div", { className: "row-actions" }, [
                touchButton(
                  doc,
                  "再接続する",
                  () => {
                    this.store.reconnectFromSuperseded();
                  },
                  {
                    className: "btn btn--primary",
                    attrs: { "data-action": "reconnect-superseded" },
                  },
                ),
                touchButton(
                  doc,
                  "PIN 画面へ戻る",
                  () => {
                    this.store.returnToPin();
                  },
                  { className: "btn", attrs: { "data-action": "return-to-pin" } },
                ),
              ]),
            ],
          ),
        );
        return;

      case "CONFLICT_4009":
        this.container.replaceChildren(
          el(
            doc,
            "section",
            { className: "screen-card", attrs: { "data-testid": "route-conflict-4009" } },
            [
              el(doc, "h2", { text: "セッション競合エラー" }),
              el(doc, "p", {
                text:
                  state.lastCloseReason ??
                  "他の端末または新しいプライマリセッションが接続されたため、この接続は終了しました。",
              }),
              el(doc, "div", { className: "row-actions" }, [
                touchButton(
                  doc,
                  "PIN 画面へ戻る",
                  () => {
                    this.store.returnToPin();
                  },
                  { className: "btn btn--primary", attrs: { "data-action": "return-to-pin" } },
                ),
              ]),
            ],
          ),
        );
        return;

      case "PIN":
        this.renderPinScreen(doc, state);
        return;
    }
  }

  private renderPinScreen(doc: Document, state: AppState): void {
    const card = el(doc, "section", {
      className: "screen-card",
      attrs: { "data-testid": "route-pin" },
    });

    card.appendChild(
      el(doc, "div", { className: "screen-topbar" }, [
        el(doc, "strong", { text: "Tesroid PIN 認証" }),
        touchButton(
          doc,
          "メニュー",
          () => {
            this.menuOpen = !this.menuOpen;
            this.render(this.store.getState());
          },
          { className: "btn", attrs: { "data-action": "toggle-pin-menu" } },
        ),
      ]),
    );

    if (this.menuOpen) {
      card.appendChild(
        el(
          doc,
          "div",
          { className: "menu-popover", attrs: { "data-testid": "pin-menu-popover" } },
          [
            touchButton(
              doc,
              "ガイドを表示",
              () => {
                this.menuOpen = false;
                this.store.openModal({ kind: "onboarding_guide" });
              },
              { className: "btn", attrs: { "data-action": "open-guide-from-pin" } },
            ),
            touchButton(
              doc,
              "後席待機モードで接続",
              () => {
                this.menuOpen = false;
                this.submitPin("SECONDARY", true);
              },
              { className: "btn", attrs: { "data-action": "connect-rear-standby" } },
            ),
          ],
        ),
      );
    }

    const isWarning =
      state.remainingPinAttempts < AUTH_SECURITY_CONSTANTS.warningRemainingThreshold;
    card.appendChild(
      el(doc, "div", {
        className: isWarning ? "attempts-badge attempts-badge--warn" : "attempts-badge",
        text: `残り試行回数: ${state.remainingPinAttempts} 回`,
        attrs: { "data-testid": "pin-attempts" },
      }),
    );

    const err = this.localError ?? state.errorBanner;
    if (err !== null) {
      card.appendChild(
        el(doc, "div", {
          className: "error-banner",
          text: err,
          attrs: { "data-testid": "pin-error" },
        }),
      );
    }

    card.appendChild(
      el(doc, "div", {
        className: "pin-display",
        text: this.pinBuffer.length > 0 ? "●".repeat(this.pinBuffer.length) : "PIN を入力",
        attrs: { "data-testid": "pin-display" },
      }),
    );

    const keypad = el(doc, "div", {
      className: "keypad-grid",
      attrs: { "data-testid": "pin-keypad" },
    });
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "クリア", "0", "⌫"];
    for (const key of keys) {
      keypad.appendChild(
        touchButton(
          doc,
          key,
          () => {
            this.handleKeypadPress(key);
          },
          { className: "btn keypad-btn", attrs: { "data-pin-key": key } },
        ),
      );
    }
    card.appendChild(keypad);

    const actions = el(doc, "div", { className: "row-actions" });
    if (state.systemStatus?.hasActiveSession === true) {
      actions.appendChild(
        touchButton(
          doc,
          "メインとして接続",
          () => {
            this.submitPin("PRIMARY", false);
          },
          { className: "btn btn--primary", attrs: { "data-action": "login-primary" } },
        ),
      );
      actions.appendChild(
        touchButton(
          doc,
          "2 台目として接続",
          () => {
            this.submitPin("SECONDARY", false);
          },
          { className: "btn", attrs: { "data-action": "login-secondary" } },
        ),
      );
    } else {
      actions.appendChild(
        touchButton(
          doc,
          "接続",
          () => {
            this.submitPin("PRIMARY", false);
          },
          { className: "btn btn--primary", attrs: { "data-action": "login-primary" } },
        ),
      );
    }
    card.appendChild(actions);

    this.container?.replaceChildren(card);
  }

  private handleKeypadPress(key: string): void {
    this.localError = null;
    if (key === "クリア") {
      this.pinBuffer = "";
    } else if (key === "⌫") {
      this.pinBuffer = this.pinBuffer.slice(0, -1);
    } else if (this.pinBuffer.length < 8) {
      this.pinBuffer += key;
    }
    this.render(this.store.getState());
  }

  private submitPin(mode: "PRIMARY" | "SECONDARY", preferStandby: boolean): void {
    if (!isValidPin(this.pinBuffer)) {
      this.localError = "PIN は 4〜8 桁の半角数字で入力してください";
      this.render(this.store.getState());
      return;
    }
    this.localError = null;
    const pin = this.pinBuffer;
    if (mode === "PRIMARY") {
      void this.store.loginPrimaryPin(pin);
    } else {
      void this.store.loginSecondaryPin(pin, preferStandby);
    }
  }
}
