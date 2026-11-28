import type { AppState } from "../../../state/index.js";
import { el, touchButton } from "../../dom.js";
import { type SettingsTabContext, TWO_TAP_WINDOW_MS } from "./context.js";

export interface MetricsTabState {
  clearLogsArmedUntilMs: number | null;
}

export function createMetricsTabState(): MetricsTabState {
  return { clearLogsArmedUntilMs: null };
}

export function resetMetricsTabState(tab: MetricsTabState): void {
  tab.clearLogsArmedUntilMs = null;
}

async function handleClearTelemetryTap(
  ctx: SettingsTabContext,
  tab: MetricsTabState,
): Promise<void> {
  const nowMs = ctx.clock.nowMs();
  if (tab.clearLogsArmedUntilMs !== null && nowMs <= tab.clearLogsArmedUntilMs) {
    tab.clearLogsArmedUntilMs = null;
    await ctx.store.deleteTelemetryLogs();
    ctx.rerender();
    return;
  }
  tab.clearLogsArmedUntilMs = nowMs + TWO_TAP_WINDOW_MS;
  ctx.rerender();
}

export function renderMetricsTab(
  doc: Document,
  state: AppState,
  ctx: SettingsTabContext,
  tab: MetricsTabState,
): HTMLElement {
  const root = el(doc, "div", {
    className: "form-field",
    attrs: { "data-testid": "settings-tab-metrics" },
  });

  const summary = state.metricsSummary;
  const grid = el(doc, "div", { className: "metrics-grid" });
  const cards: readonly [string, string][] =
    summary === null
      ? [["ステータス", "集計データを取得中..."]]
      : [
          ["現在 / 平均 FPS", `${summary.currentFps.toFixed(1)} / ${summary.avgFps.toFixed(1)}`],
          ["平均 / 最大 RTT", `${summary.avgRttMs.toFixed(1)} / ${summary.maxRttMs.toFixed(1)} ms`],
          ["ドロップフレーム合計", `${summary.totalDroppedFrames}`],
          ["デコーダエラー合計", `${summary.totalDecoderErrors}`],
          ["平均ビットレート", `${summary.avgBitrateKbps.toFixed(0)} kbps`],
          ["平均 A/V ズレ", `${summary.avgAvDriftMs.toFixed(1)} ms`],
          ["サンプル数", `${summary.sampleCount}`],
        ];
  for (const [label, value] of cards) {
    grid.appendChild(
      el(doc, "div", { className: "metric-card" }, [
        el(doc, "span", { className: "metric-label", text: label }),
        el(doc, "span", { className: "metric-value", text: value }),
      ]),
    );
  }
  root.appendChild(grid);

  const telemetryEnabled = state.settings?.stream.telemetryEnabled ?? false;
  root.appendChild(
    el(doc, "div", { className: "row-actions" }, [
      touchButton(
        doc,
        telemetryEnabled ? "詳細テレメトリ収集: ON" : "詳細テレメトリ収集: OFF",
        () => {
          void ctx.store.saveSettings({
            stream: { telemetryEnabled: !telemetryEnabled },
          });
        },
        {
          className: telemetryEnabled ? "btn btn--primary" : "btn",
          disabled: state.settings === null,
          attrs: { "data-action": "settings-toggle-telemetry" },
        },
      ),
    ]),
  );

  const nowMs = ctx.clock.nowMs();
  const isClearArmed = tab.clearLogsArmedUntilMs !== null && nowMs <= tab.clearLogsArmedUntilMs;
  root.appendChild(
    el(doc, "div", { className: "row-actions" }, [
      touchButton(
        doc,
        isClearArmed ? "もう一度タップしてログ全消去を確定" : "サーバーログ全消去",
        () => {
          void handleClearTelemetryTap(ctx, tab);
        },
        {
          className: isClearArmed ? "btn btn--danger" : "btn btn--warn",
          attrs: { "data-action": "settings-clear-telemetry" },
        },
      ),
    ]),
  );

  return root;
}
