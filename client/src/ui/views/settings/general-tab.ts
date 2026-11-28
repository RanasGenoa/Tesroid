import {
  AUDIO_BITRATE_OPTIONS,
  CLIENT_PROFILE_NAMES,
  type ClientProfileName,
  CPU_PERFORMANCE_PRESETS,
  DISPLAY_SCALE_UI_OPTIONS,
  type EncoderBackend,
  GPU_PERFORMANCE_PRESETS,
  isPresetCompatibleWithBackend,
  resolveClientProfile,
  TARGET_BUFFER_MS_OPTIONS,
  type VideoPerformancePreset,
} from "@tesroid/shared";
import type { AppState } from "../../../state/index.js";
import { el, touchButton } from "../../dom.js";
import { pickerControl } from "../../touch-picker.js";
import type { GeneralTabContext } from "./context.js";
import { type GeneralDraft, parseAllowedFpsText } from "./draft.js";
import { renderVaapiDetails } from "./vaapi-details.js";

const PRESET_LABELS: Readonly<Record<VideoPerformancePreset, string>> = {
  high: "高画質 GPU (max 1920)",
  balanced: "標準 GPU (max 1280)",
  low_power: "省電力 GPU (max 960)",
  cpu_balanced: "標準 CPU (max 1280)",
  cpu_low_power: "省電力 CPU (max 960)",
  custom: "カスタム (custom)",
};

const PROFILE_LABELS: Readonly<Record<ClientProfileName, string>> = {
  standard: "標準 (standard)",
  lightweight: "軽量 (lightweight)",
  custom: "カスタム (custom)",
};

function displayScaleLabel(scale: number): string {
  return scale === 100 ? "100% (既定)" : `${scale}%`;
}

function targetBufferLabel(ms: number): string {
  return ms === 10_000 ? "10,000 ms (既定)" : `${ms.toLocaleString("en-US")} ms`;
}

function audioBitrateLabel(bps: number): string {
  const kbps = Math.round(bps / 1_000);
  return bps === 128_000 ? `${kbps} kbps (既定)` : `${kbps} kbps`;
}

export interface GeneralTabState {
  error: string | null;
  statusMessage: string | null;
}

export function createGeneralTabState(): GeneralTabState {
  return { error: null, statusMessage: null };
}

export function resetGeneralTabState(tab: GeneralTabState): void {
  tab.error = null;
  tab.statusMessage = null;
}

