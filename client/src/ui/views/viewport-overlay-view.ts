import { type AppState, type AppStore, isPrimaryAuthorityRole } from "../../state/index.js";
import { el, getDoc, touchButton } from "../dom.js";

export class ViewportOverlayView {
  private readonly store: AppStore;
  private container: HTMLElement | null = null;

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  constructor(store: AppStore) {
    this.store = store;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  mount(container: HTMLElement): void {
    this.container = container;
    this.render(this.store.getState());
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  unmount(): void {
    if (this.container !== null) {
      this.container.replaceChildren();
    }
    this.container = null;
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  render(state: AppState): void {
    if (this.container === null) {
      return;
    }

    if (state.route !== "STREAMING") {
      this.container.replaceChildren();
      return;
    }

    const doc = getDoc(this.container);
    const isPrimary = isPrimaryAuthorityRole(state.role);

    if (state.role === "SECONDARY_STANDBY") {
      this.container.replaceChildren(
        el(
          doc,
          "div",
          {
            className: "viewport-overlay",
            attrs: { "data-testid": "overlay-rear-standby" },
          },
          [
            el(doc, "h2", { text: "後席待機中" }),
            el(doc, "p", { text: "前席（プライマリ）が接続すると自動で視聴を開始します。" }),
            touchButton(
              doc,
              "切断",
              () => {
                this.store.disconnectExplicit();
              },
              { className: "btn btn--danger", attrs: { "data-action": "standby-disconnect" } },
            ),
          ],
        ),
      );
      return;
    }

    if (state.powerState === "SLEEP_PAUSED") {
      const overlay = el(doc, "div", {
        className: "viewport-overlay",
        attrs: { "data-testid": "overlay-sleep-paused" },
      });
      if (isPrimary) {
        overlay.addEventListener("click", (event) => {
          const target = event.target as HTMLElement | null;
          if (target?.getAttribute("data-action") === "sleep-disconnect") {
            return;
          }
          void this.store.resumeSystem();
        });
      }
      overlay.appendChild(el(doc, "h2", { text: "スリープ中" }));
      overlay.appendChild(
        el(doc, "p", {
          text: isPrimary
            ? "画面または「復帰」をタップしてブラウザを再開します。"
            : "プライマリ端末による復帰を待っています。",
        }),
      );
      const actions = el(doc, "div", { className: "row-actions" });
      if (isPrimary) {
        actions.appendChild(
          touchButton(
            doc,
            "復帰",
            () => {
              void this.store.resumeSystem();
            },
            { className: "btn btn--primary", attrs: { "data-action": "sleep-resume" } },
          ),
        );
      }
      actions.appendChild(
        touchButton(
          doc,
          "切断",
          () => {
            this.store.disconnectExplicit();
          },
          { className: "btn btn--danger", attrs: { "data-action": "sleep-disconnect" } },
        ),
      );
      overlay.appendChild(actions);
      this.container.replaceChildren(overlay);
      return;
    }

    if (state.powerState === "STARTING" || state.powerState === "STOPPED") {
      // Spec: docs/specs/07-ui-hud-settings.md#2.4 (AC-07) — スピナーと Browser/配信の稼働状態バッジをヘルス API 実データで示す。
      const health = state.health;
      const browserLabel =
        health === null
          ? "確認中"
          : health.powerState === "ACTIVE"
            ? "稼働中"
            : health.powerState === "STARTING"
              ? "準備中"
              : health.powerState === "SLEEP_PAUSED"
                ? "一時停止"
                : health.powerState === "RESTARTING"
                  ? "再起動中"
                  : "停止中";
      const browserOn = health !== null && health.powerState === "ACTIVE";
      const encoderRunning = health?.encoder.running === true;
      const statusRow = el(doc, "div", { className: "overlay-status-row" }, [
        el(doc, "span", {
          className: browserOn ? "hud-badge status-badge--on" : "hud-badge status-badge--off",
          text: `Browser: ${browserLabel}`,
          attrs: { "data-testid": "overlay-badge-browser" },
        }),
        el(doc, "span", {
          className: encoderRunning ? "hud-badge status-badge--on" : "hud-badge status-badge--off",
          text: `配信: ${encoderRunning ? "送信中" : "待機中"}`,
          attrs: { "data-testid": "overlay-badge-encoder" },
        }),
      ]);
      this.container.replaceChildren(
        el(
          doc,
          "div",
          {
            className: "viewport-overlay",
            attrs: { "data-testid": "overlay-starting" },
          },
          [
            el(doc, "div", { className: "spinner", attrs: { "data-testid": "overlay-spinner" } }),
            el(doc, "h2", { text: "起動中..." }),
            el(doc, "p", { text: "ブラウザとエンコーダを起動しています。" }),
            statusRow,
          ],
        ),
      );
      return;
    }

    if (state.powerState === "RESTARTING") {
      this.container.replaceChildren(
        el(
          doc,
          "div",
          {
            className: "viewport-overlay",
            attrs: { "data-testid": "overlay-restarting" },
          },
          [
            el(doc, "h2", { text: "復帰 / 再起動中..." }),
            el(doc, "p", { text: "ブラウザと配信を再起動しています。" }),
          ],
        ),
      );
      return;
    }

    if (state.powerState === "ERROR") {
      this.container.replaceChildren(
        el(
          doc,
          "div",
          {
            className: "viewport-overlay",
            attrs: { "data-testid": "overlay-error" },
          },
          [
            el(doc, "h2", { text: "エラーが発生しました" }),
            el(doc, "p", {
              text: state.errorBanner ?? "ブラウザまたはエンコーダで異常が発生しました。",
            }),
            el(doc, "div", { className: "row-actions" }, [
              ...(isPrimary
                ? [
                    touchButton(
                      doc,
                      "ブラウザを再起動",
                      () => {
                        void this.store.restartBrowser();
                      },
                      { className: "btn btn--primary", attrs: { "data-action": "error-restart" } },
                    ),
                  ]
                : []),
              touchButton(
                doc,
                "切断",
                () => {
                  this.store.disconnectExplicit();
                },
                { className: "btn btn--danger", attrs: { "data-action": "error-disconnect" } },
              ),
            ]),
          ],
        ),
      );
      return;
    }

    if (state.wsStatus !== "CONNECTED" && !state.localBufferSurvivalActive) {
      this.container.replaceChildren(
        el(
          doc,
          "div",
          {
            className: "viewport-overlay",
            attrs: { "data-testid": "overlay-disconnected" },
          },
          [
            el(doc, "h2", { text: "再接続中..." }),
            el(doc, "p", { text: "サーバーとの接続を復旧しています。" }),
            touchButton(
              doc,
              "切断",
              () => {
                this.store.disconnectExplicit();
              },
              { className: "btn btn--danger", attrs: { "data-action": "disconnect-from-overlay" } },
            ),
          ],
        ),
      );
      return;
    }

    if (state.audioUnlockNeeded && isPrimary) {
      this.container.replaceChildren(
        el(doc, "div", { className: "audio-unlock-banner" }, [
          touchButton(
            doc,
            "代理昇格: タップして音声再生を有効化",
            () => {
              void this.store.unlockAudioOnGesture();
            },
            { className: "btn btn--primary", attrs: { "data-action": "unlock-audio" } },
          ),
        ]),
      );
      return;
    }

    this.container.replaceChildren();
  }
}
