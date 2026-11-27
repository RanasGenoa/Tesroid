import { DEFAULT_LOCALE, DEFAULT_TIMEZONE, isAllowedHttpUrl } from "@tesroid/shared";
import type { BrowserLaunchConfig } from "./ports.js";

export interface ChromePreferencesPatch {
  readonly rawJson: string;
}

const DISABLED_CHROME_FEATURES = [
  "Translate",
  "TranslateUI",
  "AutofillServerCommunication",
  "PasswordManagerOnboarding",
  "PasswordLeakDetection",
  "MediaFoundationAV1Decoding",
  "Dav1dVideoDecoder",
  "Av1Decoder",
].join(",");

const ENABLED_CHROME_FEATURES = ["VaapiVideoDecoder", "VaapiVideoDecodeLinuxGL"].join(",");

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNestedRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  return isPlainRecord(existing) ? { ...existing } : {};
}

// Spec: docs/specs/06-browser-input-cdp.md#2.1
export function buildChromeLaunchArgs(config: BrowserLaunchConfig): readonly string[] {
  if (!isAllowedHttpUrl(config.initialUrl)) {
    throw new Error("Initial URL must use http or https scheme");
  }

  const locale = config.locale.trim() || DEFAULT_LOCALE;
  const width = Math.max(1, Math.round(config.viewport.width));
  const height = Math.max(1, Math.round(config.viewport.height));

  // Hybrid rendering: CPU 2D rasterization paired with VAAPI video decode avoids Xvfb compositor deadlocks.
  return [
    `--app=${config.initialUrl}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${config.cdpPort}`,
    `--user-data-dir=${config.userDataDir}`,
    "--window-position=0,0",
    `--window-size=${width},${height}`,
    `--lang=${locale}`,
    "--password-store=basic",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-session-crashed-bubble",
    "--disable-infobars",
    "--disable-notifications",
    "--disable-translate",
    "--disable-sync",
    "--disable-gpu-rasterization",
    "--enable-accelerated-video-decode",
    `--enable-features=${ENABLED_CHROME_FEATURES}`,
    `--disable-features=${DISABLED_CHROME_FEATURES}`,
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--metrics-recording-only",
  ];
}

// Spec: docs/specs/06-browser-input-cdp.md#2.1
export function buildXvfbLaunchArgs(display: string): readonly string[] {
  return [
    display,
    "-screen",
    "0",
    "1920x1080x24",
    "+extension",
    "GLX",
    "+extension",
    "RANDR",
    "+extension",
    "RENDER",
    "-noreset",
    "-nolisten",
    "tcp",
  ];
}

// Spec: docs/specs/06-browser-input-cdp.md#2.1
export function buildPulseAudioLaunchArgs(): readonly string[] {
  return [
    "--daemonize=no",
    "--exit-idle-time=-1",
    "--disallow-exit",
    "--disable-shm",
    "-n",
    "-F",
    "/etc/pulse/tesroid.pa",
  ];
}

// Spec: docs/specs/06-browser-input-cdp.md#2.3
export function sanitizeChromePreferences(existingJson: string | null): ChromePreferencesPatch {
  let root: Record<string, unknown> = {};
  if (existingJson !== null && existingJson.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(existingJson);
      if (isPlainRecord(parsed)) {
        root = { ...parsed };
      }
    } catch {
      root = {};
    }
  }

  const profile = getNestedRecord(root, "profile");
  profile.exit_type = "Normal";
  profile.exited_cleanly = true;
  profile.password_manager_enabled = false;
  profile.password_manager_leak_detection = false;
  root.profile = profile;

  root.credentials_enable_service = false;
  root.credentials_enable_autosignin = false;

  const autofill = getNestedRecord(root, "autofill");
  autofill.enabled = false;
  autofill.profile_enabled = false;
  autofill.credit_card_enabled = false;
  root.autofill = autofill;

  const translate = getNestedRecord(root, "translate");
  translate.enabled = false;
  root.translate = translate;

  return {
    rawJson: JSON.stringify(root, null, 2),
  };
}

// Spec: docs/specs/05-encoder-gpu.md#3
export function buildChromeProcessEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  locale: string,
  timezone: string,
  display: string,
  pulseSocketPath: string,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // GALLIUM_DRIVER=d3d12 is restricted to FFmpeg/vainfo subprocesses and must never reach Chrome.
  if (env.GALLIUM_DRIVER?.trim().toLowerCase() === "d3d12") {
    delete env.GALLIUM_DRIVER;
  }
  delete env.TUNNEL_TOKEN;

  const effectiveLocale = locale.trim() || DEFAULT_LOCALE;
  const posixLocale = `${effectiveLocale.replace(/-/g, "_")}.UTF-8`;
  const effectiveTimezone = timezone.trim() || DEFAULT_TIMEZONE;
  const pulseServer = pulseSocketPath.startsWith("unix:")
    ? pulseSocketPath
    : `unix:${pulseSocketPath}`;

  env.DISPLAY = display;
  env.PULSE_SERVER = pulseServer;
  env.TZ = effectiveTimezone;
  env.LANG = posixLocale;
  env.LC_ALL = posixLocale;
  env.LANGUAGE = effectiveLocale;

  return env;
}
