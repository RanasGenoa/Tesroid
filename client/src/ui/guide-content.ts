import { el } from "./dom.js";

// Spec: docs/specs/01-auth-security.md#2.3
export function buildOnboardingGuideElement(doc: Document): HTMLElement {
  return el(
    doc,
    "div",
    { className: "onboarding-guide", attrs: { "data-testid": "onboarding-guide" } },
    [
      el(doc, "h2", { text: "Tesroid へようこそ" }),
      el(doc, "p", {
        text: "車載ディスプレイのタッチ操作のみで安全に使える専用クラウドブラウザです。WebCodecs 動作のため、公的 CA 証明書による HTTPS / WSS 配信環境でご利用ください。",
      }),
      el(doc, "ul", {}, [
        el(doc, "li", {
          text: "タッチ操作・仮想キーボード: 画面上のタッチ入力に加え、HUD のキーボードボタンからテキスト送信・Enter・Backspace・Tab を操作できます。",
        }),
        el(doc, "li", {
          text: "常設 HUD: 24 / 30 / 60 FPS の切替、0.25M〜2.0M の映像ビットレート切替、LIVE リセット、お気に入り、YouTube 検索バーを備えています。",
        }),
        el(doc, "li", {
          text: "後席待機モード: 前席（プライマリ）不在時は省電力状態を維持したまま待機し、前席の接続と同時に自動視聴を開始します。",
        }),
      ]),
    ],
  );
}