export function renderGeneralTab(
  doc: Document,
  state: AppState,
  draft: GeneralDraft | null,
  ctx: GeneralTabContext,
  tab: GeneralTabState,
  onSave: (draft: GeneralDraft) => Promise<void>,
): HTMLElement {
  const root = el(doc, "div", {
    className: "form-field",
    attrs: { "data-testid": "settings-tab-general" },
  });

  if (draft === null) {
    root.appendChild(el(doc, "p", { text: "設定を読み込み中..." }));
    return root;
  }
  const health = state.health;
  const backend: EncoderBackend = health?.encoder.backend ?? "vaapi";

  const err = tab.error ?? state.errorBanner;
  if (err !== null) {
    root.appendChild(
      el(doc, "div", {
        className: "error-banner",
        text: err,
        attrs: { "data-testid": "settings-general-error" },
      }),
    );
  }
  if (tab.statusMessage !== null) {
    root.appendChild(
      el(doc, "div", {
        className: "warn-banner",
        text: tab.statusMessage,
        attrs: { "data-testid": "settings-general-status" },
      }),
    );
  }

  const pinInput = el(doc, "input", {
    className: "form-input",
    attrs: {
      type: "password",
      inputmode: "numeric",
      placeholder: "空欄で維持 (4〜8 桁半角数字)",
      "data-testid": "settings-pin-input",
    },
  });
  pinInput.value = draft.pin;
  pinInput.addEventListener("input", () => {
    draft.pin = pinInput.value;
  });
  root.appendChild(
    el(doc, "div", { className: "form-field" }, [
      el(doc, "label", { text: "新しい PIN コード（空欄で現在の PIN を維持）" }),
      pinInput,
    ]),
  );

  const scaleControl = pickerControl(
    doc,
    "settings-display-scale",
    displayScaleLabel(draft.displayScale),
    () => {
      void ctx
        .openOptionPicker(
          doc,
          "settings-display-scale",
          "ブラウザ表示拡大率",
          DISPLAY_SCALE_UI_OPTIONS.map((scale) => ({
            label: displayScaleLabel(scale),
            value: String(scale),
          })),
          String(draft.displayScale),
        )
        .then((value) => {
          if (value === null) {
            return;
          }
          draft.displayScale = Number(value);
          void ctx.store.saveSettings({ stream: { displayScale: Number(value) } });
        });
    },
  );
  root.appendChild(
    el(doc, "div", { className: "form-field" }, [
      el(doc, "label", { text: "ブラウザ表示拡大率" }),
      scaleControl,
    ]),
  );

  const bufferControl = pickerControl(
    doc,
    "settings-target-buffer",
    targetBufferLabel(draft.targetBufferMs),
    () => {
      void ctx
        .openOptionPicker(
          doc,
          "settings-target-buffer",
          "先行バッファ深度",
          TARGET_BUFFER_MS_OPTIONS.map((ms) => ({
            label: targetBufferLabel(ms),
            value: String(ms),
          })),
          String(draft.targetBufferMs),
        )
        .then((value) => {
          if (value === null) {
            return;
          }
          draft.targetBufferMs = Number(value);
          void ctx.store.saveSettings({ stream: { targetBufferMs: Number(value) } });
        });
    },
  );
  root.appendChild(
    el(doc, "div", { className: "form-field" }, [
      el(doc, "label", { text: "先行バッファ深度" }),
      bufferControl,
    ]),
  );

  const audioControl = pickerControl(
    doc,
    "settings-audio-bitrate",
    audioBitrateLabel(draft.audioBitrate),
    () => {
      void ctx
        .openOptionPicker(
          doc,
          "settings-audio-bitrate",
          "音声ビットレート",
          AUDIO_BITRATE_OPTIONS.map((bps) => ({
            label: audioBitrateLabel(bps),
            value: String(bps),
          })),
          String(draft.audioBitrate),
        )
        .then((value) => {
          if (value === null) {
            return;
          }
          draft.audioBitrate = Number(value);
          void ctx.store.saveSettings({ stream: { audioBitrate: Number(value) } });
        });
    },
  );
  root.appendChild(
    el(doc, "div", { className: "form-field" }, [
      el(doc, "label", { text: "音声ビットレート" }),
      audioControl,
    ]),
  );

  const backendLabel = health === null ? "取得中..." : health.encoder.backend.toUpperCase();
  const resInfo =
    health !== null
      ? `キャプチャ ${health.encoder.captureResolution.width}x${health.encoder.captureResolution.height} → エンコード ${health.encoder.encodeResolution.width}x${health.encoder.encodeResolution.height}`
      : "エンコード解像度: 取得中";
  root.appendChild(
    el(
      doc,
      "div",
      { className: "form-field", attrs: { "data-testid": "settings-encoder-health" } },
      [
        el(doc, "strong", { text: `サーバー映像パフォーマンス (${backendLabel})` }),
        el(doc, "span", { text: `${resInfo}（プリセットに応じてエンコード寸法を縮小）` }),
      ],
    ),
  );

  if (health?.encoder.backend === "software") {
    root.appendChild(
      el(doc, "div", {
        className: "warn-banner",
        text: "ソフトウェアエンコード (libx264) で動作中です。CPU 負荷を抑えるため軽量プリセットを推奨します。",
        attrs: { "data-testid": "settings-software-warning" },
      }),
    );
  }

  const availablePresets: readonly VideoPerformancePreset[] =
    backend === "software" ? CPU_PERFORMANCE_PRESETS : GPU_PERFORMANCE_PRESETS;
  // 選択中値はタップ時に再評価する（maxSize 入力等の非再描画変更で draft.preset が変わっても古い値を提示しない）。
  const currentPresetValue = (): VideoPerformancePreset =>
    isPresetCompatibleWithBackend(draft.preset, backend) ? draft.preset : "custom";
  const presetControl = pickerControl(
    doc,
    "settings-video-preset",
    PRESET_LABELS[currentPresetValue()],
    () => {
      void ctx
        .openOptionPicker(
          doc,
          "settings-video-preset",
          "サーバー映像プリセット",
          availablePresets.map((p) => ({ label: PRESET_LABELS[p], value: p })),
          currentPresetValue(),
        )
        .then((value) => {
          if (value === null) {
            return;
          }
          draft.preset = value as VideoPerformancePreset;
          void ctx.store.saveSettings({ stream: { preset: value as VideoPerformancePreset } });
          ctx.rerender();
        });
    },
  );
  root.appendChild(
    el(doc, "div", { className: "form-field" }, [
      el(doc, "label", { text: "サーバー映像プリセット" }),
      presetControl,
    ]),
  );

  const maxSizeInput = el(doc, "input", {
    className: "form-input",
    attrs: { type: "number", "data-testid": "settings-max-size" },
  });
  maxSizeInput.value = String(draft.maxSize);
  maxSizeInput.addEventListener("input", () => {
    const parsed = Number(maxSizeInput.value);
    if (Number.isFinite(parsed)) {
      draft.maxSize = parsed;
    }
    draft.preset = "custom";
    presetControl.textContent = PRESET_LABELS.custom;
  });
  root.appendChild(
    el(doc, "div", { className: "form-field" }, [
      el(doc, "label", { text: "最大エンコード辺長 (640〜1920 px、変更時 custom 切替)" }),
      maxSizeInput,
    ]),
  );

  if (backend !== "vaapi") {
    root.appendChild(
      el(doc, "div", {
        className: "metric-label",
        text:
          backend === "nvenc"
            ? "VAAPI 詳細設定は NVENC バックエンド使用中のため無効化されています。"
            : "VAAPI 詳細設定はソフトウェア (CPU) バックエンド使用中のため無効化されています。",
        attrs: { "data-testid": "settings-vaapi-disabled-reason" },
      }),
    );
  } else {
    root.appendChild(renderVaapiDetails(doc, draft, ctx));
  }

  const profileControl = pickerControl(
    doc,
    "settings-client-profile",
    PROFILE_LABELS[draft.clientProfileActive],
    () => {
      void ctx
        .openOptionPicker(
          doc,
          "settings-client-profile",
          "クライアント負荷プロファイル",
          CLIENT_PROFILE_NAMES.map((name) => ({ label: PROFILE_LABELS[name], value: name })),
          draft.clientProfileActive,
        )
        .then((value) => {
          if (value === null) {
            return;
          }
          draft.clientProfileActive = value as ClientProfileName;
          void ctx.store.saveSettings({
            stream: { clientProfile: { active: value as ClientProfileName } },
          });
          ctx.rerender();
        });
    },
  );

  const resolvedProfile = resolveClientProfile({
    active: draft.clientProfileActive,
    custom: {
      scale: draft.customScale,
      allowedFps: parseAllowedFpsText(draft.customAllowedFpsText),
    },
  });
  const previewText = `実効倍率: ${resolvedProfile.scale.toFixed(2)} / 許容 FPS: [${resolvedProfile.allowedFps.join(", ")}]${
    resolvedProfile.defaultBitrateBps !== null
      ? ` / 基準ビットレート: ${Math.round(resolvedProfile.defaultBitrateBps / 1_000)} kbps`
      : ""
  }`;

  root.appendChild(
    el(doc, "div", { className: "form-field" }, [
      el(doc, "label", { text: "クライアント負荷プロファイル" }),
      profileControl,
      el(doc, "span", {
        className: "metric-label",
        text: previewText,
        attrs: { "data-testid": "settings-profile-preview" },
      }),
    ]),
  );

  if (draft.clientProfileActive === "custom") {
    const customScaleInput = el(doc, "input", {
      className: "form-input",
      attrs: { type: "number", step: "0.05", "data-testid": "settings-custom-scale" },
    });
    customScaleInput.value = String(draft.customScale);
    customScaleInput.addEventListener("input", () => {
      const val = Number(customScaleInput.value);
      if (Number.isFinite(val)) {
        draft.customScale = val;
      }
    });

    const customFpsInput = el(doc, "input", {
      className: "form-input",
      attrs: { type: "text", placeholder: "24,30,60", "data-testid": "settings-custom-fps" },
    });
    customFpsInput.value = draft.customAllowedFpsText;
    customFpsInput.addEventListener("input", () => {
      draft.customAllowedFpsText = customFpsInput.value;
    });

    root.appendChild(
      el(doc, "div", { className: "form-field" }, [
        el(doc, "label", { text: "カスタム負荷倍率 (0.4〜1.0)" }),
        customScaleInput,
        el(doc, "label", { text: "カスタム許容 FPS（カンマ区切り）" }),
        customFpsInput,
      ]),
    );
  }

  root.appendChild(
    el(doc, "div", { className: "row-actions" }, [
      touchButton(
        doc,
        "設定を保存",
        () => {
          void onSave(draft);
        },
        { className: "btn btn--primary", attrs: { "data-action": "settings-general-save" } },
      ),
    ]),
  );

  return root;
}
