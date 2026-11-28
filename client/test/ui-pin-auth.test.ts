import { WS_CLOSE_CODE } from "@tesroid/shared";
import { describe, expect, it } from "vitest";
import { createHarness } from "./helpers/ui-harness.js";

describe("client/ui & client/state (Spec 01, 02, 07)", () => {
  it("Spec 01 AC-03/06 & Spec 07 AC-05: uses in-app touch PIN modal and restart confirmation modal instead of window.prompt/confirm, warns at <5 attempts, shows LOCKED on 1008, and distinguishes CONNECTION_ERROR", async () => {
    const h = createHarness();

    // Network error on /api/status goes to CONNECTION_ERROR (not PIN)
    h.rest.statusResult = {
      ok: false,
      status: 0,
      error: "ECONNREFUSED",
      code: "NETWORK_ERROR",
    };
    await h.store.bootstrap();
    expect(h.store.getState().route).toBe("CONNECTION_ERROR");
    expect(h.statusRoot.querySelector('[data-testid="route-connection-error"]')).not.toBeNull();

    // Unauthenticated settings open launches in-app pin_reauth modal (no window.prompt)
    h.store.openSettingsWithAuthCheck();
    expect(h.store.getState().activeModal.kind).toBe("pin_reauth");
    expect(h.appModalRoot.querySelector('[data-testid="modal-pin_reauth"]')).not.toBeNull();

    // Failed reauth with remainingAttempts = 4 triggers warning styling (< 5)
    h.rest.verifyPinResult = {
      ok: false,
      status: 401,
      error: "Invalid PIN",
      code: "INVALID_PIN",
      data: { ok: false, remainingAttempts: 4, error: "Invalid PIN" },
    };
    const reauthOk = await h.store.submitPinReauth("9999");
    expect(reauthOk).toBe(false);
    expect(h.store.getState().remainingPinAttempts).toBe(4);
    expect(h.appModalRoot.querySelector('[data-testid="reauth-attempts"]')?.className).toContain(
      "attempts-badge--warn",
    );
    h.store.closeModal();

    // Healthy status -> PIN screen -> login -> power modal -> in-app restart confirm modal -> power APIs
    h.rest.statusResult = {
      ok: true,
      status: 200,
      data: {
        isSetupCompleted: true,
        hasActiveSession: false,
        powerState: "ACTIVE",
        consecutiveFailures: 0,
        isLocked: false,
        remainingAttempts: 10,
        locale: "ja-JP",
      },
    };
    await h.store.bootstrap();
    expect(h.store.getState().route).toBe("PIN");
    await h.store.loginPrimaryPin("1234");
    h.authenticateWs("PRIMARY");

    h.hudRoot.querySelector('[data-action="open-power"]')?.click();
    expect(h.store.getState().activeModal.kind).toBe("power_control");
    h.appModalRoot.querySelector('[data-action="power-restart-open"]')?.click();
    expect(h.store.getState().activeModal.kind).toBe("restart_confirm");
    h.appModalRoot.querySelector('[data-action="restart-execute"]')?.click();
    await Promise.resolve();
    expect(h.rest.calls).toContain("POST /api/power/restart-browser");

    // WS close 1008 -> LOCKED route
    h.transport.triggerClose(WS_CLOSE_CODE.POLICY_VIOLATION, "Locked", true);
    expect(h.store.getState().route).toBe("LOCKED");
    expect(h.statusRoot.querySelector('[data-testid="route-locked"]')).not.toBeNull();

    h.dispose();
  });
  it("Spec 02 AC-02/04: distinguishes SUPERSEDED_4000 from CONFLICT_4009 without clearing shared sessionStorage and keeps SECONDARY_STANDBY overlay intact on browser status updates", async () => {
    // 4000 preserves sessionStorage; 4009 enters CONFLICT_4009
    const h = createHarness({
      initialSession: { token: "shared-tab-token", role: "PRIMARY" },
    });
    await h.store.bootstrap();
    h.authenticateWs("PRIMARY", undefined, "shared-tab-token");

    h.transport.triggerClose(WS_CLOSE_CODE.SESSION_SUPERSEDED, "Superseded", true);
    expect(h.store.getState().route).toBe("SUPERSEDED_4000");
    expect(h.sessionStorage.load()?.token).toBe("shared-tab-token");
    expect(h.statusRoot.querySelector('[data-testid="route-superseded-4000"]')).not.toBeNull();

    h.transport.triggerClose(WS_CLOSE_CODE.SESSION_CONFLICT, "Conflict", true);
    expect(h.store.getState().route).toBe("CONFLICT_4009");
    expect(h.statusRoot.querySelector('[data-testid="route-conflict-4009"]')).not.toBeNull();
    h.dispose();

    // SECONDARY_STANDBY overlay must NOT be overwritten by BROWSER_STATUS
    const rear = createHarness();
    await rear.store.bootstrap();
    await rear.store.loginSecondaryPin("1234", true);
    rear.authenticateWs("SECONDARY_STANDBY");

    expect(rear.overlayRoot.querySelector('[data-testid="overlay-rear-standby"]')).not.toBeNull();
    rear.transport.triggerControl({
      type: "BROWSER_STATUS",
      powerState: "ACTIVE",
      streamEpoch: 5,
    });
    expect(rear.store.getState().role).toBe("SECONDARY_STANDBY");
    expect(rear.store.getState().streamingState.kind).toBe("STANDBY");
    expect(rear.overlayRoot.querySelector('[data-testid="overlay-rear-standby"]')).not.toBeNull();

    // PRIMARY_SESSION_STATUS active=true promotes to SECONDARY_STREAMING and clears standby overlay
    rear.transport.triggerControl({
      type: "PRIMARY_SESSION_STATUS",
      active: true,
      streamEpoch: 6,
    });
    expect(rear.store.getState().role).toBe("SECONDARY_STREAMING");
    expect(rear.overlayRoot.querySelector('[data-testid="overlay-rear-standby"]')).toBeNull();

    rear.dispose();
  });
});
describe("仕様 07 AC-07A〜C/08/09 視覚言語・PIN 演出・VAAPI 詳細編集（V0.8.0 パリティ復元）", () => {
  it("AC-08: PIN 画面の右上メニューは 3 入口、規定桁数未満の入口は視覚的に無効化しトーストで理由を表示、規定桁数では入力中 PIN をプリフィルした再認証で設定を開く", async () => {
    const h = createHarness();
    await h.store.bootstrap();
    expect(h.store.getState().route).toBe("PIN");

    h.statusRoot.querySelector('[data-action="toggle-pin-menu"]')?.click();
    const popover = h.statusRoot.querySelector('[data-testid="pin-menu-popover"]');
    expect(popover).not.toBeNull();
    for (const action of [
      "open-guide-from-pin",
      "connect-rear-standby",
      "open-settings-from-pin",
    ]) {
      expect(popover?.querySelector(`[data-action="${action}"]`)).not.toBeNull();
    }

    const disabledEntry = popover?.querySelector('[data-action="open-settings-from-pin"]');
    expect(disabledEntry?.className).toContain("btn--disabled-look");
    disabledEntry?.click();
    expect(h.doc.body.querySelector('[data-testid="app-toast"]')?.textContent).toContain("4 桁");

    for (const key of ["1", "2", "3", "4"]) {
      h.statusRoot.querySelector(`[data-pin-key="${key}"]`)?.click();
    }
    expect(h.statusRoot.querySelector('[data-testid="pin-attempts"]')?.textContent).toBe("10 / 10");

    // テンキー入力で再描画済み（menuOpen は維持）の入口状態を検証する。
    const entry = h.statusRoot.querySelector('[data-action="open-settings-from-pin"]');
    expect(entry).not.toBeNull();
    expect(entry?.className).not.toContain("btn--disabled-look");
    entry?.click();
    expect(h.store.getState().activeModal.kind).toBe("pin_reauth");
    expect(h.appModalRoot.querySelector('[data-testid="reauth-pin-display"]')?.textContent).toBe(
      "●●●●",
    );

    h.dispose();
  });
});
