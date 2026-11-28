import fs from "node:fs";
import path from "node:path";
import type { HealthResponse } from "@tesroid/shared";
import { describe, expect, it } from "vitest";
import { clientDir, createHarness } from "./helpers/ui-harness.js";

describe("client/ui & client/state (Spec 01, 02, 07)", () => {
  it("Spec 07 AC-01: places HUD bar above stream viewport with centered layout, excludes legacy buttons/language selector, and contains zero <video> or localStorage references", async () => {
    const indexHtml = fs.readFileSync(path.join(clientDir, "index.html"), "utf8");
    const headerIdx = indexHtml.indexOf('<header id="hud-root"');
    const viewportIdx = indexHtml.indexOf('<main id="viewport-root"');
    const canvasIdx = indexHtml.indexOf('<canvas id="stream-canvas"');
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(headerIdx).toBeLessThan(viewportIdx);
    expect(viewportIdx).toBeLessThan(canvasIdx);
    expect(indexHtml).not.toMatch(/<video\b/i);
    expect(indexHtml).not.toMatch(/\blocalStorage\b/);

    const h = createHarness();
    await h.store.bootstrap();
    await h.store.loginPrimaryPin("1234");
    h.authenticateWs("PRIMARY");

    expect(h.hudRoot.querySelector('[data-testid="hud-bar-inner"]')).not.toBeNull();
    expect(h.hudRoot.querySelector('[data-action="open-power"]')).not.toBeNull();
    expect(h.hudRoot.querySelector('[data-action="stream-reset"]')).not.toBeNull();
    expect(h.hudRoot.querySelector('[data-action="cycle-fps"]')).not.toBeNull();
    expect(h.hudRoot.querySelector('[data-action="cycle-bitrate"]')).not.toBeNull();
    expect(h.hudRoot.querySelector('[data-action="toggle-keyboard"]')).not.toBeNull();
    expect(h.hudRoot.querySelector('[data-action="toggle-favorites"]')).not.toBeNull();
    expect(h.hudRoot.querySelector('[data-action="open-settings"]')).not.toBeNull();

    // Excluded legacy HUD buttons
    const hudText = h.hudRoot.textContent;
    expect(hudText).not.toContain("更新");
    expect(hudText).not.toContain("全画面");
    expect(hudText).not.toContain("フィット");
    expect(hudText).not.toContain("ミュート");
    expect(hudText).not.toContain("HUD非表示");

    // Settings modal excludes language selector, timezone, and legacy buttons
    h.store.openSettingsWithAuthCheck();
    h.store.openModal({ kind: "settings", activeTab: "general" });
    const settingsHtml = h.settingsModalRoot.innerHTML;
    expect(settingsHtml).not.toContain("言語");
    expect(settingsHtml).not.toContain("タイムゾーン");
    expect(settingsHtml).not.toContain("音声テスト");
    expect(settingsHtml).not.toContain("ログダウンロード");
    expect(settingsHtml).not.toContain("再エンコード");
    expect(settingsHtml).not.toContain("autoSleepMinutes");

    h.dispose();
  });
  it("Spec 07 AC-02: toggles keyboard and favorites drawers mutually exclusively, shows YouTube search bar only for strict youtube.com/youtu.be hosts, enforces 1,000 ms LIVE reset debounce, cycles 0.25M..2.0M bitrates, auto-dims at 4,000 ms, and resets stale RTT at 5,000 ms", async () => {
    const h = createHarness();
    await h.store.bootstrap();
    await h.store.loginPrimaryPin("1234");
    h.authenticateWs("PRIMARY");

    // Mutually exclusive drawers & synchronous focus with user-select: text
    h.hudRoot.querySelector('[data-action="toggle-keyboard"]')?.click();
    expect(h.store.getState().hud.drawer).toBe("keyboard");
    const kbInput = h.hudRoot.querySelector('[data-testid="virtual-keyboard-input"]');
    expect(kbInput).not.toBeNull();
    expect(kbInput?.style.userSelect).toBe("text");
    expect(h.doc.activeElement).toBe(kbInput);

    h.hudRoot.querySelector('[data-action="toggle-favorites"]')?.click();
    expect(h.store.getState().hud.drawer).toBe("favorites");
    expect(h.hudRoot.querySelector('[data-testid="drawer-keyboard"]')).toBeNull();
    expect(h.hudRoot.querySelector('[data-testid="drawer-favorites"]')).not.toBeNull();

    // Auto-dim: stays bright while drawer open, dims 4,000 ms after closing drawer
    h.clock.advanceBy(10_000);
    expect(h.store.getState().hud.dimmed).toBe(false);
    h.store.closeDrawer();
    h.clock.advanceBy(3_999);
    expect(h.store.getState().hud.dimmed).toBe(false);
    h.clock.advanceBy(1);
    expect(h.store.getState().hud.dimmed).toBe(true);
    h.store.recordHudActivity();
    expect(h.store.getState().hud.dimmed).toBe(false);

    // Strict YouTube host gating
    h.transport.triggerControl({
      type: "PAGE_INFO",
      url: "https://www.youtube.com/watch?v=abc",
      title: "YT",
    });
    expect(h.hudRoot.querySelector('[data-testid="hud-youtube-search"]')).not.toBeNull();
    h.transport.triggerControl({
      type: "PAGE_INFO",
      url: "https://youtu.be/xyz",
      title: "YT short",
    });
    expect(h.hudRoot.querySelector('[data-testid="hud-youtube-search"]')).not.toBeNull();
    h.transport.triggerControl({
      type: "PAGE_INFO",
      url: "https://youtube.com.evil.example/watch?v=1",
      title: "Spoof",
    });
    expect(h.hudRoot.querySelector('[data-testid="hud-youtube-search"]')).toBeNull();

    // LIVE reset 1,000 ms debounce
    await h.store.requestStreamReset();
    await h.store.requestStreamReset();
    expect(h.rest.calls.filter((c) => c === "POST /api/stream/reset")).toHaveLength(1);
    h.clock.advanceBy(1_000);
    await h.store.requestStreamReset();
    expect(h.rest.calls.filter((c) => c === "POST /api/stream/reset")).toHaveLength(2);

    // Non-primary roles (SECONDARY_STREAMING and SECONDARY_STANDBY) cannot trigger resetStream
    h.store.dispatch({ type: "SET_ROLE", role: "SECONDARY_STREAMING" });
    h.clock.advanceBy(1_500);
    await h.store.requestStreamReset();
    expect(h.rest.calls.filter((c) => c === "POST /api/stream/reset")).toHaveLength(2);
    h.store.dispatch({ type: "SET_ROLE", role: "SECONDARY_STANDBY" });
    await h.store.requestStreamReset();
    expect(h.rest.calls.filter((c) => c === "POST /api/stream/reset")).toHaveLength(2);
    h.store.dispatch({ type: "SET_ROLE", role: "PRIMARY" });

    // Bitrate cycle 0.25M..2.0M with 300 ms debounce
    await h.store.saveSettings({ stream: { videoBitrate: 250_000 } });
    const expectedBitrates = [500_000, 750_000, 1_000_000, 1_500_000, 2_000_000, 250_000];
    for (const expected of expectedBitrates) {
      await h.store.cycleBitrate();
      h.clock.advanceBy(300);
      await Promise.resolve();
      expect(h.store.getState().settings?.stream.videoBitrate).toBe(expected);
    }

    // RTT freshness resets after 5,000 ms without PONG
    h.transport.triggerControl({
      type: "PONG",
      clientTimestampMs: h.clock.nowMs() - 25,
      serverTimestampMs: h.clock.nowMs(),
      latestMediaPtsUs: 0,
      mode: "LIVE",
      serverRemainingBufferMs: 0,
      primaryRenderedPts: null,
      primaryFeedbackAgeMs: null,
      primaryTargetBufferMs: 10_000,
      primaryMode: "LIVE",
    });
    expect(h.store.getState().hud.rttMs).toBe(25);
    h.clock.advanceBy(6_000);
    expect(h.store.getState().hud.rttMs).toBeNull();
    expect(h.hudRoot.querySelector('[data-testid="hud-rtt-text"]')?.textContent).toBe("接続中");

    h.dispose();
  });
});
describe("仕様 07 AC-07A〜C/08/09 視覚言語・PIN 演出・VAAPI 詳細編集（V0.8.0 パリティ復元）", () => {
  it("AC-07A〜C: styles.css に減光 opacity 0.72・下部中央トースト・ドロワーブラー・タッチフィードバック・スピナー・等幅数字が含まれる", () => {
    const css = fs.readFileSync(path.join(clientDir, "src/ui/styles.css"), "utf8");
    expect(css).toContain(".hud-bar--dimmed {\n  opacity: 0.72;");
    expect(css).toContain(".toast-host");
    expect(css).toContain("backdrop-filter: blur(8px)");
    expect(css).toContain("font-variant-numeric: tabular-nums");
    expect(css).toContain("@keyframes toast-in");
    expect(css).toContain(".spinner");
    expect(css).toContain(".btn:active");
  });
  it("AC-07B: 起動中オーバーレイにスピナーと Browser/配信の稼働状態バッジを表示し、ヘルス API 実データで追従更新する", async () => {
    const h = createHarness();
    await h.store.bootstrap();
    await h.store.loginPrimaryPin("1234");
    h.authenticateWs("PRIMARY");

    h.store.dispatch({ type: "SET_POWER_STATE", powerState: "STARTING" });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.overlayRoot.querySelector('[data-testid="overlay-spinner"]')).not.toBeNull();
    expect(
      h.overlayRoot.querySelector('[data-testid="overlay-badge-browser"]')?.textContent,
    ).toContain("稼働中");
    expect(
      h.overlayRoot.querySelector('[data-testid="overlay-badge-encoder"]')?.textContent,
    ).toContain("送信中");

    // 2 秒周期のヘルスポーリングで実データが変わればバッジも追従する。
    expect(h.rest.healthResult.ok).toBe(true);
    const base = (h.rest.healthResult.ok ? h.rest.healthResult.data : null) as HealthResponse;
    h.rest.healthResult = {
      ok: true,
      status: 200,
      data: {
        ...base,
        powerState: "STOPPED",
        encoder: { ...base.encoder, running: false },
      },
    };
    h.clock.advanceBy(2_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      h.overlayRoot.querySelector('[data-testid="overlay-badge-browser"]')?.textContent,
    ).toContain("停止中");
    expect(
      h.overlayRoot.querySelector('[data-testid="overlay-badge-encoder"]')?.textContent,
    ).toContain("待機中");

    h.dispose();
  });
});
