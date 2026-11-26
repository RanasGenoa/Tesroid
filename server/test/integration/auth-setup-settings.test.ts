import { describe, it } from "vitest";

describe("Integration: Auth, Setup & Settings (Spec 01, 05, 07)", () => {
  it.todo(
    "Spec 01 AC-01: rejects invalid PINs with HTTP 400 and revokes all active session tokens immediately on valid PIN change via PUT /api/settings",
  );
  it.todo(
    "Spec 01 AC-02: rejects expired tokens (>= 24h TTL) and allows valid initial PIN over WS /ws when setup is incomplete",
  );
  it.todo(
    "Spec 01 AC-03: persists consecutive PIN failures to lockout.json, sends WS 1008 + exits(1) after 200ms on 10th failure, and aborts startup if locked",
  );
  it.todo(
    "Spec 01 AC-04: rejects invalid timezone or unknown qualityPreset with HTTP 400 and rejects POST /api/setup with HTTP 403 once completed",
  );
  it.todo(
    "Spec 01 AC-05: expands lightweight preset (0.65x, 24fps, 0.5M, 70% scale, 2,000 ms buffer) and returns HTTP 200 even if partial live-apply fails",
  );
  it.todo(
    "Spec 05 AC-02/03 & Spec 07 AC-03: rejects duplicate favorite URLs across all paths, clamps videoBitrate to 2.0M, and propagates maxSize immediately",
  );
});
