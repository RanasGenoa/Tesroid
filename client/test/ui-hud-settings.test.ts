import { describe, it } from "vitest";

describe("client/ui & client/state (Spec 01, 02, 07)", () => {
  it.todo(
    "Spec 07 AC-01: places HUD bar above stream viewport with centered layout, excludes legacy buttons/language selector, and contains zero <video> or localStorage references",
  );
  it.todo(
    "Spec 07 AC-02: toggles keyboard and favorites drawers mutually exclusively, shows YouTube search bar only for strict youtube.com/youtu.be hosts, enforces 1,000 ms LIVE reset debounce, and cycles 0.25M..2.0M bitrates",
  );
  it.todo(
    "Spec 07 AC-03: rejects duplicate favorite URLs in UI, escapes XSS payloads on render, and updates HUD on settings save without optimistic overwrite on failure",
  );
  it.todo(
    "Spec 07 AC-04: renders 60..130% (10% steps) displayScale selector, falls back invalid/out-of-range values to 100% without dynamic option, and persists displayScale: 60",
  );
  it.todo(
    "Spec 01 AC-03/06 & Spec 07 AC-05: uses in-app touch PIN modal and restart confirmation modal instead of window.prompt/confirm, warns at <5 attempts, shows LOCKED on 1008, and distinguishes CONNECTION_ERROR",
  );
  it.todo(
    "Spec 02 AC-02/04: distinguishes SUPERSEDED_4000 from CONFLICT_4009 without clearing shared sessionStorage and keeps SECONDARY_STANDBY overlay intact on browser status updates",
  );
});
