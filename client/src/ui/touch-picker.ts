import { el } from "./dom.js";

export interface TouchPickerOption {
  readonly label: string;
  readonly value: string;
}

export interface TouchPickerRequest {
  readonly title: string;
  // data-testid プレフィックス。ピッカー自体は `picker-<testid>` で検索可能になる。
  readonly testid: string;
  readonly options: readonly TouchPickerOption[];
  readonly selectedValue: string;
}

export interface TouchPickerHandle {
  readonly closed: Promise<string | null>;
  dismiss(): void;
}

// Spec: docs/specs/07-ui-hud-settings.md#2.4 / #3
// ネイティブ select のポップアップは車載タッチで即閉じとなり操作不能なため、
// 選択肢一覧は document.body に固定配置する（モーダルの再描画でも消えない）。
export function openTouchPicker(doc: Document, request: TouchPickerRequest): TouchPickerHandle {
  const backdrop = el(doc, "div", {
    className: "picker-backdrop",
    attrs: { "data-testid": `picker-${request.testid}` },
  });

  let settle: (value: string | null) => void = () => {};
  const closed = new Promise<string | null>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const finish = (value: string | null): void => {
    if (settled) {
      return;
    }
    settled = true;
    backdrop.remove();
    settle(value);
  };

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      finish(null);
    }
  });

  const panel = el(doc, "div", { className: "picker-panel" }, [
    el(doc, "strong", { text: request.title }),
  ]);
  for (const option of request.options) {
    const row = el(doc, "button", {
      className:
        option.value === request.selectedValue
          ? "picker-option picker-option--current"
          : "picker-option",
      text: option.label,
      attrs: { type: "button", "data-option-value": option.value },
    });
    row.addEventListener("click", () => finish(option.value));
    panel.appendChild(row);
  }
  backdrop.appendChild(panel);
  doc.body.appendChild(backdrop);

  return { closed, dismiss: () => finish(null) };
}

// Spec: docs/specs/07-ui-hud-settings.md#2.4 (AC-06) — 開いてもよいピッカーは常に単一。
// view の unmount・ルート離脱時に dismiss() で body 残留を構造的に防ぐ。
export class TouchPickerHost {
  private active: TouchPickerHandle | null = null;

  open(doc: Document, request: TouchPickerRequest): Promise<string | null> {
    this.dismiss();
    const handle = openTouchPicker(doc, request);
    this.active = handle;
    void handle.closed.then(() => {
      if (this.active === handle) {
        this.active = null;
      }
    });
    return handle.closed;
  }

  dismiss(): void {
    this.active?.dismiss();
    this.active = null;
  }
}

// Spec: docs/specs/07-ui-hud-settings.md#2.4
// 現在値をラベルで表示し、タップでピッカーを開く統一コントロール（ネイティブ select の代替）。
export function pickerControl(
  doc: Document,
  testid: string,
  currentLabel: string,
  onTap: () => void,
): HTMLElement {
  const button = el(doc, "button", {
    className: "form-picker",
    text: currentLabel,
    attrs: { type: "button", "data-testid": testid },
  });
  button.addEventListener("click", onTap);
  return button;
}
