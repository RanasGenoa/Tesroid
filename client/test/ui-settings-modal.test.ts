import fs from "node:fs";
import path from "node:path";
import { DEFAULT_APP_SETTINGS, type HealthResponse, toPublicSettings } from "@tesroid/shared";
import { describe, expect, it } from "vitest";
import { SETTINGS_UPDATED_EVENT_NAME } from "../src/state/index.js";
import { clientDir, createHarness, type MockElement, MockEvent } from "./helpers/ui-harness.js";

describe("client/ui & client/state (Spec 01, 02, 07)", () => {
  it("Spec 07 AC-03: rejects duplicate favorite URLs in UI, escapes XSS payloads on render, and updates HUD on settings save without optimistic overwrite on failure", async () => {
    const h = createHarness();
    await h.store.bootstrap();
    await h.store.loginPrimaryPin("1234");
    h.authenticateWs("PRIMARY");

    // Current page matches existing YouTube favorite -> rejected in HUD favorites drawer
    h.transport.triggerControl({
      type: "PAGE_INFO",
      url: "https://www.youtube.com",
      title: "YouTube",
    });
    h.hudRoot.querySelector('[data-action="toggle-favorites"]')?.click();
    h.hudRoot.querySelector('[data-action="favorites-add-current"]')?.click();
    await Promise.resolve();
    expect(h.hudRoot.querySelector('[data-testid="favorites-drawer-error"]')).not.toBeNull();
    expect(h.rest.updatePatches).toHaveLength(0);

    // Settings Browser tab: reject duplicate manual add, reject duplicate edit, escape XSS payload
    h.store.openModal({ kind: "settings", activeTab: "browser" });
    const titleInput = h.settingsModalRoot.querySelector('[data-testid="settings-fav-add-title"]');
    const urlInput = h.settingsModalRoot.querySelector('[data-testid="settings-fav-add-url"]');
    expect(titleInput).not.toBeNull();
    expect(urlInput).not.toBeNull();

    if (titleInput && urlInput) {
      titleInput.value = "Dup YT";
      titleInput.dispatchEvent(new MockEvent("input"));
      urlInput.value = "https://www.youtube.com";
      urlInput.dispatchEvent(new MockEvent("input"));
    }
    h.settingsModalRoot.querySelector('[data-action="settings-fav-add-manual"]')?.click();
    await Promise.resolve();
    expect(
      h.settingsModalRoot.querySelector('[data-testid="settings-browser-error"]'),
    ).not.toBeNull();
    expect(h.rest.updatePatches).toHaveLength(0);

    // Valid XSS-containing title is saved and HTML-escaped on render
    if (titleInput && urlInput) {
      titleInput.value = "<img src=x onerror=alert(1)>";
      titleInput.dispatchEvent(new MockEvent("input"));
      urlInput.value = "https://example.org/safe";
      urlInput.dispatchEvent(new MockEvent("input"));
    }
    h.settingsModalRoot.querySelector('[data-action="settings-fav-add-manual"]')?.click();
    await Promise.resolve();
    expect(
      h.store.getState().settings?.favorites.some((f) => f.url === "https://example.org/safe"),
    ).toBe(true);
    expect(h.settingsModalRoot.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(h.settingsModalRoot.innerHTML).not.toContain("<img src=x");

    // Failed PUT /api/settings never optimistically overwrites settings
    const beforeFavorites = h.store.getState().settings?.favorites;
    h.rest.updateSettingsResults.push({
      ok: false,
      status: 500,
      error: "Write failed",
      code: "INTERNAL_ERROR",
    });
    const saveOk = await h.store.saveSettings({
      favorites: DEFAULT_APP_SETTINGS.favorites.slice(0, 1),
    });
    expect(saveOk).toBe(false);
    expect(h.store.getState().settings?.favorites).toEqual(beforeFavorites);
    expect(h.store.getState().errorBanner).toBe("Write failed");

    // Successful save notifies via callback and CustomEvent
    const ok2 = await h.store.saveSettings({ stream: { fps: 60 } });
    expect(ok2).toBe(true);
    expect(h.settingsEvents.at(-1)?.stream.fps).toBe(60);
    expect(h.hudRoot.querySelector('[data-action="cycle-fps"]')?.textContent).toBe("60 FPS");
    expect(SETTINGS_UPDATED_EVENT_NAME).toBe("tesroid:settings-updated");

    h.dispose();
  });
  it("Spec 07 AC-04: display scale offers fixed 10% steps 60..130 via the touch picker, falls back invalid/out-of-range saved values to 100% without dynamic options, and persists displayScale: 60 immediately on option tap", async () => {
    const h = createHarness();
    await h.store.bootstrap();
    await h.store.loginPrimaryPin("1234");
    h.authenticateWs("PRIMARY", {
      ...toPublicSettings(DEFAULT_APP_SETTINGS),
      stream: {
        ...DEFAULT_APP_SETTINGS.stream,
        displayScale: 150,
      },
    });

    h.store.openModal({ kind: "settings", activeTab: "general" });
    const control = h.settingsModalRoot.querySelector('[data-testid="settings-display-scale"]');
    expect(control).not.toBeNull();
    // Out-of-range 150 falls back to the default label without a dynamic option
    expect(control?.textContent).toBe("100% (既定)");

    control?.click();
    const rows =
      h.doc.body
        .querySelector('[data-testid="picker-settings-display-scale"]')
        ?.querySelectorAll(".picker-option") ?? [];
    expect(rows.map((r) => r.getAttribute("data-option-value"))).toEqual([
      "60",
      "70",
      "80",
      "90",
      "100",
      "110",
      "120",
      "130",
    ]);
    expect(rows.some((r) => r.getAttribute("data-option-value") === "150")).toBe(false);

    rows.find((r) => r.getAttribute("data-option-value") === "60")?.click();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(h.rest.updatePatches.at(-1)?.stream?.displayScale).toBe(60);
    expect(h.store.getState().settings?.stream.displayScale).toBe(60);

    h.dispose();
  });
  it("Spec 07 AC-06: client source and index.html contain zero native <select> elements (all selection flows use the in-app touch picker)", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          const source = fs.readFileSync(full, "utf8");
          if (
            /el\(\s*doc,\s*"select"/.test(source) ||
            source.includes('createElement("select")') ||
            source.includes("<select") ||
            source.includes("form-select")
          ) {
            offenders.push(path.relative(clientDir, full));
          }
        }
      }
    };
    walk(path.join(clientDir, "src"));
    const indexHtml = fs.readFileSync(path.join(clientDir, "index.html"), "utf8");
    expect(indexHtml.includes("<select")).toBe(false);
    expect(offenders).toEqual([]);
  });
  it("Spec 07 AC-06: tapping the display scale control opens an in-app picker with the fixed steps and no native option elements", async () => {
    const h = createHarness();
    await h.store.bootstrap();
    await h.store.loginPrimaryPin("1234");
    h.authenticateWs("PRIMARY");

    h.store.openModal({ kind: "settings", activeTab: "general" });
    h.settingsModalRoot.querySelector('[data-testid="settings-display-scale"]')?.click();

    const picker = h.doc.body.querySelector('[data-testid="picker-settings-display-scale"]');
    expect(picker).not.toBeNull();
    const rows = picker?.querySelectorAll(".picker-option") ?? [];
    expect(rows.map((r) => r.getAttribute("data-option-value"))).toEqual([
      "60",
      "70",
      "80",
      "90",
      "100",
      "110",
      "120",
      "130",
    ]);
    expect(picker?.querySelectorAll("option")).toHaveLength(0);

    h.dispose();
  });
  it("Spec 07 AC-06: tapping a picker option confirms immediately, saves via PUT /api/settings for that field only, and closes the picker", async () => {
    const h = createHarness();
    await h.store.bootstrap();
    await h.store.loginPrimaryPin("1234");
    h.authenticateWs("PRIMARY");

    h.store.openModal({ kind: "settings", activeTab: "general" });
    h.settingsModalRoot.querySelector('[data-testid="settings-target-buffer"]')?.click();
    const picker = h.doc.body.querySelector('[data-testid="picker-settings-target-buffer"]');
    expect(picker).not.toBeNull();
    const rows = picker?.querySelectorAll(".picker-option") ?? [];
    expect(rows.map((r) => r.getAttribute("data-option-value"))).toEqual([
      "0",
      "2000",
      "5000",
      "10000",
      "20000",
      "30000",
    ]);

    const rowFor = (value: string): MockElement | undefined =>
      rows.find((r) => r.getAttribute("data-option-value") === value);
    rowFor("5000")?.click();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(h.rest.updatePatches.at(-1)?.stream?.targetBufferMs).toBe(5000);
    expect(h.store.getState().settings?.stream.targetBufferMs).toBe(5000);
    expect(h.doc.body.querySelector('[data-testid="picker-settings-target-buffer"]')).toBeNull();

    h.dispose();
  });
  it("Spec 07 AC-06: tapping the picker background closes only the picker and changes no value", async () => {
    const h = createHarness();
    await h.store.bootstrap();
    await h.store.loginPrimaryPin("1234");
    h.authenticateWs("PRIMARY");

    h.store.openModal({ kind: "settings", activeTab: "general" });
    const patchesBefore = h.rest.updatePatches.length;
    h.settingsModalRoot.querySelector('[data-testid="settings-audio-bitrate"]')?.click();
    const backdrop = h.doc.body.querySelector('[data-testid="picker-settings-audio-bitrate"]');
    expect(backdrop).not.toBeNull();

    backdrop?.dispatchEvent(new MockEvent("click"));

    expect(h.rest.updatePatches.length).toBe(patchesBefore);
    expect(h.store.getState().settings?.stream.audioBitrate).toBe(
      DEFAULT_APP_SETTINGS.stream.audioBitrate,
    );
    expect(h.doc.body.querySelector('[data-testid="picker-settings-audio-bitrate"]')).toBeNull();

    h.dispose();
  });
  it("Spec 07 AC-06: preset and client profile controls open pickers with backend-compatible fixed choices", async () => {
    const h = createHarness();
    await h.store.bootstrap();
    await h.store.loginPrimaryPin("1234");
    h.authenticateWs("PRIMARY");

    h.store.openModal({ kind: "settings", activeTab: "general" });
    h.settingsModalRoot.querySelector('[data-testid="settings-video-preset"]')?.click();
    const presetRows =
      h.doc.body
        .querySelector('[data-testid="picker-settings-video-preset"]')
        ?.querySelectorAll(".picker-option") ?? [];
    expect(presetRows.map((r) => r.getAttribute("data-option-value"))).toEqual([
      "high",
      "balanced",
      "low_power",
      "custom",
    ]);

    h.settingsModalRoot.querySelector('[data-testid="settings-client-profile"]')?.click();
    const profileRows =
      h.doc.body
        .querySelector('[data-testid="picker-settings-client-profile"]')
        ?.querySelectorAll(".picker-option") ?? [];
    expect(profileRows.map((r) => r.getAttribute("data-option-value"))).toEqual([
      "standard",
      "lightweight",
      "custom",
    ]);

    h.dispose();
  });
});
describe("仕様 07 AC-07A〜C/08/09 視覚言語・PIN 演出・VAAPI 詳細編集（V0.8.0 パリティ復元）", () => {
  it("AC-09: VAAPI 稼働時の詳細編集に圧縮優先度 1〜7 ピッカーと 2 トグルを表示し、PUT /api/settings へ保存して成功トーストを出す", async () => {
    const h = createHarness();
    await h.store.bootstrap();
    await h.store.loginPrimaryPin("1234");
    h.authenticateWs("PRIMARY");
    await h.store.fetchHealth();

    h.store.openModal({ kind: "settings", activeTab: "general" });
    const details = h.settingsModalRoot.querySelector('[data-testid="settings-vaapi-details"]');
    expect(details).not.toBeNull();
    expect(
      h.settingsModalRoot.querySelector('[data-testid="settings-vaapi-disabled-reason"]'),
    ).toBeNull();

    details?.querySelector('[data-testid="settings-vaapi-compression"]')?.click();
    const rows =
      h.doc.body
        .querySelector('[data-testid="picker-settings-vaapi-compression"]')
        ?.querySelectorAll(".picker-option") ?? [];
    expect(rows.map((r) => r.getAttribute("data-option-value"))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
    ]);
    rows.find((r) => r.getAttribute("data-option-value") === "3")?.click();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    h.settingsModalRoot.querySelector('[data-action="settings-toggle-vaapi-color"]')?.click();
    h.settingsModalRoot.querySelector('[data-action="settings-toggle-vaapi-lowpower"]')?.click();
    h.settingsModalRoot.querySelector('[data-action="settings-general-save"]')?.click();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(h.rest.updatePatches.at(-1)?.stream?.vaapi).toEqual({
      compressionLevel: 3,
      lowPower: true,
      gpuColorConvert: false,
    });
    expect(h.doc.body.querySelector('[data-testid="app-toast"]')?.textContent).toContain(
      "設定を保存しました",
    );

    h.dispose();
  });
  it("AC-09: NVENC 稼働時は VAAPI 詳細コントロールを非表示とし、無効化理由の文案を表示する", async () => {
    const h = createHarness();
    expect(h.rest.healthResult.ok).toBe(true);
    const base = (h.rest.healthResult.ok ? h.rest.healthResult.data : null) as HealthResponse;
    h.rest.healthResult = {
      ok: true,
      status: 200,
      data: { ...base, encoder: { ...base.encoder, backend: "nvenc" } },
    };
    await h.store.bootstrap();
    await h.store.loginPrimaryPin("1234");
    h.authenticateWs("PRIMARY");
    await h.store.fetchHealth();

    h.store.openModal({ kind: "settings", activeTab: "general" });
    expect(h.settingsModalRoot.querySelector('[data-testid="settings-vaapi-details"]')).toBeNull();
    const reason = h.settingsModalRoot.querySelector(
      '[data-testid="settings-vaapi-disabled-reason"]',
    );
    expect(reason?.textContent).toContain("NVENC");

    h.dispose();
  });
});
