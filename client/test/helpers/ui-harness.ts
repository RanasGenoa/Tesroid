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
  type WsCloseCode,
} from "@tesroid/shared";
import type {
  CanvasElementLike,
  PlaybackControllerPort,
  PlaybackStatsSnapshot,
} from "../../src/media/ports.js";
import {
  AppStore,
  BrowserTabSessionStorage,
  type SessionStorageBackend,
  type StoredTabSession,
  type TabSessionStoragePort,
} from "../../src/state/index.js";
import type {
  ClientClock,
  ClientTimerHandle,
  PinVerifyApiResponse,
  RestApiClientPort,
  RestApiResult,
  WsClientHandlers,
  WsConnectionStatus,
  WsTransportPort,
} from "../../src/transport/ports.js";
import {
  AppModalsView,
  escapeHtml,
  HudBarView,
  PinAndStatusViews,
  SettingsModalView,
  SetupWizardView,
  ViewportOverlayView,
} from "../../src/ui/index.js";

export const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export class FakeClock implements ClientClock {
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

export class MockEvent {
  readonly type: string;
  target: MockElement | null = null;
  constructor(type: string) {
    this.type = type;
  }
}

export class MockTextNode {
  textContent: string;
  constructor(text: string) {
    this.textContent = text;
  }
}

export class MockElement {
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

export class MockDocument {
  activeElement: MockElement | null = null;
  readonly body: MockElement = new MockElement("body", this);

  createElement(tagName: string): MockElement {
    return new MockElement(tagName, this);
  }

  createTextNode(text: string): MockTextNode {
    return new MockTextNode(text);
  }
}

export class FakeMemoryStorage implements SessionStorageBackend {
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

export class FakeRestClient implements RestApiClientPort {
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

export class FakeWsTransport implements WsTransportPort {
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

export class FakePlaybackController implements PlaybackControllerPort {
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

export function createHarness(options?: {
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
