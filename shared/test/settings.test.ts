import { describe, it } from "vitest";

describe("shared/settings (Spec 01, 05, 06, 07)", () => {
  it.todo(
    "Spec 01 AC-01: accepts only 4-to-8 ASCII digits for PIN and rejects 3-digit, 9-digit, alpha, symbol, and full-width digits",
  );
  it.todo(
    "Spec 01 AC-04: validates IANA timezone (<= 64 chars) and rejects unknown qualityPreset values in setup requests",
  );
  it.todo(
    "Spec 01 AC-05: expands high, standard, and lightweight quality presets consistently across GPU and CPU backends",
  );
  it.todo(
    "Spec 05 AC-01/02: clamps videoBitrate to [250k, 2.0M] bps, enforces audioBitrate [128k, 320k] bounds, and rejects incompatible backend presets",
  );
  it.todo(
    "Spec 05 AC-03: resolves standard, lightweight (0.65x, [24,30]fps, 0.5M), and custom client profiles and snaps FPS to allowed values",
  );
  it.todo("Spec 06 AC-04: defaults displayScale to 100% and clamps finite numbers to [50, 250]%");
  it.todo(
    "Spec 07 AC-02: cycles HUD bitrate steps 0.25M..2.0M and steps from out-of-list values to 1.5M",
  );
  it.todo(
    "Spec 07 AC-02 / §4.1: matches strict YouTube hosts (youtube.com, *.youtube.com, youtu.be) and rejects spoofed hosts like youtube.com.evil.example",
  );
  it.todo(
    "Spec 07 AC-03: enforces http/https schemes, <= 100 favorites, duplicate URL rejection across all operations, home-first ordering, and removal fallback",
  );
  it.todo(
    "Spec 07 AC-04: normalizes UI displayScale to 60..130% in 10% steps and falls back invalid/out-of-list values (e.g. 140, 150, NaN) to 100%",
  );
  it.todo(
    "Spec 01 §4.4: falls back corrupted or partial stored settings safely via sanitizeStoredSettings and strips pinHash in toPublicSettings",
  );
});
