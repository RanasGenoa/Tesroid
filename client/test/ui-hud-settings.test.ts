import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInitialStreamingState,
  DEFAULT_APP_SETTINGS,
  encodeServerControlFrame,
  type HealthResponse,
  type MediaFrame,
  type MetricsSummary,
  type PowerActionResult,
  type PowerStatusSnapshot,
  type PrimarySyncMetadata,
  type PublicAppSettings,
  type ServerControlMessage,
  type SessionRole,
  type SettingsUpdateInput,
  type SetupRequestInput,
  type StreamingEvent,
  type StreamingState,
  type SystemStatusResponse,
  type TelemetrySessionSummary,
  toPublicSettings,
  transitionStreamingState,
  WS_CLOSE_CODE,
  type WsCloseCode,
} from "@tesroid/shared";
import { describe, expect, it } from "vitest";
import type {
  CanvasElementLike,
  PlaybackControllerPort,
  PlaybackStatsSnapshot,
} from "../src/media/ports.js";
import {
  AppStore,
  BrowserTabSessionStorage,
  SETTINGS_UPDATED_EVENT_NAME,
  type SessionStorageBackend,
  type StoredTabSession,
  type TabSessionStoragePort,
} from "../src/state/index.js";
import type {
  ClientClock,
  ClientTimerHandle,
  PinVerifyApiResponse,
  RestApiClientPort,
  RestApiResult,
  WsClientHandlers,
  WsConnectionStatus,
  WsTransportPort,
} from "../src/transport/ports.js";
import {
  AppModalsView,
  escapeHtml,
  HudBarView,
  PinAndStatusViews,
  SettingsModalView,
  SetupWizardView,
  ViewportOverlayView,
} from "../src/ui/index.js";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class FakeClock implements ClientClock {
  private currentMs: number;
  private nextId = 1;
  private readonly timers = new Set<{
    readonly id: number;
    readonly fireAtMs: number;
    readonly callback: () => void;
    cancelled: boolean;
  }>();

  constructor(initialMs = 10_000) {
    this.currentMs = initialMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  setTimeout(callback: () => void, delayMs: number): ClientTimerHandle {
    const entry = {
      id: this.nextId++,
      fireAtMs: this.currentMs + Math.max(0, delayMs),
      callback,
      cancelled: false,
    };
    this.timers.add(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
        this.timers.delete(entry);
      },
    };
  }

  clearTimeout(handle: ClientTimerHandle): void {
    handle.cancel();
  }

  advanceBy(ms: number): void {
    const targetMs = this.currentMs + ms;
    while (true) {
      let nextTimer: {
        readonly id: number;
        readonly fireAtMs: number;
        readonly callback: () => void;
        cancelled: boolean;
      } | null = null;
      for (const timer of this.timers) {
        if (!timer.cancelled && timer.fireAtMs <= targetMs) {
          if (
            nextTimer === null ||
            timer.fireAtMs < nextTimer.fireAtMs ||
            (timer.fireAtMs === nextTimer.fireAtMs && timer.id < nextTimer.id)
          ) {
            nextTimer = timer;
          }
        }
      }
      if (nextTimer === null) {
        break;
      }
      this.timers.delete(nextTimer);
      this.currentMs = Math.max(this.currentMs, nextTimer.fireAtMs);
      nextTimer.callback();
    }
    this.currentMs = targetMs;
  }
}

class MockEvent {
  readonly type: string;
  target: MockElement | null = null;
  constructor(type: string) {
    this.type = type;
  }
}

class MockTextNode {
  textContent: string;
  constructor(text: string) {
    this.textContent = text;
  }
}

class MockElement {
  readonly tagName: string;
  readonly ownerDocument: MockDocument;
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: (MockElement | MockTextNode)[] = [];
  private readonly listeners = new Map<string, Set<(event: MockEvent) => void>>();

  private _text = "";
  private _html = "";
  value = "";
  disabled = false;
  selected = false;
  checked = false;

