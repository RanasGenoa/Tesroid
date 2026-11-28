import { el, touchButton } from "../../dom.js";
import { pickerControl } from "../../touch-picker.js";
import type { GeneralTabContext } from "./context.js";
import type { GeneralDraft } from "./draft.js";

// Spec: docs/specs/07-ui-hud-settings.md#2.4 (AC-09) — VAAPI 稼働時の custom 詳細編集はアプリ内ピッカー/トグルのみ。
export function renderVaapiDetails(
  doc: Document,
  draft: GeneralDraft,
  ctx: GeneralTabContext,
): HTMLElement {
  const details = el(doc, "div", {
    className: "form-field",
    attrs: { "data-testid": "settings-vaapi-details" },
  });
  details.appendChild(el(doc, "label", { text: "VAAPI 詳細編集（custom プリセットに適用）" }));
  const compressionControl = pickerControl(
    doc,
    "settings-vaapi-compression",
    String(draft.vaapiCompressionLevel),
    () => {
      void ctx
        .openOptionPicker(
          doc,
          "settings-vaapi-compression",
          "VAAPI 圧縮優先度 (1=高速〜7=高圧縮)",
          [1, 2, 3, 4, 5, 6, 7].map((level) => ({ label: String(level), value: String(level) })),
          String(draft.vaapiCompressionLevel),
        )
        .then((value) => {
          if (value === null) {
            return;
          }
          draft.vaapiCompressionLevel = Number(value);
          compressionControl.textContent = value;
        });
    },
  );
  details.appendChild(compressionControl);

  const colorToggle = touchButton(
    doc,
    `GPU 色空間変換: ${draft.vaapiGpuColorConvert ? "ON" : "OFF"}`,
    () => {
      draft.vaapiGpuColorConvert = !draft.vaapiGpuColorConvert;
      colorToggle.textContent = `GPU 色空間変換: ${draft.vaapiGpuColorConvert ? "ON" : "OFF"}`;
      colorToggle.className = draft.vaapiGpuColorConvert ? "btn btn--primary" : "btn";
    },
    {
      className: draft.vaapiGpuColorConvert ? "btn btn--primary" : "btn",
      attrs: { "data-action": "settings-toggle-vaapi-color" },
    },
  );
  const lowPowerToggle = touchButton(
    doc,
    `Intel VDEnc 低電力モード: ${draft.vaapiLowPower ? "ON" : "OFF"}`,
    () => {
      draft.vaapiLowPower = !draft.vaapiLowPower;
      lowPowerToggle.textContent = `Intel VDEnc 低電力モード: ${draft.vaapiLowPower ? "ON" : "OFF"}`;
      lowPowerToggle.className = draft.vaapiLowPower ? "btn btn--primary" : "btn";
    },
    {
      className: draft.vaapiLowPower ? "btn btn--primary" : "btn",
      attrs: { "data-action": "settings-toggle-vaapi-lowpower" },
    },
  );
  details.appendChild(colorToggle);
  details.appendChild(lowPowerToggle);
  return details;
}
