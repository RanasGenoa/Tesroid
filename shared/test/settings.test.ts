import {
  addFavorite,
  applyPerformancePreset,
  clampDisplayScale,
  clampVideoBitrate,
  DEFAULT_APP_SETTINGS,
  DEFAULT_FAVORITES,
  DEFAULT_HOME_URL,
  DEFAULT_STREAM_SETTINGS,
  expandSetupQualityPreset,
  type FavoriteItem,
  HUD_BITRATE_FALLBACK_NEXT,
  HUD_BITRATE_STEPS,
  isAllowedHttpUrl,
  isPresetCompatibleWithBackend,
  isStrictYouTubeUrl,
  isValidPin,
  isValidTimezone,
  MAX_FAVORITES,
  nextHudBitrate,
  normalizeDisplayScaleForUi,
  parseSetupQualityChoice,
  removeFavorite,
  resolveClientProfile,
  resolveHomeUrl,
  SharedValidationError,
  sanitizeStoredSettings,
  setHomeFavorite,
  snapFpsToAllowed,
  toPublicSettings,
  validateFavorites,
  validateSettingsUpdate,
  validateSetupRequest,
} from "@tesroid/shared";
import { describe, expect, it } from "vitest";

describe("shared/settings (Spec 01, 05, 06, 07)", () => {
  it("Spec 01 AC-01: accepts only 4-to-8 ASCII digits for PIN and rejects 3-digit, 9-digit, alpha, symbol, and full-width digits", () => {
    expect(isValidPin("0000")).toBe(true);
    expect(isValidPin("12345678")).toBe(true);

    expect(isValidPin("")).toBe(false);
    expect(isValidPin("123")).toBe(false);
    expect(isValidPin("123456789")).toBe(false);
    expect(isValidPin("12a4")).toBe(false);
    expect(isValidPin("12-4")).toBe(false);
    expect(isValidPin("１２３４")).toBe(false);
    expect(isValidPin(" 1234")).toBe(false);
  });

  it("Spec 01 AC-04: validates IANA timezone (<= 64 chars) and rejects unknown qualityPreset values in setup requests", () => {
    expect(isValidTimezone("Asia/Tokyo")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("America/Los_Angeles")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("Asia/Tokyo ")).toBe(false);
    expect(isValidTimezone("A".repeat(65))).toBe(false);

    expect(parseSetupQualityChoice("  HIGH ")).toBe("high");
    expect(parseSetupQualityChoice("Standard")).toBe("standard");
    expect(parseSetupQualityChoice("lightweight")).toBe("lightweight");
    expect(parseSetupQualityChoice("ultra")).toBeNull();

    const validSetup = validateSetupRequest({
      pin: "1234",
      timezone: "America/New_York",
      qualityPreset: " LIGHTWEIGHT ",
    });
    expect(validSetup).toEqual({
      ok: true,
      value: { pin: "1234", timezone: "America/New_York", qualityPreset: "lightweight" },
    });

    const badTz = validateSetupRequest({ pin: "1234", timezone: "Invalid/Zone" });
    expect(badTz.ok).toBe(false);
    if (!badTz.ok) {
      expect(badTz.code).toBe("INVALID_TIMEZONE");
    }

    const badQuality = validateSetupRequest({ pin: "1234", qualityPreset: "unknown" });
    expect(badQuality.ok).toBe(false);
    if (!badQuality.ok) {
      expect(badQuality.code).toBe("INVALID_QUALITY_PRESET");
    }
  });

  it("Spec 01 AC-05: expands high, standard, and lightweight quality presets consistently across GPU and CPU backends", () => {
    const highVaapi = expandSetupQualityPreset("high", "vaapi");
    expect(highVaapi).toMatchObject({
      preset: "high",
      maxSize: 1_920,
      fps: 60,
      videoBitrate: 2_000_000,
      displayScale: 100,
      targetBufferMs: 10_000,
      vaapi: { compressionLevel: 4, lowPower: false, gpuColorConvert: true },
      clientProfile: { active: "standard" },
    });

    const highCpu = expandSetupQualityPreset("high", "software");
    expect(highCpu).toMatchObject({
      preset: "cpu_balanced",
      maxSize: 1_280,
      x264Preset: "veryfast",
      fps: 60,
      videoBitrate: 2_000_000,
      displayScale: 100,
      targetBufferMs: 10_000,
      clientProfile: { active: "standard" },
    });
    expect(highCpu.vaapi).toBeUndefined();

    const lightNvenc = expandSetupQualityPreset("lightweight", "nvenc");
    expect(lightNvenc).toMatchObject({
      preset: "low_power",
      maxSize: 960,
      fps: 24,
      videoBitrate: 500_000,
      displayScale: 70,
      targetBufferMs: 2_000,
      clientProfile: { active: "lightweight" },
    });
    expect(lightNvenc.vaapi).toBeUndefined();

    const lightCpu = expandSetupQualityPreset("lightweight", "software");
    expect(lightCpu).toMatchObject({
      preset: "cpu_low_power",
      maxSize: 960,
      x264Preset: "ultrafast",
      fps: 24,
      videoBitrate: 500_000,
      displayScale: 70,
      targetBufferMs: 2_000,
      clientProfile: { active: "lightweight" },
    });
  });

  it("Spec 05 AC-01/02: clamps videoBitrate to [250k, 2.0M] bps, enforces audioBitrate [128k, 320k] bounds, and rejects incompatible backend presets", () => {
    expect(clampVideoBitrate(100_000)).toBe(250_000);
    expect(clampVideoBitrate(1_500_000)).toBe(1_500_000);
    expect(clampVideoBitrate(5_000_000)).toBe(2_000_000);

    const clampedUpdate = validateSettingsUpdate(
      { stream: { videoBitrate: 4_500_000, audioBitrate: 192_000, maxSize: 1_280 } },
      "vaapi",
    );
    expect(clampedUpdate).toEqual({
      ok: true,
      value: { stream: { videoBitrate: 2_000_000, audioBitrate: 192_000, maxSize: 1_280 } },
    });

    const badAudio = validateSettingsUpdate({ stream: { audioBitrate: 96_000 } }, "vaapi");
    expect(badAudio.ok).toBe(false);
    if (!badAudio.ok) {
      expect(badAudio.code).toBe("INVALID_BITRATE");
    }

    expect(isPresetCompatibleWithBackend("high", "nvenc")).toBe(true);
    expect(isPresetCompatibleWithBackend("high", "software")).toBe(false);
    expect(isPresetCompatibleWithBackend("cpu_balanced", "software")).toBe(true);
    expect(isPresetCompatibleWithBackend("cpu_balanced", "vaapi")).toBe(false);

    const badPreset = validateSettingsUpdate({ stream: { preset: "high" } }, "software");
    expect(badPreset.ok).toBe(false);
    if (!badPreset.ok) {
      expect(badPreset.code).toBe("INVALID_PRESET_FOR_BACKEND");
    }

    expect(() => applyPerformancePreset(DEFAULT_STREAM_SETTINGS, "cpu_balanced", "nvenc")).toThrow(
      SharedValidationError,
    );

    const applied = applyPerformancePreset(DEFAULT_STREAM_SETTINGS, "high", "vaapi");
    expect(applied.maxSize).toBe(1_920);
    expect(applied.vaapi.compressionLevel).toBe(4);
  });

  it("Spec 05 AC-03: resolves standard, lightweight (0.65x, [24,30]fps, 0.5M), and custom client profiles and snaps FPS to allowed values", () => {
    expect(
      resolveClientProfile({
        active: "standard",
        custom: { scale: 0.8, allowedFps: [30] },
      }),
    ).toEqual({
      name: "standard",
      scale: 1.0,
      allowedFps: [24, 30, 60],
      defaultBitrateBps: 1_000_000,
    });

    expect(
      resolveClientProfile({
        active: "lightweight",
        custom: { scale: 0.8, allowedFps: [30] },
      }),
    ).toEqual({
      name: "lightweight",
      scale: 0.65,
      allowedFps: [24, 30],
      defaultBitrateBps: 500_000,
    });

    expect(
      resolveClientProfile({
        active: "custom",
        custom: { scale: 0.2, allowedFps: [60, 24, 60, 10], bitrateDefault: 3_000_000 },
      }),
    ).toEqual({
      name: "custom",
      scale: 0.4,
      allowedFps: [24, 60],
      defaultBitrateBps: 2_000_000,
    });

    // Empty or invalid custom allowedFps falls back to [24, 30, 60]
    expect(
      resolveClientProfile({
        active: "custom",
        custom: { scale: 0.75, allowedFps: [10, 15] },
      }).allowedFps,
    ).toEqual([24, 30, 60]);

    expect(snapFpsToAllowed(60, [24, 30])).toBe(30);
    expect(snapFpsToAllowed(27, [24, 30])).toBe(24);
    expect(snapFpsToAllowed(50, [24, 30, 60])).toBe(60);

    const invalidProfile = validateSettingsUpdate({ stream: { clientProfile: null } }, "vaapi");
    expect(invalidProfile.ok).toBe(false);
    if (!invalidProfile.ok) {
      expect(invalidProfile.code).toBe("INVALID_CLIENT_PROFILE");
    }
  });

  it("Spec 06 AC-04: defaults displayScale to 100% and clamps finite numbers to [50, 250]%", () => {
    expect(clampDisplayScale(undefined)).toBe(100);
    expect(clampDisplayScale(Number.NaN)).toBe(100);
    expect(clampDisplayScale(20)).toBe(50);
    expect(clampDisplayScale(175)).toBe(175);
    expect(clampDisplayScale(400)).toBe(250);
  });

  it("Spec 07 AC-02: cycles HUD bitrate steps 0.25M..2.0M and steps from out-of-list values to 1.5M", () => {
    for (let i = 0; i < HUD_BITRATE_STEPS.length; i += 1) {
      const current = HUD_BITRATE_STEPS[i];
      const expected = HUD_BITRATE_STEPS[(i + 1) % HUD_BITRATE_STEPS.length];
      expect(current).toBeDefined();
      expect(expected).toBeDefined();
      if (current !== undefined && expected !== undefined) {
        expect(nextHudBitrate(current)).toBe(expected);
      }
    }
    expect(nextHudBitrate(1_200_000)).toBe(HUD_BITRATE_FALLBACK_NEXT);
  });

  it("Spec 07 AC-02 / §4.1: matches strict YouTube hosts (youtube.com, *.youtube.com, youtu.be) and rejects spoofed hosts like youtube.com.evil.example", () => {
    expect(isStrictYouTubeUrl("https://www.youtube.com/watch?v=abc")).toBe(true);
    expect(isStrictYouTubeUrl("https://youtube.com")).toBe(true);
    expect(isStrictYouTubeUrl("https://music.youtube.com")).toBe(true);
    expect(isStrictYouTubeUrl("https://youtu.be/abc")).toBe(true);

    expect(isStrictYouTubeUrl("https://youtube.com.evil.example/watch")).toBe(false);
    expect(isStrictYouTubeUrl("https://notyoutube.com")).toBe(false);
    expect(isStrictYouTubeUrl("javascript:alert(1)")).toBe(false);
    expect(isStrictYouTubeUrl("ftp://www.youtube.com")).toBe(false);
  });

  it("Spec 07 AC-03: enforces http/https schemes, <= 100 favorites, duplicate URL rejection across all operations, home-first ordering, and removal fallback", () => {
    expect(isAllowedHttpUrl("https://example.com")).toBe(true);
    expect(isAllowedHttpUrl("http://localhost:8080")).toBe(true);
    expect(isAllowedHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedHttpUrl("javascript:alert(1)")).toBe(false);

    // Rejects duplicate normalized URLs in validateFavorites & addFavorite
    const dupList = validateFavorites([
      { id: "a", title: "A", url: "https://example.com", isHome: true },
      { id: "b", title: "B", url: "https://example.com/", isHome: false },
    ]);
    expect(dupList.ok).toBe(false);
    if (!dupList.ok) {
      expect(dupList.code).toBe("DUPLICATE_FAVORITE_URL");
    }

    const dupAdd = addFavorite(DEFAULT_FAVORITES, {
      id: "yt2",
      title: "YT2",
      url: "https://www.youtube.com/",
    });
    expect(dupAdd.ok).toBe(false);
    if (!dupAdd.ok) {
      expect(dupAdd.code).toBe("DUPLICATE_FAVORITE_URL");
    }

    // Exceeding 100 items
    const hundredItems: FavoriteItem[] = Array.from({ length: MAX_FAVORITES }, (_, idx) => ({
      id: `id-${idx}`,
      title: `Site ${idx}`,
      url: `https://site-${idx}.example.com`,
      isHome: idx === 0,
    }));
    expect(validateFavorites(hundredItems).ok).toBe(true);
    const overLimit = addFavorite(hundredItems, {
      id: "id-100",
      title: "Over",
      url: "https://over.example.com",
    });
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) {
      expect(overLimit.code).toBe("FAVORITES_LIMIT_EXCEEDED");
    }

    // Insertion index: index 1 when index 0 is home, index 0 otherwise
    const addedAfterHome = addFavorite(
      [
        { id: "home", title: "Home", url: "https://home.example.com", isHome: true },
        { id: "two", title: "Two", url: "https://two.example.com", isHome: false },
      ],
      { id: "new", title: "New", url: "https://new.example.com" },
    );
    expect(addedAfterHome.ok).toBe(true);
    if (addedAfterHome.ok) {
      expect(addedAfterHome.value.map((f) => f.id)).toEqual(["home", "new", "two"]);
    }

    const addedWhenHomeNotFirst = addFavorite(
      [
        { id: "one", title: "One", url: "https://one.example.com", isHome: false },
        { id: "home", title: "Home", url: "https://home.example.com", isHome: true },
      ],
      { id: "new", title: "New", url: "https://new.example.com" },
    );
    expect(addedWhenHomeNotFirst.ok).toBe(true);
    if (addedWhenHomeNotFirst.ok) {
      expect(addedWhenHomeNotFirst.value.map((f) => f.id)).toEqual(["new", "one", "home"]);
    }

    // setHomeFavorite moves item to index 0 and preserves relative order of others
    const rehomed = setHomeFavorite(
      [
        { id: "a", title: "A", url: "https://a.example.com", isHome: true },
        { id: "b", title: "B", url: "https://b.example.com", isHome: false },
        { id: "c", title: "C", url: "https://c.example.com", isHome: false },
      ],
      "c",
    );
    expect(rehomed.map((f) => `${f.id}:${f.isHome}`)).toEqual(["c:true", "a:false", "b:false"]);

    // removeFavorite promotes remaining[0] when home is removed, and falls back to DEFAULT_HOME_URL when empty
    const afterRemoveHome = removeFavorite(rehomed, "c");
    expect(afterRemoveHome.map((f) => `${f.id}:${f.isHome}`)).toEqual(["a:true", "b:false"]);
    expect(resolveHomeUrl(afterRemoveHome)).toBe("https://a.example.com");

    const afterRemoveAll = removeFavorite(
      [{ id: "only", title: "Only", url: "https://only.example.com", isHome: true }],
      "only",
    );
    expect(afterRemoveAll).toEqual([]);
    expect(resolveHomeUrl(afterRemoveAll)).toBe(DEFAULT_HOME_URL);
  });

  it("Spec 07 AC-04: normalizes UI displayScale to 60..130% in 10% steps and falls back invalid/out-of-list values (e.g. 140, 150, NaN) to 100%", () => {
    for (const valid of [60, 70, 80, 90, 100, 110, 120, 130]) {
      expect(normalizeDisplayScaleForUi(valid)).toBe(valid);
      expect(normalizeDisplayScaleForUi(String(valid))).toBe(valid);
    }
    for (const invalid of [50, 65, 140, 150, Number.NaN, "", "   ", null, undefined]) {
      expect(normalizeDisplayScaleForUi(invalid)).toBe(100);
    }
  });

  it("Spec 01 §4.4: falls back corrupted or partial stored settings safely via sanitizeStoredSettings and strips pinHash in toPublicSettings", () => {
    const corrupted = sanitizeStoredSettings("not-an-object");
    expect(corrupted).toEqual(DEFAULT_APP_SETTINGS);

    // isSetupCompleted without valid pinHash must fall back to false
    const partial = sanitizeStoredSettings({
      isSetupCompleted: true,
      pinHash: null,
      timezone: "Invalid/Zone",
      stream: {
        fps: 999,
        videoBitrate: 5_000_000,
        displayScale: "bad",
        clientProfile: { active: "unknown", custom: { scale: 0.1, allowedFps: [] } },
      },
      favorites: "corrupted",
    });
    expect(partial.isSetupCompleted).toBe(false);
    expect(partial.pinHash).toBeNull();
    expect(partial.timezone).toBe("Asia/Tokyo");
    expect(partial.stream.fps).toBe(60);
    expect(partial.stream.videoBitrate).toBe(2_000_000);
    expect(partial.stream.displayScale).toBe(100);
    expect(partial.stream.clientProfile.active).toBe("standard");
    expect(partial.favorites.length).toBe(DEFAULT_FAVORITES.length);

    const publicView = toPublicSettings({
      ...DEFAULT_APP_SETTINGS,
      isSetupCompleted: true,
      pinHash: "$2b$10$secretHashValue",
    });
    expect("pinHash" in publicView).toBe(false);
    expect(publicView.isSetupCompleted).toBe(true);
  });
});
