import * as fs from "node:fs/promises";
import path from "node:path";
import {
  type AlignedDimensions,
  clampDisplayScale,
  isAllowedHttpUrl,
  resolveHomeUrl,
  type SpecialKey,
  type TouchFrame,
} from "@tesroid/shared";
import type {
  Clock,
  ManagedProcess,
  ProcessRunner,
  ProcessTreeController,
  TimerHandle,
} from "../../infra/index.js";
import type { SettingsRepository } from "../settings/ports.js";
import type { BrowserInputRouter, DroppedInputKind } from "./input-router.js";
import {
  buildChromeLaunchArgs,
  buildChromeProcessEnv,
  buildNullSinkModuleArgs,
  buildPulseAudioLaunchArgs,
  buildXvfbLaunchArgs,
  CHROME_BINARY_CANDIDATES,
  deriveAcceptLanguages,
  sanitizeChromePreferences,
  VIRTUAL_SINK_NAME,
} from "./launch-args.js";
import { buildCombinedPageInitScript } from "./page-scripts.js";
import type {
  BrowserControlPort,
  BrowserLaunchConfig,
  BrowserPageInfo,
  CdpClientPort,
  PageNavigationEvent,
} from "./ports.js";

const PULSE_READY_TIMEOUT_MS = 3_000;
const PULSE_READY_POLL_MS = 100;
const CDP_RECONNECT_INTERVAL_MS = 2_000;
const CHROME_CRASH_RESTART_DELAY_MS = 2_000;
const PAGE_MONITOR_INTERVAL_MS = 3_000;
// SPA（navigatedWithinDocument）ではタイトル後更新が一般的なため、URL 即時同期後に一度だけ遅延再取得する。
const PAGE_TITLE_REFETCH_DELAY_MS = 400;
const PROCESS_TERMINATE_GRACE_MS = 1_500;
const CHROME_BINARY_PROBE_TIMEOUT_MS = 2_000;

export interface BrowserServiceDeps {
  readonly clock: Clock;
  readonly settings: SettingsRepository;
  readonly processRunner: ProcessRunner;
  readonly processTree: ProcessTreeController;
  readonly cdp: CdpClientPort;
  readonly inputRouter: BrowserInputRouter;
  readonly config: Omit<BrowserLaunchConfig, "initialUrl" | "timezone" | "vaapiRenderNode">;
  // VAAPI レンダノードはエンコーダ側の GPU 検出結果に依存するため、Chrome 起動時点で遅延取得する（app 層で配線）。
  readonly vaapiRenderNodeProvider?: () => string | null | Promise<string | null>;
  readonly onPageInfoChanged?: (info: BrowserPageInfo) => void;
  readonly onDroppedInput?: (kind: DroppedInputKind, reason: string) => void;
}

export class BrowserService implements BrowserControlPort {
  private readonly deps: BrowserServiceDeps;
  private pulseProc: ManagedProcess | null = null;
  private xvfbProc: ManagedProcess | null = null;
  private openboxProc: ManagedProcess | null = null;
  private chromeProc: ManagedProcess | null = null;

  private viewport: AlignedDimensions;
  private displayScale: number;
  private currentPageInfo: BrowserPageInfo = { url: null, title: null };
  private chromeBinary: string | null = null;

  private started = false;
  private stopping = false;
  private restarting = false;
  private monitoringPaused = false;

  private monitorTimer: TimerHandle | null = null;
  private cdpReconnectTimer: TimerHandle | null = null;
  private crashRestartTimer: TimerHandle | null = null;

