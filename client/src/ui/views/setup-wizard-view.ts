import {
  DEFAULT_TIMEZONE,
  isValidPin,
  SETUP_QUALITY_CHOICES,
  SETUP_TIMEZONE_OPTIONS,
  type SetupQualityChoice,
} from "@tesroid/shared";
import type { AppRoute, AppState, AppStore } from "../../state/index.js";
import { el, getDoc, touchButton } from "../dom.js";
import { buildOnboardingGuideElement } from "../guide-content.js";
import { pickerControl, TouchPickerHost } from "../touch-picker.js";

const QUALITY_LABELS: Readonly<Record<SetupQualityChoice, string>> = {
  high: "最高品質 (MCU3)",
  standard: "標準 (MCU3) *既定*",
  lightweight: "軽量 (MCU2)",
};

export class SetupWizardView {
  private readonly store: AppStore;
  private container: HTMLElement | null = null;
  private step: 1 | 2 = 1;
  private lastRoute: AppRoute | null = null;
  private pinDraft = "";
  private timezoneDraft: string = DEFAULT_TIMEZONE;
  private qualityDraft: SetupQualityChoice = "standard";
  private localError: string | null = null;
  private submitting = false;
  private readonly pickerHost = new TouchPickerHost();

  // Spec: docs/specs/01-auth-security.md#2.3
  constructor(store: AppStore) {
    this.store = store;
  }

  // Spec: docs/specs/01-auth-security.md#2.3
  mount(container: HTMLElement): void {
    this.container = container;
    this.render(this.store.getState());
  }

  // Spec: docs/specs/01-auth-security.md#2.3
  unmount(): void {
    this.pickerHost.dismiss();
    if (this.container !== null) {
      this.container.replaceChildren();
    }
    this.container = null;
  }

  // Spec: docs/specs/01-auth-security.md#2.3
  render(state: AppState): void {
    if (this.container === null) {
      return;
    }

    if (state.route !== "SETUP") {
      if (this.lastRoute === "SETUP") {
        this.step = 1;
        this.pinDraft = "";
        this.localError = null;
        this.submitting = false;
      }
      this.pickerHost.dismiss();
      this.lastRoute = state.route;
      this.container.replaceChildren();
      this.container.className = "";
      return;
    }

    if (this.lastRoute !== "SETUP") {
      this.step = 1;
      this.localError = null;
    }
    this.lastRoute = state.route;

    const doc = getDoc(this.container);
    this.container.className = "screen-shell";

    const card = el(doc, "section", {
      className: "screen-card",
      attrs: { "data-testid": "setup-wizard" },
    });

    if (this.step === 1) {
      card.appendChild(
        el(doc, "div", { className: "screen-topbar" }, [
          el(doc, "strong", { text: "初期セットアップ (1 / 2)" }),
        ]),
      );
      card.appendChild(buildOnboardingGuideElement(doc));
      card.appendChild(
        el(doc, "div", { className: "row-actions" }, [
          touchButton(
            doc,
            "次へ（初期設定）",
            () => {
              this.step = 2;
              this.localError = null;
              this.render(this.store.getState());
            },
            { className: "btn btn--primary", attrs: { "data-action": "setup-next" } },
          ),
        ]),
      );
      this.container.replaceChildren(card);
      return;
    }

    card.appendChild(
      el(doc, "div", { className: "screen-topbar" }, [
        el(doc, "strong", { text: "初期セットアップ (2 / 2)" }),
        touchButton(
          doc,
          "ガイドへ戻る",
          () => {
            this.step = 1;
            this.render(this.store.getState());
          },
          { className: "btn", attrs: { "data-action": "setup-back" } },
        ),
      ]),
    );

    const errorMessage = this.localError ?? state.errorBanner;
    if (errorMessage !== null) {
      card.appendChild(
        el(doc, "div", {
          className: "error-banner",
          text: errorMessage,
          attrs: { "data-testid": "setup-error" },
        }),
      );
    }

    const pinField = el(doc, "div", { className: "form-field" }, [
      el(doc, "label", { text: "認証 PIN コード（必須・半角数字 4〜8 桁）" }),
    ]);
    const pinInput = el(doc, "input", {
      className: "form-input",
      attrs: {
        type: "password",
        inputmode: "numeric",
        placeholder: "4〜8 桁の半角数字",
        "data-testid": "setup-pin-input",
      },
    });
    pinInput.value = this.pinDraft;
    pinInput.addEventListener("input", () => {
      this.pinDraft = pinInput.value;
    });
    pinField.appendChild(pinInput);
    card.appendChild(pinField);

    const tzField = el(doc, "div", { className: "form-field" }, [
      el(doc, "label", { text: "タイムゾーン" }),
    ]);
    const tzControl = pickerControl(doc, "setup-timezone-select", this.timezoneDraft, () => {
      void this.pickerHost
        .open(doc, {
          title: "タイムゾーン",
          testid: "setup-timezone-select",
          options: SETUP_TIMEZONE_OPTIONS.map((tz) => ({ label: tz, value: tz })),
          selectedValue: this.timezoneDraft,
        })
        .then((value) => {
          if (value === null) {
            return;
          }
          this.timezoneDraft = value;
          this.render(this.store.getState());
        });
    });
    tzField.appendChild(tzControl);
    card.appendChild(tzField);

    const presetField = el(doc, "div", { className: "form-field" }, [
      el(doc, "label", { text: "品質・負荷プロファイル初期設定（3 択）" }),
      el(doc, "p", {
        text: "この選択は設定画面内の各項目の初期値をまとめて設定するショートカットであり、セットアップ後も設定画面からいつでも個別に変更可能です。",
      }),
    ]);
    const presetRow = el(doc, "div", { className: "row-actions" });
    for (const choice of SETUP_QUALITY_CHOICES) {
      const btn = touchButton(
        doc,
        QUALITY_LABELS[choice],
        () => {
          this.qualityDraft = choice;
          this.render(this.store.getState());
        },
        {
          className: this.qualityDraft === choice ? "btn btn--primary" : "btn",
          attrs: { "data-testid": `setup-quality-${choice}` },
        },
      );
      presetRow.appendChild(btn);
    }
    presetField.appendChild(presetRow);
    card.appendChild(presetField);

    card.appendChild(
      el(doc, "div", { className: "row-actions" }, [
        touchButton(
          doc,
          this.submitting ? "保存中..." : "セットアップを完了",
          () => {
            void this.handleSubmit();
          },
          {
            className: "btn btn--primary",
            disabled: this.submitting,
            attrs: { "data-action": "setup-submit" },
          },
        ),
      ]),
    );

    this.container.replaceChildren(card);
  }

  private async handleSubmit(): Promise<void> {
    if (!isValidPin(this.pinDraft)) {
      this.localError = "PIN は 4〜8 桁の半角数字で入力してください";
      this.render(this.store.getState());
      return;
    }
    this.localError = null;
    this.submitting = true;
    this.render(this.store.getState());
    const ok = await this.store.submitSetup({
      pin: this.pinDraft,
      timezone: this.timezoneDraft,
      qualityPreset: this.qualityDraft,
    });
    this.submitting = false;
    if (!ok) {
      this.render(this.store.getState());
    }
  }
}
