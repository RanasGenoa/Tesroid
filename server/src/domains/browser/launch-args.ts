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
  // コンテナ内 PulseAudio ソケットへ Chrome 音声サービスが到達するための無効化（V0.8.0 実測準拠）。
  "AudioServiceSandbox",
].join(",");

const ENABLED_CHROME_FEATURES = ["AcceleratedVideoDecodeLinuxGL", "VaapiIgnoreDriverChecks"].join(
  ",",
);

// Dockerfile の /etc/pulse/tesroid.pa が生成する仮想シンクと同一名称で一致させる（pulse-socket 整合テストで強制）。
export const VIRTUAL_SINK_NAME = "virtual_sink";

// 起動後自己修復の再ロード引数は `.pa` 焼き込み行と同一構成でなければならない（同じ整合テストで一致を検証）。
export function buildNullSinkModuleArgs(): readonly string[] {
  return [
    "load-module",
    "module-null-sink",
    `sink_name=${VIRTUAL_SINK_NAME}`,
    "rate=48000",
    "channels=2",
    "format=s16le",
    "sink_properties=device.description=Tesroid_Virtual_Sink",
  ];
}

// Chrome バイナリは固定シンボルリンク名に依存せず、実行可能な最初の候補を選ぶ（仕様 06 §2.1）。
export const CHROME_BINARY_CANDIDATES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium-browser",
  "chromium",
] as const;

// --lang と Preferences の両方で同一順序を明示するため、LOCALE から Accept-Language 順序リストを導出する。
export function deriveAcceptLanguages(locale: string): string {
  const effective = locale.trim() || DEFAULT_LOCALE;
  const primary = effective.split("-")[0] ?? effective;
  const ordered = [effective];
  if (primary !== effective) {
    ordered.push(primary);
  }
  if (!ordered.includes("en-US")) {
    ordered.push("en-US");
  }
  if (!ordered.includes("en")) {
    ordered.push("en");
  }
  return ordered.join(",");
}

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
  // Chrome 131+ renamed the VAAPI decode features, and ANGLE/llvmpipe under Xvfb rejects DRI
  // auto-probing, so the detected render node must be bound explicitly.
  return [
    `--app=${config.initialUrl}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${config.cdpPort}`,
    `--user-data-dir=${config.userDataDir}`,
    "--window-position=0,0",
    `--window-size=${width},${height}`,
    `--lang=${locale}`,
    `--accept-lang=${deriveAcceptLanguages(locale)}`,
    "--password-store=basic",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--disable-notifications",
    "--disable-translate",
    "--disable-sync",
    // タッチ能力検出で UI を切り替えるサイトがあるため Blink のタッチ機能を明示有効化する（車載はタッチのみ）。
    "--touch-events=enabled",
    // 車載眩低減のためダークテーマを Cookie に加え恒久化する。
    "--force-dark-mode",
    // GPU プロセスの /dev/dri アクセス担保（VAAPI デコードはコンテナ内サンドボックス外アクセスが必要）。
    "--disable-gpu-sandbox",
    // 仮想 GPU 構成では Chrome の GPU ブロックリストが HW 動画デコード判定自体を無効化するため除外する。
    "--ignore-gpu-blocklist",
    // 三点セット（enable-features / ignore-gpu-blocklist / render-node-override）以外の GPU 強制フラグは
    // Xvfb 構成で GPU 機能全体を Software へ退行させる（実機 chrome://gpu 実測: 付与時 Video Decode Software only）。
    `--enable-features=${ENABLED_CHROME_FEATURES}`,
    `--disable-features=${DISABLED_CHROME_FEATURES}`,
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--metrics-recording-only",
    ...(config.vaapiRenderNode ? [`--render-node-override=${config.vaapiRenderNode}`] : []),
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
export function sanitizeChromePreferences(
  existingJson: string | null,
  acceptLanguages: string,
): ChromePreferencesPatch {
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

  // --accept-lang と同一順序を Preferences 側にも明示し、Accept-Language の暗黙フォールバックを排除する。
  const intl = getNestedRecord(root, "intl");
  intl.accept_languages = acceptLanguages;
  intl.selected_languages = acceptLanguages;
  root.intl = intl;

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
  vaapiDriverName: string | null,
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
  // 既定シンクへの暗黙依存を排除し、仮想シンクへ明示バインドする。
  env.PULSE_SINK = VIRTUAL_SINK_NAME;
  // 検出済み VAAPI ドライバ名のみを明示伝播する（--render-node-override と同一供給源）。
  // 検出 null で既定値を注入しないのは仕様 09 §2.4 の境界どおり（無条件の既定値エクスポートは禁止）。
  if (vaapiDriverName !== null && vaapiDriverName.trim().length > 0) {
    env.LIBVA_DRIVER_NAME = vaapiDriverName.trim();
  } else {
    delete env.LIBVA_DRIVER_NAME;
  }
  env.TZ = effectiveTimezone;
  env.LANG = posixLocale;
  env.LC_ALL = posixLocale;
  env.LANGUAGE = effectiveLocale;

  return env;
}