  // Spec: docs/specs/06-browser-input-cdp.md#2.1
  constructor(deps: BrowserServiceDeps) {
    this.deps = deps;
    this.viewport = deps.config.viewport;
    this.displayScale = clampDisplayScale(deps.settings.getCurrent().stream.displayScale);
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.1
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.stopping = false;
    this.restarting = false;

    try {
      await this.cleanupPulseAudio();
      this.pulseProc = this.deps.processRunner.spawn({
        command: "pulseaudio",
        args: buildPulseAudioLaunchArgs(),
      });
      await this.waitForPulseAudioReadyWithSelfHeal();
      await this.ensureVirtualSink();

      this.xvfbProc = this.deps.processRunner.spawn({
        command: "Xvfb",
        args: buildXvfbLaunchArgs(this.deps.config.display),
      });

      this.openboxProc = this.deps.processRunner.spawn({
        command: "openbox",
        args: [],
        env: {
          ...process.env,
          DISPLAY: this.deps.config.display,
        },
      });

      await this.launchChromeProcess();
      this.started = true;
      await this.connectCdpAndInitialize();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    this.clearAllTimers();
    this.deps.inputRouter.dispose();

    try {
      this.deps.cdp.setPageEventListener(null);
      await this.deps.cdp.disconnect();
    } catch {
      // Ignore disconnect errors during shutdown.
    }

    await this.terminateProcess(this.chromeProc);
    this.chromeProc = null;
    await this.terminateProcess(this.openboxProc);
    this.openboxProc = null;
    await this.terminateProcess(this.xvfbProc);
    this.xvfbProc = null;
    await this.terminateProcess(this.pulseProc);
    this.pulseProc = null;
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  async freezeTree(): Promise<void> {
    this.setMonitoringPaused(true);
    await this.deps.inputRouter.resetActiveTouches();
    const pid = this.chromeProc?.pid ?? null;
    if (pid !== null) {
      await this.deps.processTree.freezeTree(pid);
    }
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  async resumeTree(): Promise<void> {
    const pid = this.chromeProc?.pid ?? null;
    if (pid !== null) {
      await this.deps.processTree.resumeTree(pid);
    }
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  async restartBrowser(): Promise<void> {
    this.restarting = true;
    this.clearCrashRestartTimer();
    this.clearCdpReconnectTimer();
    this.stopMonitorTimer();
    await this.deps.inputRouter.resetActiveTouches();

    try {
      try {
        await this.deps.cdp.disconnect();
      } catch {
        // Ignore disconnect error before restarting Chrome.
      }

      await this.terminateProcess(this.chromeProc);
      this.chromeProc = null;

      await this.launchChromeProcess();
      this.started = true;
    } finally {
      this.restarting = false;
    }

    await this.connectCdpAndInitialize();
    if (!this.monitoringPaused) {
      this.startMonitorTimer();
    }
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.4
  setMonitoringPaused(paused: boolean): void {
    this.monitoringPaused = paused;
    if (paused) {
      this.stopMonitorTimer();
    } else if (this.started && !this.stopping) {
      this.startMonitorTimer();
    }
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.4
  getCurrentPageInfo(): BrowserPageInfo {
    return this.currentPageInfo;
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.1
  async navigate(url: string): Promise<void> {
    if (!isAllowedHttpUrl(url)) {
      throw new Error(`Rejected non-HTTP(S) navigation URL: ${url}`);
    }
    if (!this.deps.cdp.isConnected()) {
      this.deps.onDroppedInput?.("navigate", "cdp_disconnected");
      return;
    }
    await this.deps.cdp.navigate(url);
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  async goBack(): Promise<void> {
    if (!this.deps.cdp.isConnected()) {
      this.deps.onDroppedInput?.("navigation", "cdp_disconnected");
      return;
    }
    await this.deps.cdp.goBack();
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  async goForward(): Promise<void> {
    if (!this.deps.cdp.isConnected()) {
      this.deps.onDroppedInput?.("navigation", "cdp_disconnected");
      return;
    }
    await this.deps.cdp.goForward();
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  async reload(): Promise<void> {
    if (!this.deps.cdp.isConnected()) {
      this.deps.onDroppedInput?.("navigation", "cdp_disconnected");
      return;
    }
    await this.deps.cdp.reload();
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.4
  async toggleFullscreen(): Promise<void> {
    if (!this.deps.cdp.isConnected()) {
      this.deps.onDroppedInput?.("fullscreen", "cdp_disconnected");
      return;
    }
    await this.deps.cdp.evaluate("globalThis.__tesroidToggleFullscreen?.()");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.4
  async setDisplayScale(scale: number): Promise<void> {
    const clamped = clampDisplayScale(scale);
    this.displayScale = clamped;
    if (!this.deps.cdp.isConnected()) {
      return;
    }
    await this.deps.cdp.setPageInitScript(buildCombinedPageInitScript({ displayScale: clamped }));
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.3
  async resizeViewport(dimensions: AlignedDimensions): Promise<void> {
    this.viewport = dimensions;
    if (!this.deps.cdp.isConnected()) {
      return;
    }
    await this.deps.cdp.setViewportSize(dimensions);
  }

  getCurrentViewport(): AlignedDimensions {
    return this.viewport;
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  async injectTouch(frame: TouchFrame): Promise<void> {
    await this.deps.inputRouter.dispatchTouch(frame);
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  async injectText(text: string): Promise<void> {
    await this.deps.inputRouter.dispatchText(text);
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  async injectKey(key: SpecialKey): Promise<void> {
    await this.deps.inputRouter.dispatchKey(key);
  }

  private getPulseServerAddress(): string {
    return this.deps.config.pulseSocketPath.startsWith("unix:")
      ? this.deps.config.pulseSocketPath
      : `unix:${this.deps.config.pulseSocketPath}`;
  }

  private async waitForPulseAudioReady(): Promise<void> {
    const deadlineMs = this.deps.clock.monotonicMs() + PULSE_READY_TIMEOUT_MS;
    const pulseEnv = {
      ...process.env,
      PULSE_SERVER: this.getPulseServerAddress(),
    };

    while (true) {
      const result = await this.deps.processRunner.exec("pactl", ["info"], {
        env: pulseEnv,
        timeoutMs: 1_000,
      });
      if (result.exitCode === 0) {
        return;
      }
      if (this.stopping || this.deps.clock.monotonicMs() >= deadlineMs) {
        throw new Error(`PulseAudio failed to become ready within ${PULSE_READY_TIMEOUT_MS}ms`);
      }
      await this.waitClockMs(PULSE_READY_POLL_MS);
    }
  }

  private waitClockMs(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.deps.clock.setTimeout(resolve, delayMs);
    });
  }

  // 仕様 06 AC-08: 起動前自己修復 — stale ソケット除去と既存デーモンの终止で、コンテナ再起動残存状態を継承しない。
  private async cleanupPulseAudio(): Promise<void> {
    const socketPath = this.deps.config.pulseSocketPath.replace(/^unix:/, "");
    try {
      await fs.rm(socketPath, { force: true });
    } catch {
      // ソケット不在の正常系はそのまま続行する。
    }
    try {
      await this.deps.processRunner.exec("pulseaudio", ["-k"], { timeoutMs: 1_000 });
    } catch {
      // デーモン不在（初回起動）は正常系。
    }
  }

  // fail-fast は自己修復の後に適用する（仕様 06 §2.1）: 掃除→再生成を 1 度試みた後も無応答の場合のみ失敗とする。
  private async waitForPulseAudioReadyWithSelfHeal(): Promise<void> {
    try {
      await this.waitForPulseAudioReady();
    } catch {
      await this.cleanupPulseAudio();
      await this.terminateProcess(this.pulseProc);
      this.pulseProc = this.deps.processRunner.spawn({
        command: "pulseaudio",
        args: buildPulseAudioLaunchArgs(),
      });
      await this.waitForPulseAudioReady();
    }
  }

  // 仕様 06 AC-08: 起動後自己修復 — 仮想シンク欠落時に `.pa` と同一構成で再ロードし、既定・音量・ミュートを強制する。
  private async ensureVirtualSink(): Promise<void> {
    const pulseEnv = {
      ...process.env,
      PULSE_SERVER: this.getPulseServerAddress(),
    };
    const listed = await this.deps.processRunner.exec("pactl", ["list", "short", "sinks"], {
      env: pulseEnv,
      timeoutMs: 1_000,
    });
    if (listed.exitCode === 0 && listed.stdout.includes(VIRTUAL_SINK_NAME)) {
      return;
    }
    await this.deps.processRunner.exec("pactl", [...buildNullSinkModuleArgs()], {
      env: pulseEnv,
      timeoutMs: 2_000,
    });
    const enforcement: readonly (readonly string[])[] = [
      ["set-default-sink", VIRTUAL_SINK_NAME],
      ["set-sink-volume", VIRTUAL_SINK_NAME, "100%"],
      ["set-sink-mute", VIRTUAL_SINK_NAME, "0"],
    ];
    for (const args of enforcement) {
      await this.deps.processRunner.exec("pactl", [...args], { env: pulseEnv, timeoutMs: 1_000 });
    }
  }

  // 仕様 06 §2.1: 4 候補から実行可能な最初のものを選択し、同一インスタンスでは結果を保持する。
  private async resolveChromeBinary(): Promise<string> {
    if (this.chromeBinary !== null) {
      return this.chromeBinary;
    }
    for (const candidate of CHROME_BINARY_CANDIDATES) {
      let exitCode = 1;
      try {
        const probe = await this.deps.processRunner.exec(candidate, ["--version"], {
          timeoutMs: CHROME_BINARY_PROBE_TIMEOUT_MS,
        });
        exitCode = probe.exitCode ?? 1;
      } catch {
        exitCode = 1;
      }
      if (exitCode === 0) {
        this.chromeBinary = candidate;
        return candidate;
      }
    }
    this.chromeBinary = CHROME_BINARY_CANDIDATES[0];
    return this.chromeBinary;
  }

  private async prepareUserDataDir(): Promise<void> {
    const { userDataDir } = this.deps.config;
    await fs.mkdir(userDataDir, { recursive: true });

    // ワイルドカード全除去: クラッシュ残存 Singleton* はファイル名列挙に依存せずすべて退避させる。
    let entries: string[];
    try {
      entries = await fs.readdir(userDataDir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.startsWith("Singleton")) {
        await fs.rm(path.join(userDataDir, entry), { recursive: true, force: true });
      }
    }

    // クラッシュ状態はトップレベルとプロファイル配下の両 Preferences について修復する。
    const acceptLanguages = deriveAcceptLanguages(this.deps.config.locale);
    for (const prefsPath of [
      path.join(userDataDir, "Preferences"),
      path.join(userDataDir, "Default", "Preferences"),
    ]) {
      let existingPrefs: string | null = null;
      try {
        existingPrefs = await fs.readFile(prefsPath, "utf8");
      } catch {
        existingPrefs = null;
      }
      const sanitized = sanitizeChromePreferences(existingPrefs, acceptLanguages);
      await fs.mkdir(path.dirname(prefsPath), { recursive: true });
      await fs.writeFile(prefsPath, sanitized.rawJson, "utf8");
    }
  }

  private async launchChromeProcess(): Promise<void> {
    await this.prepareUserDataDir();

    const currentSettings = this.deps.settings.getCurrent();
    const initialUrl = resolveHomeUrl(currentSettings.favorites);
    const timezone = currentSettings.timezone;
    this.displayScale = clampDisplayScale(currentSettings.stream.displayScale);

    const args = buildChromeLaunchArgs({
      ...this.deps.config,
      initialUrl,
      timezone,
      viewport: this.viewport,
      vaapiRenderNode: (await this.deps.vaapiRenderNodeProvider?.()) ?? null,
    });
    const env = buildChromeProcessEnv(
      process.env,
      this.deps.config.locale,
      timezone,
      this.deps.config.display,
      this.deps.config.pulseSocketPath,
    );

    const proc = this.deps.processRunner.spawn({
      command: await this.resolveChromeBinary(),
      args,
      env,
    });
    this.chromeProc = proc;

    proc.onExit(() => {
      if (this.chromeProc === proc) {
        this.chromeProc = null;
      }
      if (!this.stopping && !this.restarting) {
        this.scheduleCrashRestart();
      }
    });
  }

  private scheduleCrashRestart(): void {
    this.clearCrashRestartTimer();
    this.crashRestartTimer = this.deps.clock.setTimeout(() => {
      this.crashRestartTimer = null;
      if (this.stopping || this.restarting) {
        return;
      }
      void this.handleCrashRestart();
    }, CHROME_CRASH_RESTART_DELAY_MS);
  }

  private async handleCrashRestart(): Promise<void> {
    if (this.stopping || this.restarting) {
      return;
    }
    this.restarting = true;
    try {
      await this.deps.inputRouter.resetActiveTouches();
      try {
        await this.deps.cdp.disconnect();
      } catch {
        // Ignore disconnect error after crash.
      }
      await this.launchChromeProcess();
    } finally {
      this.restarting = false;
    }
    await this.connectCdpAndInitialize();
  }

  private async connectCdpAndInitialize(): Promise<void> {
    if (this.stopping) {
      return;
    }
    try {
      await this.deps.cdp.connect(this.deps.config.cdpPort);
      this.clearCdpReconnectTimer();
      // 仕様 06 §2.4: CDP イベントでの即時同期を主経路とし、3 秒間隔ポーリングはフォールバックとして維持する。
      this.deps.cdp.setPageEventListener((event) => {
        this.handlePageNavigationEvent(event);
      });
      await this.deps.cdp.setPageInitScript(
        buildCombinedPageInitScript({ displayScale: this.displayScale }),
      );
      await this.deps.cdp.setViewportSize(this.viewport);
      await this.pollPageInfoOnce();
      if (!this.monitoringPaused) {
        this.startMonitorTimer();
      }
    } catch {
      this.scheduleCdpReconnect();
    }
  }

  private scheduleCdpReconnect(): void {
    if (this.stopping || this.cdpReconnectTimer !== null) {
      return;
    }
    this.cdpReconnectTimer = this.deps.clock.setTimeout(() => {
      this.cdpReconnectTimer = null;
      if (!this.stopping && !this.restarting && !this.deps.cdp.isConnected()) {
        void this.connectCdpAndInitialize();
      }
    }, CDP_RECONNECT_INTERVAL_MS);
  }

  private startMonitorTimer(): void {
    if (this.monitorTimer !== null || this.monitoringPaused || this.stopping) {
      return;
    }
    this.monitorTimer = this.deps.clock.setInterval(() => {
      void this.pollPageInfoOnce();
    }, PAGE_MONITOR_INTERVAL_MS);
  }

  private stopMonitorTimer(): void {
    if (this.monitorTimer !== null) {
      this.deps.clock.clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  // 仕様 06 §2.4: 遷移イベントで即時に URL・タイトルを評価する。SPA 遷移はタイトル後更新が一般的なため
  // 即時同期に加え 400 ms 後に一度だけ再取得する。
  private handlePageNavigationEvent(event: PageNavigationEvent): void {
    void this.pollPageInfoOnce();
    if (event === "navigatedWithinDocument") {
      this.deps.clock.setTimeout(() => {
        void this.pollPageInfoOnce();
      }, PAGE_TITLE_REFETCH_DELAY_MS);
    }
  }

  private async pollPageInfoOnce(): Promise<void> {
    if (this.monitoringPaused || this.stopping || this.restarting) {
      return;
    }
    if (!this.deps.cdp.isConnected()) {
      this.scheduleCdpReconnect();
      return;
    }
    try {
      const info = await this.deps.cdp.getPageInfo();
      const safeUrl =
        info.url !== null && isAllowedHttpUrl(info.url) ? info.url : this.currentPageInfo.url;
      const next: BrowserPageInfo = {
        url: safeUrl,
        title: info.title,
      };
      const changed =
        next.url !== this.currentPageInfo.url || next.title !== this.currentPageInfo.title;
      this.currentPageInfo = next;
      if (changed) {
        this.deps.onPageInfoChanged?.(next);
      }
    } catch {
      if (!this.deps.cdp.isConnected()) {
        this.scheduleCdpReconnect();
      }
    }
  }

  private async terminateProcess(proc: ManagedProcess | null): Promise<void> {
    if (proc === null) {
      return;
    }
    try {
      await this.deps.processRunner.terminateWithEscalation(proc, PROCESS_TERMINATE_GRACE_MS);
    } catch {
      // Ignore termination failures during teardown.
    }
  }

  private clearCdpReconnectTimer(): void {
    if (this.cdpReconnectTimer !== null) {
      this.deps.clock.clearTimeout(this.cdpReconnectTimer);
      this.cdpReconnectTimer = null;
    }
  }

  private clearCrashRestartTimer(): void {
    if (this.crashRestartTimer !== null) {
      this.deps.clock.clearTimeout(this.crashRestartTimer);
      this.crashRestartTimer = null;
    }
  }

  private clearAllTimers(): void {
    this.stopMonitorTimer();
    this.clearCdpReconnectTimer();
    this.clearCrashRestartTimer();
  }
}