  constructor(tagName: string, ownerDocument: MockDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get className(): string {
    return this.attributes.get("class") ?? "";
  }

  set className(value: string) {
    this.attributes.set("class", value);
  }

  get textContent(): string {
    if (this.children.length > 0) {
      return this.children.map((c) => c.textContent).join("");
    }
    return this._text || this._html.replace(/<[^>]*>/g, "");
  }

  set textContent(value: string) {
    this.children.length = 0;
    this._html = "";
    this._text = value;
  }

  get innerHTML(): string {
    if (this._html.length > 0) {
      return this._html;
    }
    return this.children
      .map((c) => (c instanceof MockTextNode ? escapeHtml(c.textContent) : c.outerHTML))
      .join("");
  }

  set innerHTML(value: string) {
    this.children.length = 0;
    this._text = "";
    this._html = value;
  }

  get outerHTML(): string {
    const attrs = [...this.attributes.entries()]
      .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
      .join("");
    return `<${this.tagName.toLowerCase()}${attrs}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "value") {
      this.value = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  parent: MockElement | null = null;

  appendChild(child: MockElement | MockTextNode): MockElement | MockTextNode {
    this.children.push(child);
    if (child instanceof MockElement) {
      child.parent = this;
    }
    if (this.tagName === "SELECT" && child instanceof MockElement && child.selected) {
      this.value = child.value;
    }
    return child;
  }

  remove(): void {
    const parent = this.parent;
    if (parent === null) {
      return;
    }
    const index = parent.children.indexOf(this);
    if (index >= 0) {
      parent.children.splice(index, 1);
    }
    this.parent = null;
  }

  replaceChildren(...nodes: (MockElement | MockTextNode)[]): void {
    this.children.length = 0;
    this._text = "";
    this._html = "";
    for (const node of nodes) {
      this.appendChild(node);
    }
  }

  addEventListener(type: string, listener: (event: MockEvent) => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  dispatchEvent(event: MockEvent): boolean {
    if (event.target === null) {
      event.target = this;
    }
    const set = this.listeners.get(event.type);
    if (set !== undefined) {
      for (const listener of [...set]) {
        listener(event);
      }
    }
    return true;
  }

  click(): void {
    if (this.disabled) {
      return;
    }
    this.dispatchEvent(new MockEvent("click"));
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    const visit = (node: MockElement): void => {
      for (const child of node.children) {
        if (child instanceof MockElement) {
          if (matchesSimpleSelector(child, selector)) {
            results.push(child);
          }
          visit(child);
        }
      }
    };
    visit(this);
    return results;
  }

  querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function matchesSimpleSelector(el: MockElement, selector: string): boolean {
  const attrMatch = /^\[([^=\]]+)="([^"]*)"\]$/.exec(selector);
  if (attrMatch !== null) {
    const [, attrName, attrValue] = attrMatch;
    return attrName !== undefined && el.getAttribute(attrName) === attrValue;
  }
  if (selector.startsWith(".")) {
    return el.className.split(/\s+/).includes(selector.slice(1));
  }
  if (selector.startsWith("#")) {
    return el.getAttribute("id") === selector.slice(1);
  }
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

class MockDocument {
  activeElement: MockElement | null = null;
  readonly body: MockElement = new MockElement("body", this);

  createElement(tagName: string): MockElement {
    return new MockElement(tagName, this);
  }

  createTextNode(text: string): MockTextNode {
    return new MockTextNode(text);
  }
}

class FakeMemoryStorage implements SessionStorageBackend {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class FakeRestClient implements RestApiClientPort {
  token: string | null = null;
  statusResult: RestApiResult<SystemStatusResponse> = {
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
  healthResult: RestApiResult<HealthResponse> = {
    ok: true,
    status: 200,
    data: {
      ok: true,
      uptimeSec: 120,
      timestamp: "2026-11-27T00:00:00.000Z",
      powerState: "ACTIVE",
      encoder: {
        running: true,
        backend: "vaapi",
        mode: "auto",
        compressionLevel: 7,
        x264Preset: null,
        vaapiDriver: "iHD",
        lastFallbackReason: null,
        lastFallbackAt: null,
        captureResolution: { width: 1280, height: 720 },
        encodeResolution: { width: 1280, height: 720 },
      },
    },
  };
  settingsData: PublicAppSettings = toPublicSettings(DEFAULT_APP_SETTINGS);
  updateSettingsResults: RestApiResult<PublicAppSettings>[] = [];
  verifyPinResult: RestApiResult<PinVerifyApiResponse> = {
    ok: true,
    status: 200,
    data: { ok: true, token: "reauth-token", role: "PRIMARY" },
  };
  metricsSummaryResult: RestApiResult<MetricsSummary> = {
    ok: true,
    status: 200,
    data: {
      sampleCount: 12,
      durationSec: 120,
      currentFps: 30,
      avgFps: 29.8,
      minFps: 28,
      maxFps: 30,
      avgRttMs: 24,
      maxRttMs: 40,
      totalDroppedFrames: 0,
      totalDecoderErrors: 0,
      avgBitrateKbps: 1000,
      avgAvDriftMs: 5,
      minAvDriftMs: -10,
      maxAvDriftMs: 12,
      lastUpdated: "2026-11-27T00:00:00.000Z",
    },
  };

  readonly calls: string[] = [];
  readonly updatePatches: SettingsUpdateInput[] = [];

  setToken(token: string | null): void {
    this.token = token;
  }
  async getStatus(): Promise<RestApiResult<SystemStatusResponse>> {
    this.calls.push("GET /api/status");
    return this.statusResult;
  }
  async getHealth(): Promise<RestApiResult<HealthResponse>> {
    this.calls.push("GET /api/health");
    return this.healthResult;
  }
  async completeSetup(input: SetupRequestInput): Promise<RestApiResult<PublicAppSettings>> {
    this.calls.push("POST /api/setup");
    this.settingsData = {
      ...this.settingsData,
      isSetupCompleted: true,
      timezone: input.timezone ?? "Asia/Tokyo",
    };
    return { ok: true, status: 200, data: this.settingsData };
  }
  async verifyPin(_pin: string): Promise<RestApiResult<PinVerifyApiResponse>> {
    this.calls.push("POST /api/auth/verify");
    return this.verifyPinResult;
  }
  async getSettings(): Promise<RestApiResult<PublicAppSettings>> {
    this.calls.push("GET /api/settings");
    return { ok: true, status: 200, data: this.settingsData };
  }
  async updateSettings(patch: SettingsUpdateInput): Promise<RestApiResult<PublicAppSettings>> {
    this.calls.push("PUT /api/settings");
    this.updatePatches.push(patch);
    const queued = this.updateSettingsResults.shift();
    if (queued !== undefined) {
      if (queued.ok) {
        this.settingsData = queued.data;
      }
      return queued;
    }
    this.settingsData = {
      ...this.settingsData,
      timezone: patch.timezone ?? this.settingsData.timezone,
      favorites: patch.favorites ?? this.settingsData.favorites,
      stream: {
        ...this.settingsData.stream,
        ...(patch.stream ?? {}),
        vaapi: {
          ...this.settingsData.stream.vaapi,
          ...(patch.stream?.vaapi ?? {}),
        },
        clientProfile: {
          active:
            patch.stream?.clientProfile?.active ?? this.settingsData.stream.clientProfile.active,
          custom: {
            scale:
              patch.stream?.clientProfile?.custom?.scale ??
              this.settingsData.stream.clientProfile.custom.scale,
            allowedFps:
              patch.stream?.clientProfile?.custom?.allowedFps ??
              this.settingsData.stream.clientProfile.custom.allowedFps,
          },
        },
      },
    };
    return { ok: true, status: 200, data: this.settingsData };
  }
  async getPowerStatus(): Promise<RestApiResult<PowerStatusSnapshot>> {
    this.calls.push("GET /api/power/status");
    return {
      ok: true,
      status: 200,
      data: {
        state: "ACTIVE",
        streamEpoch: 1,
        currentUrl: null,
        currentTitle: null,
        updatedAtMs: 0,
      },
    };
  }
  async sleepPower(): Promise<RestApiResult<PowerActionResult>> {
    this.calls.push("POST /api/power/sleep");
    return { ok: true, status: 200, data: { ok: true, state: "SLEEP_PAUSED", streamEpoch: 1 } };
  }
  async resumePower(): Promise<RestApiResult<PowerActionResult>> {
    this.calls.push("POST /api/power/resume");
    return { ok: true, status: 200, data: { ok: true, state: "ACTIVE", streamEpoch: 2 } };
  }
  async restartBrowser(): Promise<RestApiResult<PowerActionResult>> {
    this.calls.push("POST /api/power/restart-browser");
    return { ok: true, status: 200, data: { ok: true, state: "ACTIVE", streamEpoch: 3 } };
  }
  async resetStream(): Promise<RestApiResult<PowerActionResult>> {
    this.calls.push("POST /api/stream/reset");
    return { ok: true, status: 200, data: { ok: true, state: "ACTIVE", streamEpoch: 4 } };
  }
  async getMetricsSummary(): Promise<RestApiResult<MetricsSummary>> {
    this.calls.push("GET /api/metrics/summary");
    return this.metricsSummaryResult;
  }
  async getMetricsHistory(): Promise<RestApiResult<readonly []>> {
    return { ok: true, status: 200, data: [] };
  }
  async listTelemetrySessions(): Promise<RestApiResult<readonly TelemetrySessionSummary[]>> {
    return { ok: true, status: 200, data: [] };
  }
  async deleteTelemetrySessions(): Promise<RestApiResult<{ readonly ok: boolean }>> {
    this.calls.push("DELETE /api/telemetry/sessions");
    return { ok: true, status: 200, data: { ok: true } };
  }
}

class FakeWsTransport implements WsTransportPort {
  status: WsConnectionStatus = "DISCONNECTED";
  handlers: WsClientHandlers | null = null;
  readonly sentFrames: Uint8Array[] = [];
  readonly disconnectCalls: { code?: WsCloseCode; reason?: string }[] = [];

  connect(_url: string, handlers: WsClientHandlers): void {
    this.handlers = handlers;
    this.status = "CONNECTING";
  }
  sendBinary(data: Uint8Array): boolean {
    if (this.status !== "CONNECTED") {
      return false;
    }
    this.sentFrames.push(new Uint8Array(data));
    return true;
  }
  disconnect(code?: WsCloseCode, reason?: string): void {
    this.disconnectCalls.push({ code, reason });
    this.status = "DISCONNECTED";
  }
  getStatus(): WsConnectionStatus {
    return this.status;
  }
  triggerOpen(): void {
    this.status = "CONNECTED";
    this.handlers?.onOpen?.();
  }
  triggerControl(msg: ServerControlMessage): void {
    this.handlers?.onBinaryMessage(encodeServerControlFrame(msg));
  }
  triggerClose(code: number, reason = "", terminal = false): void {
    this.status = terminal ? "TERMINAL_CLOSED" : "DISCONNECTED";
    this.handlers?.onClose?.({ code, reason, terminal });
  }
}

class FakePlaybackController implements PlaybackControllerPort {
  streamingState: StreamingState = createInitialStreamingState();
  stats: PlaybackStatsSnapshot = {
    renderedFps: 30,
    isStaticScreen: false,
    localVideoBufferedMs: 0,
    localAudioBufferedMs: 0,
    avDriftMs: 0,
    decodeQueueSize: 0,
    droppedFramesDelta: 0,
    decoderErrorsDelta: 0,
    frameRenderTimeMs: 2,
    waitingForKeyframe: false,
  };
  primaryAuthority = true;
  audioEnabled = true;
  targetFps = 30;
  targetBufferMs = 10_000;
  readonly resetEpochs: number[] = [];

  attachCanvas(_canvas: CanvasElementLike): void {}
  getStreamingState(): StreamingState {
    return this.streamingState;
  }
  dispatchStreamingEvent(event: StreamingEvent): void {
    this.streamingState = transitionStreamingState(this.streamingState, event).nextState;
  }
  handleMediaFrame(_frame: MediaFrame): void {}
  updatePrimarySyncRef(_metadata: PrimarySyncMetadata): void {}
  setTargetFps(fps: number): void {
    this.targetFps = fps;
  }
  setTargetBufferMs(targetBufferMs: number): void {
    this.targetBufferMs = targetBufferMs;
  }
  setPrimaryAuthority(isPrimary: boolean): void {
    this.primaryAuthority = isPrimary;
  }
  setAudioEnabled(enabled: boolean): void {
    this.audioEnabled = enabled;
  }
  async unlockAudioOnGesture(): Promise<void> {}
  resetForNewEpoch(newStreamEpoch: number): void {
    this.resetEpochs.push(newStreamEpoch);
    this.streamingState = { ...this.streamingState, streamEpoch: newStreamEpoch };
  }
  getStatsSnapshot(): PlaybackStatsSnapshot {
    return this.stats;
  }
  dispose(): void {}
}

function createHarness(options?: {
  readonly initialSession?: StoredTabSession;
  readonly clockStartMs?: number;
}) {
  const clock = new FakeClock(options?.clockStartMs ?? 10_000);
  const rest = new FakeRestClient();
  const transport = new FakeWsTransport();
  const playback = new FakePlaybackController();
  const rawStorage = new FakeMemoryStorage();
  const sessionStorage: TabSessionStoragePort = new BrowserTabSessionStorage(rawStorage);
  if (options?.initialSession !== undefined) {
    sessionStorage.save(options.initialSession);
  }

  let reloaded = false;
  const settingsEvents: PublicAppSettings[] = [];
  const store = new AppStore({
    rest,
    transport,
    playback,
    sessionStorage,
    clock,
    wsUrl: "wss://example.test/ws",
    onReload: () => {
      reloaded = true;
    },
    onSettingsUpdated: (settings) => {
      settingsEvents.push(settings);
    },
  });

  const doc = new MockDocument();
  const hudRoot = doc.createElement("header");
  const overlayRoot = doc.createElement("div");
  const statusRoot = doc.createElement("div");
  const appModalRoot = doc.createElement("div");
  const settingsModalRoot = doc.createElement("div");

  const hudView = new HudBarView(store);
  const overlayView = new ViewportOverlayView(store);
  const setupView = new SetupWizardView(store);
  const pinStatusView = new PinAndStatusViews(store);
  const modalsView = new AppModalsView(store);
  const settingsView = new SettingsModalView(store, { clock });

  hudView.mount(hudRoot as unknown as HTMLElement);
  overlayView.mount(overlayRoot as unknown as HTMLElement);
  setupView.mount(statusRoot as unknown as HTMLElement);
  pinStatusView.mount(statusRoot as unknown as HTMLElement);
  modalsView.mount(appModalRoot as unknown as HTMLElement);
  settingsView.mount(settingsModalRoot as unknown as HTMLElement);

  store.subscribe((next) => {
    hudView.render(next);
    overlayView.render(next);
    if (next.route === "SETUP") {
      setupView.render(next);
    } else {
      pinStatusView.render(next);
    }
    modalsView.render(next);
    settingsView.render(next);
  });

  function authenticateWs(
    role: SessionRole = "PRIMARY",
    settings?: PublicAppSettings,
    token = "tok-1",
  ): void {
    transport.triggerOpen();
    transport.triggerControl({
      type: "AUTH_OK",
      role,
      token,
      streamEpoch: 1,
      settings: settings ?? rest.settingsData,
      powerState: "ACTIVE",
    });
  }

  return {
    clock,
    rest,
    transport,
    playback,
    rawStorage,
    sessionStorage,
    store,
    doc,
    hudRoot,
    overlayRoot,
    statusRoot,
    appModalRoot,
    settingsModalRoot,
    authenticateWs,
    wasReloaded: () => reloaded,
    settingsEvents,
    dispose: () => {
      settingsView.unmount();
      modalsView.unmount();
      hudView.unmount();
      overlayView.unmount();
      setupView.unmount();
      pinStatusView.unmount();
      store.dispose();
    },
  };
}

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

  it("Spec 07 AC-06: client source and index.html contain zero native <select> elements (all selection flows use the in-app touch picker)", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          const source = fs.readFileSync(full, "utf8");
          if (/el\(\s*doc,\s*"select"/.test(source) || source.includes("form-select")) {
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
