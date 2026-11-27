import {
  AUTH_SECURITY_CONSTANTS,
  type AuthPayload,
  CHANNEL_ID,
  type ClientControlMessage,
  createInitialStreamingState,
  DEFAULT_FAVORITES,
  decodeMediaFrame,
  decodeServerControlFrame,
  encodeAuthFrame,
  encodeClientControlFrame,
  encodeResizeFrame,
  encodeTouchFrame,
  type HealthResponse,
  type HudModeBadge,
  isAllowedHttpUrl,
  isStrictYouTubeUrl,
  type MetricsSummary,
  nextHudBitrate,
  type PowerState,
  PROTOCOL_TIMING,
  type PublicAppSettings,
  type ResizeFrame,
  resolveClientProfile,
  resolveHomeUrl,
  type SessionRole,
  type SettingsUpdateInput,
  type SetupRequestInput,
  type SpecialKey,
  type StreamingState,
  type SystemStatusResponse,
  selectHudModeBadge,
  type TouchFrame,
  WS_CLOSE_CODE,
} from "@tesroid/shared";
import type { PlaybackControllerPort } from "../media/ports.js";
import type { ClientMetricsCollector } from "../observability/metrics-collector.js";
import type { ClientTelemetryReporter } from "../observability/telemetry-client.js";
import {
  type ClientClock,
  type ClientTimerHandle,
  createBrowserClock,
  type RestApiClientPort,
  type WsCloseEventInfo,
  type WsConnectionStatus,
  type WsTransportPort,
} from "../transport/ports.js";
import type { TabSessionStoragePort } from "./session-storage.js";

export type AppRoute =
  | "CONNECTING"
  | "CONNECTION_ERROR"
  | "SETUP"
  | "PIN"
  | "STREAMING"
  | "LOCKED"
  | "SUPERSEDED_4000"
  | "CONFLICT_4009";

export type HudDrawerState = "none" | "keyboard" | "favorites";

export type SettingsTabId = "browser" | "general" | "metrics";

export type ActiveModalState =
  | { readonly kind: "none" }
  | { readonly kind: "onboarding_guide" }
  | { readonly kind: "power_control" }
  | { readonly kind: "restart_confirm" }
  | { readonly kind: "pin_reauth" }
  | { readonly kind: "settings"; readonly activeTab: SettingsTabId };

export type SignalQualityLevel = "disconnected" | "reconnecting" | "stall" | "degraded" | "good";

export interface HudUiState {
  readonly drawer: HudDrawerState;
  readonly dimmed: boolean;
  readonly modeBadge: HudModeBadge;
  readonly localBufferedMs: number;
  readonly serverBufferedMs: number;
  readonly rttMs: number | null;
  readonly signalLevel: SignalQualityLevel;
  readonly renderedFps: number;
  readonly isStaticScreen: boolean;
  readonly waitingForKeyframe: boolean;
  readonly liveLatencyOffsetMs: number;
  readonly currentUrl: string | null;
  readonly currentTitle: string | null;
  readonly isYouTubePage: boolean;
  readonly lastResetClickedAtMs: number;
}

export interface AppState {
  readonly route: AppRoute;
  readonly wsStatus: WsConnectionStatus;
  readonly powerState: PowerState;
  readonly streamingState: StreamingState;
  readonly role: SessionRole | null;
  readonly isAuthenticated: boolean;
  readonly systemStatus: SystemStatusResponse | null;
  readonly settings: PublicAppSettings | null;
  readonly health: HealthResponse | null;
  readonly metricsSummary: MetricsSummary | null;
  readonly activeModal: ActiveModalState;
  readonly hud: HudUiState;
  readonly remainingPinAttempts: number;
  readonly errorBanner: string | null;
  readonly lastCloseReason: string | null;
  readonly audioUnlockNeeded: boolean;
  readonly localBufferSurvivalActive: boolean;
  readonly preferSecondaryStandby: boolean;
}

export type AppAction =
  | { readonly type: "SET_ROUTE"; readonly route: AppRoute }
  | { readonly type: "SET_SYSTEM_STATUS"; readonly status: SystemStatusResponse }
  | { readonly type: "SET_WS_STATUS"; readonly wsStatus: WsConnectionStatus }
  | { readonly type: "SET_POWER_STATE"; readonly powerState: PowerState }
  | { readonly type: "SET_STREAMING_STATE"; readonly streamingState: StreamingState }
  | { readonly type: "SET_ROLE"; readonly role: SessionRole | null }
  | { readonly type: "SET_AUTHENTICATED"; readonly authenticated: boolean }
  | { readonly type: "SET_SETTINGS"; readonly settings: PublicAppSettings }
  | { readonly type: "SET_HEALTH"; readonly health: HealthResponse | null }
  | { readonly type: "SET_METRICS_SUMMARY"; readonly summary: MetricsSummary | null }
  | { readonly type: "SET_DRAWER"; readonly drawer: HudDrawerState }
  | { readonly type: "SET_HUD_DIMMED"; readonly dimmed: boolean }
  | { readonly type: "OPEN_MODAL"; readonly modal: ActiveModalState }
  | { readonly type: "CLOSE_MODAL" }
  | { readonly type: "SET_PIN_ATTEMPTS"; readonly remainingAttempts: number }
  | { readonly type: "SET_ERROR_BANNER"; readonly message: string | null }
  | { readonly type: "SET_LAST_CLOSE_REASON"; readonly reason: string | null }
  | { readonly type: "SET_AUDIO_UNLOCK_NEEDED"; readonly needed: boolean }
  | { readonly type: "SET_LOCAL_BUFFER_SURVIVAL"; readonly active: boolean }
  | { readonly type: "SET_PREFER_SECONDARY_STANDBY"; readonly prefer: boolean }
  | { readonly type: "SET_LAST_RESET_CLICKED_AT"; readonly atMs: number }
  | {
      readonly type: "UPDATE_HUD_TELEMETRY";
      readonly patch: Partial<
        Pick<
          HudUiState,
          | "modeBadge"
          | "localBufferedMs"
          | "serverBufferedMs"
          | "rttMs"
          | "signalLevel"
          | "renderedFps"
          | "isStaticScreen"
          | "waitingForKeyframe"
          | "liveLatencyOffsetMs"
        >
      >;
    }
  | {
      readonly type: "UPDATE_PAGE_INFO";
      readonly url: string | null;
      readonly title: string | null;
    };

export type AppStateListener = (state: AppState) => void;

export type AppTelemetryPort = Pick<ClientTelemetryReporter, "setEnabled">;

export type AppMetricsPort = Pick<
  ClientMetricsCollector,
  | "start"
  | "stop"
  | "recordRttSample"
  | "recordVideoPacket"
  | "recordAudioPacket"
  | "setAvDriftMs"
  | "setDecodeQueueSize"
  | "setViewportMetrics"
>;

export interface AppStoreDeps {
  readonly rest: RestApiClientPort;
  readonly transport: WsTransportPort;
  readonly playback: PlaybackControllerPort;
  readonly sessionStorage: TabSessionStoragePort;
  readonly clock?: ClientClock;
  readonly wsUrl?: string;
  readonly telemetry?: AppTelemetryPort;
  readonly metrics?: AppMetricsPort;
  readonly onReload?: () => void;
  readonly onSettingsUpdated?: (settings: PublicAppSettings) => void;
}

export const HUD_AUTO_DIM_MS = 4_000;
export const HUD_RESET_DEBOUNCE_MS = 1_000;
export const HUD_QUICK_TOGGLE_DEBOUNCE_MS = 300;
export const RESUME_DEBOUNCE_MS = 800;
export const STATIC_SCREEN_THRESHOLD_MS = 1_500;
export const SIGNAL_STALL_THRESHOLD_MS = 1_200;
export const SIGNAL_DEGRADED_THRESHOLD_MS = 400;
export const SIGNAL_DEGRADED_RTT_MS = 90;
export const LOCAL_SURVIVAL_MIN_BUFFERED_MS = 250;
export const DISCONNECT_RELOAD_DELAY_MS = 50;
export const SETTINGS_UPDATED_EVENT_NAME = "tesroid:settings-updated";

// Spec: docs/specs/02-session-multidisplay.md#2.1
export function isPrimaryAuthorityRole(role: SessionRole | null): boolean {
  return role === "PRIMARY" || role === "ACTING_PRIMARY";
}

// Spec: docs/specs/07-ui-hud-settings.md#2.1
export function computeSignalQuality(
  wsStatus: WsConnectionStatus,
  nowMs: number,
  lastPongAtMs: number | null,
  lastVideoAtMs: number | null,
  rttMs: number | null,
): SignalQualityLevel {
  if (wsStatus === "DISCONNECTED" || wsStatus === "TERMINAL_CLOSED") {
    return "disconnected";
  }
  if (wsStatus === "CONNECTING") {
    return "reconnecting";
  }

  let maxInactivityGapMs = 0;
  if (lastPongAtMs !== null) {
    maxInactivityGapMs = Math.max(maxInactivityGapMs, nowMs - lastPongAtMs);
  }
  if (lastVideoAtMs !== null) {
    maxInactivityGapMs = Math.max(maxInactivityGapMs, nowMs - lastVideoAtMs);
  }

  if (maxInactivityGapMs > SIGNAL_STALL_THRESHOLD_MS) {
    return "stall";
  }
  if (
    maxInactivityGapMs > SIGNAL_DEGRADED_THRESHOLD_MS ||
    (rttMs !== null && rttMs >= SIGNAL_DEGRADED_RTT_MS)
  ) {
    return "degraded";
  }
  return "good";
}

function formatSecondsOneDecimal(ms: number): string {
  const sec = Math.max(0, ms) / 1_000;
  return `${sec.toFixed(1)}s`;
}

// Spec: docs/specs/07-ui-hud-settings.md#2.1
export function formatHudModeLabel(hud: HudUiState): string {
  switch (hud.modeBadge) {
    case "HOLD":
      return `HOLD L:${formatSecondsOneDecimal(hud.localBufferedMs)} S:${formatSecondsOneDecimal(hud.serverBufferedMs)}`;
    case "DIRECT_LIVE":
      return "DIRECT LIVE";
    case "WAIT":
      return `WAIT L:${formatSecondsOneDecimal(hud.localBufferedMs)} S:${formatSecondsOneDecimal(hud.serverBufferedMs)}`;
    case "BUF":
      return `BUF L:${formatSecondsOneDecimal(hud.localBufferedMs)} S:${formatSecondsOneDecimal(hud.serverBufferedMs)}`;
    case "LIVE":
      return hud.liveLatencyOffsetMs > 0
        ? `LIVE (+${Math.round(hud.liveLatencyOffsetMs)}ms)`
        : "LIVE";
    case "STANDBY":
      return "STANDBY";
  }
}

// Spec: docs/specs/07-ui-hud-settings.md#2.1
export function formatBitrateLabel(bps: number): string {
  const mbps = bps / 1_000_000;
  if (Math.abs(mbps - 0.25) < 0.01) {
    return "0.25M";
  }
  if (Math.abs(mbps - 0.75) < 0.01) {
    return "0.75M";
  }
  return `${mbps.toFixed(1)}M`;
}

// Spec: docs/specs/07-ui-hud-settings.md#2.1
export function buildYouTubeSearchUrl(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (isAllowedHttpUrl(trimmed)) {
    return trimmed;
  }
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(trimmed)}`;
}

// Spec: docs/specs/07-ui-hud-settings.md#2.1
export function nextAllowedFps(currentFps: number, allowedFps: readonly number[]): number {
  if (allowedFps.length === 0) {
    return currentFps;
  }
  const exactIndex = allowedFps.indexOf(currentFps);
  if (exactIndex >= 0) {
    const next = allowedFps[(exactIndex + 1) % allowedFps.length];
    return next ?? currentFps;
  }
  return allowedFps[0] ?? currentFps;
}

function defaultWsUrl(): string {
  // 実ブラウザの location はアクセッサプロパティであり、値ディスクリプタ経由の読み出しでは必ず undefined になる（仕様 03 AC-07）
  const loc = (
    globalThis as { readonly location?: { readonly protocol?: string; readonly host?: string } }
  ).location;
  if (loc !== undefined && typeof loc.host === "string" && loc.host.length > 0) {
    const wsProtocol = loc.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${loc.host}/ws`;
  }
  return "ws://127.0.0.1/ws";
}

function createInitialHudState(): HudUiState {
  return {
    drawer: "none",
    dimmed: false,
    modeBadge: "STANDBY",
    localBufferedMs: 0,
    serverBufferedMs: 0,
    rttMs: null,
    signalLevel: "disconnected",
    renderedFps: 0,
    isStaticScreen: false,
    waitingForKeyframe: false,
    liveLatencyOffsetMs: 0,
    currentUrl: null,
    currentTitle: null,
    isYouTubePage: false,
    lastResetClickedAtMs: -HUD_RESET_DEBOUNCE_MS,
  };
}

function createInitialAppState(): AppState {
  return {
    route: "CONNECTING",
    wsStatus: "DISCONNECTED",
    powerState: "STOPPED",
    streamingState: createInitialStreamingState(),
    role: null,
    isAuthenticated: false,
    systemStatus: null,
    settings: null,
    health: null,
    metricsSummary: null,
    activeModal: { kind: "none" },
    hud: createInitialHudState(),
    remainingPinAttempts: AUTH_SECURITY_CONSTANTS.maxConsecutiveFailures,
    errorBanner: null,
    lastCloseReason: null,
    audioUnlockNeeded: false,
    localBufferSurvivalActive: false,
    preferSecondaryStandby: false,
  };
}

function reduceAppState(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_ROUTE":
      return state.route === action.route ? state : { ...state, route: action.route };
    case "SET_SYSTEM_STATUS":
      return { ...state, systemStatus: action.status };
    case "SET_WS_STATUS":
      return state.wsStatus === action.wsStatus ? state : { ...state, wsStatus: action.wsStatus };
    case "SET_POWER_STATE":
      return state.powerState === action.powerState
        ? state
        : { ...state, powerState: action.powerState };
    case "SET_STREAMING_STATE":
      return { ...state, streamingState: action.streamingState };
    case "SET_ROLE":
      return state.role === action.role ? state : { ...state, role: action.role };
    case "SET_AUTHENTICATED":
      return state.isAuthenticated === action.authenticated
        ? state
        : { ...state, isAuthenticated: action.authenticated };
    case "SET_SETTINGS":
      return { ...state, settings: action.settings };
    case "SET_HEALTH":
      return { ...state, health: action.health };
    case "SET_METRICS_SUMMARY":
      return { ...state, metricsSummary: action.summary };
    case "SET_DRAWER":
      return state.hud.drawer === action.drawer
        ? state
        : { ...state, hud: { ...state.hud, drawer: action.drawer } };
    case "SET_HUD_DIMMED":
      return state.hud.dimmed === action.dimmed
        ? state
        : { ...state, hud: { ...state.hud, dimmed: action.dimmed } };
    case "OPEN_MODAL":
      return { ...state, activeModal: action.modal };
    case "CLOSE_MODAL":
      return state.activeModal.kind === "none"
        ? state
        : { ...state, activeModal: { kind: "none" } };
    case "SET_PIN_ATTEMPTS":
      return state.remainingPinAttempts === action.remainingAttempts
        ? state
        : { ...state, remainingPinAttempts: action.remainingAttempts };
    case "SET_ERROR_BANNER":
      return state.errorBanner === action.message
        ? state
        : { ...state, errorBanner: action.message };
    case "SET_LAST_CLOSE_REASON":
      return state.lastCloseReason === action.reason
        ? state
        : { ...state, lastCloseReason: action.reason };
    case "SET_AUDIO_UNLOCK_NEEDED":
      return state.audioUnlockNeeded === action.needed
        ? state
        : { ...state, audioUnlockNeeded: action.needed };
    case "SET_LOCAL_BUFFER_SURVIVAL":
      return state.localBufferSurvivalActive === action.active
        ? state
        : { ...state, localBufferSurvivalActive: action.active };
    case "SET_PREFER_SECONDARY_STANDBY":
      return state.preferSecondaryStandby === action.prefer
        ? state
        : { ...state, preferSecondaryStandby: action.prefer };
    case "SET_LAST_RESET_CLICKED_AT":
      return { ...state, hud: { ...state.hud, lastResetClickedAtMs: action.atMs } };
    case "UPDATE_HUD_TELEMETRY":
      return { ...state, hud: { ...state.hud, ...action.patch } };
    case "UPDATE_PAGE_INFO":
      return {
        ...state,
        hud: {
          ...state.hud,
          currentUrl: action.url,
          currentTitle: action.title,
          isYouTubePage: action.url !== null && isStrictYouTubeUrl(action.url),
        },
      };
  }
}

function dispatchSettingsUpdatedDomEvent(settings: PublicAppSettings): void {
  const dispatchEventFn = Object.getOwnPropertyDescriptor(globalThis, "dispatchEvent")?.value;
  const customEventCtor = Object.getOwnPropertyDescriptor(globalThis, "CustomEvent")?.value;
  if (typeof dispatchEventFn === "function" && typeof customEventCtor === "function") {
    try {
      const ctor = customEventCtor as new (type: string, init?: { detail?: unknown }) => Event;
      dispatchEventFn(new ctor(SETTINGS_UPDATED_EVENT_NAME, { detail: settings }));
    } catch {
      // Ignore environments without DOM CustomEvent support.
    }
  }
}

export class AppStore {
  private readonly deps: AppStoreDeps;
  private readonly clock: ClientClock;
  private readonly wsUrl: string;
  private readonly listeners = new Set<AppStateListener>();

  private state: AppState = createInitialAppState();
  private disposed = false;
  private pendingAuth: AuthPayload | null = null;
  private lastPongAtMs: number | null = null;
  private lastVideoFrameAtMs: number | null = null;
  private lastResumeClickedAtMs = -RESUME_DEBOUNCE_MS;

  private pendingFpsValue: number | null = null;
  private pendingBitrateValue: number | null = null;
  private fpsDebounceTimer: ClientTimerHandle | null = null;
  private bitrateDebounceTimer: ClientTimerHandle | null = null;
  private autoDimTimer: ClientTimerHandle | null = null;
  private pingTickerTimer: ClientTimerHandle | null = null;
  private reloadTimer: ClientTimerHandle | null = null;

  // Spec: docs/architecture.md#3.3
  constructor(deps: AppStoreDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? createBrowserClock();
    this.wsUrl = deps.wsUrl ?? defaultWsUrl();
  }

  // Spec: docs/architecture.md#3.3
  getState(): AppState {
    return this.state;
  }

  // Spec: docs/architecture.md#3.3
  subscribe(listener: AppStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Spec: docs/architecture.md#3.3
  dispatch(action: AppAction): void {
    if (this.disposed) {
      return;
    }
    const nextState = reduceAppState(this.state, action);
    if (nextState === this.state) {
      return;
    }
    this.state = nextState;
    for (const listener of [...this.listeners]) {
      listener(this.state);
    }
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  async bootstrap(): Promise<void> {
    this.dispatch({ type: "SET_ROUTE", route: "CONNECTING" });
    this.dispatch({ type: "SET_ERROR_BANNER", message: null });

    const statusResult = await this.deps.rest.getStatus();
    if (this.disposed) {
      return;
    }
    if (!statusResult.ok) {
      this.dispatch({ type: "SET_ROUTE", route: "CONNECTION_ERROR" });
      this.dispatch({ type: "SET_ERROR_BANNER", message: statusResult.error });
      return;
    }

    const status = statusResult.data;
    this.dispatch({ type: "SET_SYSTEM_STATUS", status });
    this.dispatch({ type: "SET_PIN_ATTEMPTS", remainingAttempts: status.remainingAttempts });
    this.dispatch({ type: "SET_POWER_STATE", powerState: status.powerState });

    if (
      status.isLocked ||
      status.consecutiveFailures >= AUTH_SECURITY_CONSTANTS.maxConsecutiveFailures
    ) {
      this.dispatch({ type: "SET_ROUTE", route: "LOCKED" });
      return;
    }

    if (!status.isSetupCompleted) {
      this.dispatch({ type: "SET_ROUTE", route: "SETUP" });
      return;
    }

    const stored = this.deps.sessionStorage.load();
    if (stored !== null) {
      this.deps.rest.setToken(stored.token);
      this.dispatch({ type: "SET_ROLE", role: stored.role });
      this.connectWithAuthPayload({ kind: "TOKEN", token: stored.token });
      return;
    }

    this.dispatch({ type: "SET_ROUTE", route: "PIN" });
  }

  // Spec: docs/specs/01-auth-security.md#2.3
  async submitSetup(input: SetupRequestInput): Promise<boolean> {
    this.dispatch({ type: "SET_ERROR_BANNER", message: null });
    const result = await this.deps.rest.completeSetup(input);
    if (this.disposed) {
      return false;
    }
    if (!result.ok) {
      this.dispatch({ type: "SET_ERROR_BANNER", message: result.error });
      return false;
    }

    this.applyAuthoritativeSettings(result.data);
    if (this.state.systemStatus !== null) {
      this.dispatch({
        type: "SET_SYSTEM_STATUS",
        status: { ...this.state.systemStatus, isSetupCompleted: true },
      });
    }
    this.dispatch({ type: "SET_ROUTE", route: "PIN" });
    return true;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  async loginPrimaryPin(pin: string): Promise<void> {
    this.dispatch({ type: "SET_ERROR_BANNER", message: null });
    this.dispatch({ type: "SET_PREFER_SECONDARY_STANDBY", prefer: false });
    this.dispatch({ type: "SET_ROUTE", route: "CONNECTING" });
    this.connectWithAuthPayload({ kind: "PRIMARY_PIN", pin });
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  async loginSecondaryPin(pin: string, preferStandby = false): Promise<void> {
    this.dispatch({ type: "SET_ERROR_BANNER", message: null });
    this.dispatch({ type: "SET_PREFER_SECONDARY_STANDBY", prefer: preferStandby });
    this.dispatch({ type: "SET_ROUTE", route: "CONNECTING" });
    this.connectWithAuthPayload({ kind: "SECONDARY_PIN", pin });
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  disconnectExplicit(): void {
    this.sendControl({ type: "DISCONNECT" });
    this.pendingAuth = null;
    this.clearOperationalTimers();
    this.deps.metrics?.stop();
    this.deps.telemetry?.setEnabled(false);
    this.deps.sessionStorage.clear();
    this.deps.rest.setToken(null);
    this.dispatch({ type: "SET_AUTHENTICATED", authenticated: false });
    this.dispatch({ type: "SET_ROLE", role: null });
    this.dispatch({ type: "CLOSE_MODAL" });
    this.deps.transport.disconnect(WS_CLOSE_CODE.NORMAL, "User disconnected");
    this.dispatch({ type: "SET_WS_STATUS", wsStatus: "DISCONNECTED" });
    this.dispatch({ type: "SET_ROUTE", route: "PIN" });

    this.clearReloadTimer();
    this.reloadTimer = this.clock.setTimeout(() => {
      this.reloadTimer = null;
      if (this.deps.onReload !== undefined) {
        this.deps.onReload();
        return;
      }
      const loc = Object.getOwnPropertyDescriptor(globalThis, "location")?.value as
        | { reload?: () => void }
        | undefined;
      loc?.reload?.();
    }, DISCONNECT_RELOAD_DELAY_MS);
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  async requestStreamReset(): Promise<void> {
    if (!isPrimaryAuthorityRole(this.state.role)) {
      return;
    }
    const nowMs = this.clock.nowMs();
    if (nowMs - this.state.hud.lastResetClickedAtMs < HUD_RESET_DEBOUNCE_MS) {
      return;
    }
    this.recordHudActivity();
    this.dispatch({ type: "SET_LAST_RESET_CLICKED_AT", atMs: nowMs });

    const result = await this.deps.rest.resetStream();
    if (this.disposed) {
      return;
    }
    if (!result.ok) {
      this.dispatch({ type: "SET_ERROR_BANNER", message: result.error });
      return;
    }
    this.dispatch({ type: "SET_POWER_STATE", powerState: result.data.state });
    this.deps.playback.resetForNewEpoch(result.data.streamEpoch);
    this.syncPlaybackHudMetrics();
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  async cycleFps(): Promise<void> {
    const settings = this.state.settings;
    if (settings === null) {
      return;
    }
    this.recordHudActivity();
    const resolved = resolveClientProfile(settings.stream.clientProfile);
    const baseFps = this.pendingFpsValue ?? settings.stream.fps;
    const nextFps = nextAllowedFps(baseFps, resolved.allowedFps);
    this.pendingFpsValue = nextFps;

    if (this.fpsDebounceTimer !== null) {
      this.clock.clearTimeout(this.fpsDebounceTimer);
    }
    this.fpsDebounceTimer = this.clock.setTimeout(() => {
      this.fpsDebounceTimer = null;
      const targetFps = this.pendingFpsValue;
      this.pendingFpsValue = null;
      if (targetFps !== null) {
        void this.saveSettings({ stream: { fps: targetFps } });
      }
    }, HUD_QUICK_TOGGLE_DEBOUNCE_MS);
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  async cycleBitrate(): Promise<void> {
    const settings = this.state.settings;
    if (settings === null) {
      return;
    }
    this.recordHudActivity();
    const baseBitrate = this.pendingBitrateValue ?? settings.stream.videoBitrate;
    const nextBitrate = nextHudBitrate(baseBitrate);
    this.pendingBitrateValue = nextBitrate;

    if (this.bitrateDebounceTimer !== null) {
      this.clock.clearTimeout(this.bitrateDebounceTimer);
    }
    this.bitrateDebounceTimer = this.clock.setTimeout(() => {
      this.bitrateDebounceTimer = null;
      const targetBitrate = this.pendingBitrateValue;
      this.pendingBitrateValue = null;
      if (targetBitrate !== null) {
        void this.saveSettings({ stream: { videoBitrate: targetBitrate } });
      }
    }, HUD_QUICK_TOGGLE_DEBOUNCE_MS);
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.4
  async saveSettings(patch: SettingsUpdateInput): Promise<boolean> {
    this.dispatch({ type: "SET_ERROR_BANNER", message: null });
    const result = await this.deps.rest.updateSettings(patch);
    if (this.disposed) {
      return false;
    }
    if (!result.ok) {
      this.dispatch({ type: "SET_ERROR_BANNER", message: result.error });
      return false;
    }
    this.applyAuthoritativeSettings(result.data);
    return true;
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  navigateToUrl(url: string): void {
    if (this.state.role === "SECONDARY_STANDBY") {
      return;
    }
    const trimmed = url.trim();
    if (!isAllowedHttpUrl(trimmed)) {
      this.dispatch({
        type: "SET_ERROR_BANNER",
        message: "有効な http(s):// URL を入力してください",
      });
      return;
    }
    this.recordHudActivity();
    this.dispatch({ type: "SET_ERROR_BANNER", message: null });
    this.sendControl({ type: "NAVIGATE", url: trimmed });
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  navigateBack(): void {
    if (this.state.role === "SECONDARY_STANDBY") {
      return;
    }
    this.recordHudActivity();
    this.sendControl({ type: "HISTORY_BACK" });
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  navigateHome(): void {
    if (this.state.role === "SECONDARY_STANDBY") {
      return;
    }
    this.recordHudActivity();
    const homeUrl = resolveHomeUrl(this.state.settings?.favorites ?? DEFAULT_FAVORITES);
    this.sendControl({ type: "NAVIGATE", url: homeUrl });
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  sendInputText(text: string): void {
    if (this.state.role === "SECONDARY_STANDBY" || text.length === 0) {
      return;
    }
    this.recordHudActivity();
    this.sendControl({ type: "INPUT_TEXT", text });
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  sendInputKey(key: SpecialKey): void {
    if (this.state.role === "SECONDARY_STANDBY") {
      return;
    }
    this.recordHudActivity();
    this.sendControl({ type: "INPUT_KEY", key });
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  toggleDrawer(target: Exclude<HudDrawerState, "none">): void {
    const next: HudDrawerState = this.state.hud.drawer === target ? "none" : target;
    this.dispatch({ type: "SET_DRAWER", drawer: next });
    this.recordHudActivity();
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  closeDrawer(): void {
    if (this.state.hud.drawer !== "none") {
      this.dispatch({ type: "SET_DRAWER", drawer: "none" });
      this.recordHudActivity();
    }
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  recordHudActivity(): void {
    if (this.disposed) {
      return;
    }
    this.dispatch({ type: "SET_HUD_DIMMED", dimmed: false });
    this.rearmAutoDimTimer();
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.2
  openModal(modal: ActiveModalState): void {
    this.dispatch({ type: "OPEN_MODAL", modal });
    this.recordHudActivity();
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.2
  closeModal(): void {
    this.dispatch({ type: "CLOSE_MODAL" });
    this.recordHudActivity();
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  openSettingsWithAuthCheck(): void {
    if (!this.state.isAuthenticated) {
      this.openModal({ kind: "pin_reauth" });
      return;
    }
    this.openModal({ kind: "settings", activeTab: "browser" });
    void this.fetchHealth();
    void this.refreshSettings();
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  async submitPinReauth(pin: string): Promise<boolean> {
    this.dispatch({ type: "SET_ERROR_BANNER", message: null });
    const result = await this.deps.rest.verifyPin(pin);
    if (this.disposed) {
      return false;
    }
    if (!result.ok || !result.data.ok || typeof result.data.token !== "string") {
      const remaining =
        !result.ok && typeof result.data?.remainingAttempts === "number"
          ? result.data.remainingAttempts
          : this.state.remainingPinAttempts;
      this.dispatch({ type: "SET_PIN_ATTEMPTS", remainingAttempts: remaining });
      const message = !result.ok ? result.error : (result.data.error ?? "PIN 認証に失敗しました");
      this.dispatch({ type: "SET_ERROR_BANNER", message });
      if (remaining <= 0) {
        this.clearOperationalTimers();
        this.deps.transport.disconnect();
        this.dispatch({ type: "CLOSE_MODAL" });
        this.dispatch({ type: "SET_ROUTE", route: "LOCKED" });
      }
      return false;
    }

    const role = result.data.role ?? this.state.role ?? "PRIMARY";
    this.deps.rest.setToken(result.data.token);
    this.deps.sessionStorage.save({ token: result.data.token, role });
    this.dispatch({ type: "SET_AUTHENTICATED", authenticated: true });
    this.dispatch({
      type: "SET_PIN_ATTEMPTS",
      remainingAttempts: AUTH_SECURITY_CONSTANTS.maxConsecutiveFailures,
    });
    this.openModal({ kind: "settings", activeTab: "browser" });
    void this.fetchHealth();
    void this.refreshSettings();
    return true;
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.2
  async sleepSystem(): Promise<void> {
    if (!isPrimaryAuthorityRole(this.state.role)) {
      return;
    }
    this.closeModal();
    const result = await this.deps.rest.sleepPower();
    if (this.disposed) {
      return;
    }
    if (!result.ok) {
      this.dispatch({ type: "SET_ERROR_BANNER", message: result.error });
      return;
    }
    this.dispatch({ type: "SET_POWER_STATE", powerState: result.data.state });
    this.deps.playback.dispatchStreamingEvent({ type: "POWER_SLEEP" });
    this.syncPlaybackStateFromController();
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  async resumeSystem(): Promise<void> {
    if (!isPrimaryAuthorityRole(this.state.role)) {
      return;
    }
    const nowMs = this.clock.nowMs();
    if (nowMs - this.lastResumeClickedAtMs < RESUME_DEBOUNCE_MS) {
      return;
    }
    this.lastResumeClickedAtMs = nowMs;

    const result = await this.deps.rest.resumePower();
    if (this.disposed) {
      return;
    }
    if (!result.ok) {
      this.dispatch({ type: "SET_ERROR_BANNER", message: result.error });
      return;
    }
    this.dispatch({ type: "SET_POWER_STATE", powerState: result.data.state });
    this.deps.playback.resetForNewEpoch(result.data.streamEpoch);
    this.deps.playback.dispatchStreamingEvent({
      type: "SESSION_ACTIVATED",
      streamEpoch: result.data.streamEpoch,
    });
    this.syncPlaybackStateFromController();
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.2
  async restartBrowser(): Promise<void> {
    if (!isPrimaryAuthorityRole(this.state.role)) {
      return;
    }
    this.closeModal();
    const result = await this.deps.rest.restartBrowser();
    if (this.disposed) {
      return;
    }
    if (!result.ok) {
      this.dispatch({ type: "SET_ERROR_BANNER", message: result.error });
      return;
    }
    this.dispatch({ type: "SET_POWER_STATE", powerState: result.data.state });
    this.deps.playback.resetForNewEpoch(result.data.streamEpoch);
    this.syncPlaybackStateFromController();
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  reconnectFromSuperseded(): void {
    const stored = this.deps.sessionStorage.load();
    if (stored === null) {
      this.returnToPin();
      return;
    }
    this.dispatch({ type: "SET_ERROR_BANNER", message: null });
    this.dispatch({ type: "SET_ROUTE", route: "CONNECTING" });
    this.deps.rest.setToken(stored.token);
    this.connectWithAuthPayload({ kind: "TOKEN", token: stored.token });
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  returnToPin(): void {
    this.pendingAuth = null;
    this.clearOperationalTimers();
    this.deps.metrics?.stop();
    this.deps.telemetry?.setEnabled(false);
    this.deps.sessionStorage.clear();
    this.deps.rest.setToken(null);
    this.deps.transport.disconnect();
    this.dispatch({ type: "SET_AUTHENTICATED", authenticated: false });
    this.dispatch({ type: "SET_ROLE", role: null });
    this.dispatch({ type: "SET_LAST_CLOSE_REASON", reason: null });
    this.dispatch({ type: "SET_ERROR_BANNER", message: null });
    this.dispatch({ type: "SET_ROUTE", route: "PIN" });
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.4
  async fetchHealth(): Promise<void> {
    const result = await this.deps.rest.getHealth();
    if (this.disposed || !result.ok) {
      return;
    }
    this.dispatch({ type: "SET_HEALTH", health: result.data });
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.4
  async refreshSettings(): Promise<void> {
    const result = await this.deps.rest.getSettings();
    if (this.disposed || !result.ok) {
      return;
    }
    this.applyAuthoritativeSettings(result.data);
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.4
  async fetchMetricsSummary(): Promise<void> {
    const result = await this.deps.rest.getMetricsSummary();
    if (this.disposed || !result.ok) {
      return;
    }
    this.dispatch({ type: "SET_METRICS_SUMMARY", summary: result.data });
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.4
  async deleteTelemetryLogs(): Promise<boolean> {
    const result = await this.deps.rest.deleteTelemetrySessions();
    if (this.disposed) {
      return false;
    }
    if (!result.ok) {
      this.dispatch({ type: "SET_ERROR_BANNER", message: result.error });
      return false;
    }
    return true;
  }

  // Spec: docs/specs/02-session-multidisplay.md#4
  async unlockAudioOnGesture(): Promise<void> {
    await this.deps.playback.unlockAudioOnGesture();
    if (!this.disposed && this.state.audioUnlockNeeded) {
      this.dispatch({ type: "SET_AUDIO_UNLOCK_NEEDED", needed: false });
    }
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  sendTouchFrame(frame: TouchFrame): void {
    if (this.state.role === "SECONDARY_STANDBY") {
      return;
    }
    this.deps.transport.sendBinary(encodeTouchFrame(frame));
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.2
  notifyUserInteraction(atMs: number): void {
    if (this.state.role === "SECONDARY_STANDBY") {
      return;
    }
    const streamEpoch = this.deps.playback.getStreamingState().streamEpoch;
    this.deps.playback.dispatchStreamingEvent({
      type: "USER_INTERACTION",
      atMs,
      newStreamEpoch: streamEpoch,
    });
    this.syncPlaybackStateFromController();
    this.recordHudActivity();
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  sendResizeFrame(frame: ResizeFrame): void {
    if (!isPrimaryAuthorityRole(this.state.role)) {
      return;
    }
    this.deps.transport.sendBinary(encodeResizeFrame(frame));
  }

  // Spec: docs/architecture.md#3.3
  dispose(): void {
    this.disposed = true;
    this.clearOperationalTimers();
    this.clearReloadTimer();
    this.deps.metrics?.stop();
    this.deps.telemetry?.setEnabled(false);
    this.listeners.clear();
  }

  private connectWithAuthPayload(payload: AuthPayload): void {
    this.pendingAuth = payload;
    this.dispatch({ type: "SET_WS_STATUS", wsStatus: "CONNECTING" });

    this.deps.transport.connect(this.wsUrl, {
      onOpen: () => {
        if (this.disposed) {
          return;
        }
        this.dispatch({ type: "SET_WS_STATUS", wsStatus: "CONNECTED" });
        this.dispatch({ type: "SET_LOCAL_BUFFER_SURVIVAL", active: false });
        const authPayload = this.resolveReconnectAuthPayload();
        if (authPayload !== null) {
          this.deps.transport.sendBinary(encodeAuthFrame(authPayload));
        }
      },
      onBinaryMessage: (data) => {
        if (!this.disposed) {
          this.handleWsBinaryMessage(data);
        }
      },
      onClose: (info) => {
        if (!this.disposed) {
          this.handleWsClose(info);
        }
      },
      onError: () => {
        if (!this.disposed) {
          this.syncPlaybackHudMetrics();
        }
      },
    });
  }

  private resolveReconnectAuthPayload(): AuthPayload | null {
    if (this.pendingAuth !== null) {
      return this.pendingAuth;
    }
    const stored = this.deps.sessionStorage.load();
    if (stored !== null) {
      return { kind: "TOKEN", token: stored.token };
    }
    return null;
  }

  private handleWsBinaryMessage(data: Uint8Array): void {
    if (data.byteLength === 0) {
      return;
    }
    const channel = data[0];
    if (channel === CHANNEL_ID.VIDEO || channel === CHANNEL_ID.AUDIO) {
      let frame: ReturnType<typeof decodeMediaFrame>;
      try {
        frame = decodeMediaFrame(data);
      } catch {
        return;
      }
      if (channel === CHANNEL_ID.VIDEO) {
        this.lastVideoFrameAtMs = this.clock.nowMs();
        this.deps.metrics?.recordVideoPacket(data.byteLength);
      } else {
        this.deps.metrics?.recordAudioPacket();
      }
      this.deps.playback.handleMediaFrame(frame);
      return;
    }

    if (channel !== CHANNEL_ID.CONTROL_RESPONSE) {
      return;
    }

    let message: ReturnType<typeof decodeServerControlFrame>;
    try {
      message = decodeServerControlFrame(data);
    } catch {
      return;
    }

    switch (message.type) {
      case "AUTH_REQUIRED": {
        const authPayload = this.resolveReconnectAuthPayload();
        if (authPayload !== null) {
          this.deps.transport.sendBinary(encodeAuthFrame(authPayload));
          return;
        }
        this.dispatch({
          type: "SET_ROUTE",
          route: message.isSetupCompleted ? "PIN" : "SETUP",
        });
        return;
      }
      case "AUTH_OK": {
        this.pendingAuth = { kind: "TOKEN", token: message.token };
        this.deps.sessionStorage.save({ token: message.token, role: message.role });
        this.deps.rest.setToken(message.token);
        this.dispatch({ type: "SET_AUTHENTICATED", authenticated: true });
        this.dispatch({ type: "SET_ROLE", role: message.role });
        this.dispatch({ type: "SET_POWER_STATE", powerState: message.powerState });
        this.dispatch({
          type: "SET_PIN_ATTEMPTS",
          remainingAttempts: AUTH_SECURITY_CONSTANTS.maxConsecutiveFailures,
        });
        this.dispatch({ type: "SET_ERROR_BANNER", message: null });
        this.dispatch({ type: "SET_LAST_CLOSE_REASON", reason: null });
        this.dispatch({ type: "SET_AUDIO_UNLOCK_NEEDED", needed: false });
        this.dispatch({ type: "SET_ROUTE", route: "STREAMING" });
        this.applyAuthoritativeSettings(message.settings);

        const primaryAuthority = isPrimaryAuthorityRole(message.role);
        this.deps.playback.setPrimaryAuthority(primaryAuthority);
        this.deps.playback.setAudioEnabled(primaryAuthority);

        if (message.role === "SECONDARY_STANDBY") {
          this.deps.playback.dispatchStreamingEvent({
            type: "ENTER_STANDBY",
            reason: "REAR_STANDBY",
          });
        } else if (message.powerState === "SLEEP_PAUSED") {
          this.deps.playback.dispatchStreamingEvent({ type: "POWER_SLEEP" });
        } else {
          this.deps.playback.dispatchStreamingEvent({
            type: "SESSION_ACTIVATED",
            streamEpoch: message.streamEpoch,
          });
        }

        this.syncPlaybackStateFromController();
        this.deps.metrics?.start();
        this.startPingTicker();
        this.rearmAutoDimTimer();
        return;
      }
      case "AUTH_FAILED": {
        const failedKind = this.pendingAuth?.kind;
        this.pendingAuth = null;
        this.dispatch({ type: "SET_PIN_ATTEMPTS", remainingAttempts: message.remainingAttempts });
        this.dispatch({ type: "SET_ERROR_BANNER", message: message.reason });
        if (failedKind === "TOKEN") {
          this.deps.sessionStorage.clear();
          this.deps.rest.setToken(null);
          this.dispatch({ type: "SET_AUTHENTICATED", authenticated: false });
          this.dispatch({ type: "SET_ROLE", role: null });
        }
        if (message.remainingAttempts <= 0) {
          this.clearOperationalTimers();
          this.deps.transport.disconnect();
          this.dispatch({ type: "SET_ROUTE", route: "LOCKED" });
          return;
        }
        this.dispatch({ type: "SET_ROUTE", route: "PIN" });
        return;
      }
      case "SESSION_CONFLICT":
        this.dispatch({ type: "SET_LAST_CLOSE_REASON", reason: message.reason });
        this.dispatch({ type: "SET_ERROR_BANNER", message: message.reason });
        return;
      case "SESSION_ROLE_CHANGED": {
        const prevRole = this.state.role;
        this.dispatch({ type: "SET_ROLE", role: message.role });
        const stored = this.deps.sessionStorage.load();
        if (stored !== null) {
          this.deps.sessionStorage.save({ token: stored.token, role: message.role });
        }
        const primaryAuthority = isPrimaryAuthorityRole(message.role);
        this.deps.playback.setPrimaryAuthority(primaryAuthority);
        this.deps.playback.setAudioEnabled(primaryAuthority);
        this.deps.playback.resetForNewEpoch(message.streamEpoch);
        if (message.role === "ACTING_PRIMARY" && prevRole !== "ACTING_PRIMARY") {
          this.dispatch({ type: "SET_AUDIO_UNLOCK_NEEDED", needed: true });
        } else if (!primaryAuthority) {
          this.dispatch({ type: "SET_AUDIO_UNLOCK_NEEDED", needed: false });
        }
        if (message.role === "SECONDARY_STANDBY") {
          this.deps.playback.dispatchStreamingEvent({
            type: "ENTER_STANDBY",
            reason: "REAR_STANDBY",
          });
        } else {
          this.deps.playback.dispatchStreamingEvent({
            type: "SESSION_ACTIVATED",
            streamEpoch: message.streamEpoch,
          });
        }
        this.syncPlaybackStateFromController();
        return;
      }
      case "PRIMARY_SESSION_STATUS": {
        if (message.active) {
          if (this.state.role === "SECONDARY_STANDBY") {
            this.dispatch({ type: "SET_ROLE", role: "SECONDARY_STREAMING" });
            const stored = this.deps.sessionStorage.load();
            if (stored !== null) {
              this.deps.sessionStorage.save({ token: stored.token, role: "SECONDARY_STREAMING" });
            }
          }
          if (!isPrimaryAuthorityRole(this.state.role)) {
            this.deps.playback.dispatchStreamingEvent({
              type: "SESSION_ACTIVATED",
              streamEpoch: message.streamEpoch,
            });
            this.syncPlaybackStateFromController();
          }
          return;
        }

        if (this.state.role === "SECONDARY_STREAMING") {
          this.dispatch({ type: "SET_ROLE", role: "SECONDARY_STANDBY" });
          const stored = this.deps.sessionStorage.load();
          if (stored !== null) {
            this.deps.sessionStorage.save({ token: stored.token, role: "SECONDARY_STANDBY" });
          }
          this.deps.playback.dispatchStreamingEvent({
            type: "ENTER_STANDBY",
            reason: "REAR_STANDBY",
          });
          this.syncPlaybackStateFromController();
        }
        return;
      }
      case "PONG": {
        const nowMs = this.clock.nowMs();
        const rawRttMs = Math.max(0, nowMs - message.clientTimestampMs);
        this.lastPongAtMs = nowMs;

        const stats = this.deps.playback.getStatsSnapshot();
        const isLiveZeroQueue =
          this.state.streamingState.kind === "LIVE" && stats.localVideoBufferedMs <= 0;
        this.deps.metrics?.recordRttSample(rawRttMs, isLiveZeroQueue);

        this.deps.playback.updatePrimarySyncRef({
          primaryRenderedPts: message.primaryRenderedPts,
          primaryFeedbackAgeMs: message.primaryFeedbackAgeMs,
          primaryTargetBufferMs: message.primaryTargetBufferMs,
          primaryMode: message.primaryMode,
        });

        this.syncPlaybackHudMetrics({
          rttMs: rawRttMs,
          serverBufferedMs: message.serverRemainingBufferMs,
        });
        return;
      }
      case "STREAM_STATE": {
        if (this.state.role === "SECONDARY_STANDBY" && message.state.kind !== "STANDBY") {
          return;
        }
        this.dispatch({ type: "SET_STREAMING_STATE", streamingState: message.state });
        if (message.state.kind === "STANDBY") {
          this.deps.playback.dispatchStreamingEvent({
            type: "ENTER_STANDBY",
            reason: message.state.reason,
          });
        } else if (message.state.kind === "BUFFER_HOLD") {
          this.deps.playback.dispatchStreamingEvent({
            type: "HOLD_THRESHOLD_REACHED",
            atMs: message.state.holdSinceMs,
          });
        } else if (message.state.kind === "CATCHUP") {
          this.deps.playback.dispatchStreamingEvent({
            type: "SESSION_ACTIVATED",
            streamEpoch: message.state.streamEpoch,
            resumeCatchup: {
              targetBufferMs: message.state.targetBufferMs,
              resumePtsUs: message.state.resumePtsUs,
            },
          });
        } else if (message.state.kind === "LIVE") {
          this.deps.playback.dispatchStreamingEvent({
            type: "SESSION_ACTIVATED",
            streamEpoch: message.state.streamEpoch,
          });
        }
        this.syncPlaybackHudMetrics();
        return;
      }
      case "BUFFER_HOLD": {
        if (this.state.role === "SECONDARY_STANDBY") {
          return;
        }
        this.dispatch({
          type: "SET_POWER_STATE",
          powerState: message.active ? "BUFFER_HOLD" : "ACTIVE",
        });
        if (message.active) {
          this.deps.playback.dispatchStreamingEvent({
            type: "HOLD_THRESHOLD_REACHED",
            atMs: this.clock.nowMs(),
          });
        } else {
          this.deps.playback.dispatchStreamingEvent({
            type: "HOLD_DRAINED",
            newStreamEpoch: message.streamEpoch,
          });
        }
        this.syncPlaybackStateFromController();
        return;
      }
      case "BROWSER_STATUS": {
        if (this.state.role === "SECONDARY_STANDBY") {
          // Spec 02 §4.2: Standby overlay must never be overwritten by power notifications.
          return;
        }
        this.dispatch({ type: "SET_POWER_STATE", powerState: message.powerState });
        if (message.powerState === "SLEEP_PAUSED") {
          this.deps.playback.dispatchStreamingEvent({ type: "POWER_SLEEP" });
        } else if (
          message.powerState === "ACTIVE" &&
          this.deps.playback.getStreamingState().kind === "STANDBY"
        ) {
          this.deps.playback.dispatchStreamingEvent({
            type: "SESSION_ACTIVATED",
            streamEpoch: message.streamEpoch,
          });
        }
        this.syncPlaybackStateFromController();
        return;
      }
      case "PAGE_INFO":
        this.dispatch({ type: "UPDATE_PAGE_INFO", url: message.url, title: message.title });
        return;
      case "SETTINGS_UPDATED":
        this.applyAuthoritativeSettings(message.settings);
        return;
      case "ERROR":
        this.dispatch({ type: "SET_ERROR_BANNER", message: message.message });
        return;
    }
  }

  private handleWsClose(info: WsCloseEventInfo): void {
    this.dispatch({
      type: "SET_WS_STATUS",
      wsStatus: info.terminal ? "TERMINAL_CLOSED" : "DISCONNECTED",
    });

    if (info.code === WS_CLOSE_CODE.POLICY_VIOLATION) {
      this.pendingAuth = null;
      this.clearOperationalTimers();
      this.deps.metrics?.stop();
      this.deps.transport.disconnect();
      this.dispatch({ type: "SET_ERROR_BANNER", message: info.reason || null });
      this.dispatch({ type: "SET_ROUTE", route: "LOCKED" });
      return;
    }

    if (info.code === WS_CLOSE_CODE.SESSION_SUPERSEDED) {
      this.pendingAuth = null;
      this.clearOperationalTimers();
      this.deps.metrics?.stop();
      this.dispatch({ type: "SET_LAST_CLOSE_REASON", reason: info.reason || null });
      this.dispatch({ type: "SET_ROUTE", route: "SUPERSEDED_4000" });
      return;
    }

    if (info.code === WS_CLOSE_CODE.SESSION_CONFLICT) {
      this.pendingAuth = null;
      this.clearOperationalTimers();
      this.deps.metrics?.stop();
      this.dispatch({ type: "SET_LAST_CLOSE_REASON", reason: info.reason || null });
      this.dispatch({ type: "SET_ROUTE", route: "CONFLICT_4009" });
      return;
    }

    this.pendingAuth = null;
    const stats = this.deps.playback.getStatsSnapshot();
    const survival = stats.localVideoBufferedMs > LOCAL_SURVIVAL_MIN_BUFFERED_MS;
    this.dispatch({ type: "SET_LOCAL_BUFFER_SURVIVAL", active: survival });
    this.syncPlaybackHudMetrics({ rttMs: null });
  }

  private applyAuthoritativeSettings(settings: PublicAppSettings): void {
    this.dispatch({ type: "SET_SETTINGS", settings });
    this.deps.playback.setTargetFps(settings.stream.fps);
    this.deps.playback.setTargetBufferMs(settings.stream.targetBufferMs);
    this.deps.telemetry?.setEnabled(settings.stream.telemetryEnabled);
    this.deps.onSettingsUpdated?.(settings);
    dispatchSettingsUpdatedDomEvent(settings);
  }

  private sendControl(message: ClientControlMessage): boolean {
    if (this.state.wsStatus !== "CONNECTED") {
      return false;
    }
    return this.deps.transport.sendBinary(encodeClientControlFrame(message));
  }

  private syncPlaybackStateFromController(): void {
    const controllerState = this.deps.playback.getStreamingState();
    this.dispatch({ type: "SET_STREAMING_STATE", streamingState: controllerState });
    this.syncPlaybackHudMetrics();
  }

  private syncPlaybackHudMetrics(overrides?: {
    readonly rttMs?: number | null;
    readonly serverBufferedMs?: number;
  }): void {
    const nowMs = this.clock.nowMs();
    const stats = this.deps.playback.getStatsSnapshot();
    const localBufferedMs = Math.max(stats.localVideoBufferedMs, stats.localAudioBufferedMs);
    const serverBufferedMs = overrides?.serverBufferedMs ?? this.state.hud.serverBufferedMs;

    const rttStale =
      this.lastPongAtMs !== null && nowMs - this.lastPongAtMs > PROTOCOL_TIMING.rttStaleTimeoutMs;
    const rttMs =
      overrides !== undefined && "rttMs" in overrides
        ? (overrides.rttMs ?? null)
        : rttStale
          ? null
          : this.state.hud.rttMs;

    const isStaticScreen =
      stats.isStaticScreen ||
      (this.lastVideoFrameAtMs !== null &&
        nowMs - this.lastVideoFrameAtMs >= STATIC_SCREEN_THRESHOLD_MS);

    const modeBadge = selectHudModeBadge(this.state.streamingState, {
      localBufferedMs,
      serverBufferedMs,
      isWaitingForKeyframe: stats.waitingForKeyframe,
    });

    const liveLatencyOffsetMs =
      modeBadge === "LIVE"
        ? Math.max(0, Math.round(Math.max(localBufferedMs, serverBufferedMs)))
        : 0;

    const signalLevel = computeSignalQuality(
      this.state.wsStatus,
      nowMs,
      this.lastPongAtMs,
      this.lastVideoFrameAtMs,
      rttMs,
    );

    this.deps.metrics?.setAvDriftMs(stats.avDriftMs);
    this.deps.metrics?.setDecodeQueueSize(stats.decodeQueueSize);

    this.dispatch({
      type: "UPDATE_HUD_TELEMETRY",
      patch: {
        modeBadge,
        localBufferedMs,
        serverBufferedMs,
        rttMs,
        signalLevel,
        renderedFps: stats.renderedFps,
        isStaticScreen,
        waitingForKeyframe: stats.waitingForKeyframe,
        liveLatencyOffsetMs,
      },
    });
  }

  private startPingTicker(): void {
    this.stopPingTicker();
    const scheduleTick = () => {
      if (this.disposed || this.state.route !== "STREAMING") {
        return;
      }
      this.pingTickerTimer = this.clock.setTimeout(() => {
        this.pingTickerTimer = null;
        if (this.disposed || this.state.route !== "STREAMING") {
          return;
        }
        if (this.state.wsStatus === "CONNECTED") {
          this.sendControl({ type: "PING", clientTimestampMs: this.clock.nowMs() });
        }
        this.syncPlaybackHudMetrics();
        scheduleTick();
      }, PROTOCOL_TIMING.pingIntervalMs);
    };
    scheduleTick();
  }

  private stopPingTicker(): void {
    if (this.pingTickerTimer !== null) {
      this.clock.clearTimeout(this.pingTickerTimer);
      this.pingTickerTimer = null;
    }
  }

  private rearmAutoDimTimer(): void {
    this.clearAutoDimTimer();
    if (
      this.disposed ||
      this.state.route !== "STREAMING" ||
      this.state.hud.drawer !== "none" ||
      this.state.activeModal.kind !== "none"
    ) {
      return;
    }
    this.autoDimTimer = this.clock.setTimeout(() => {
      this.autoDimTimer = null;
      if (
        !this.disposed &&
        this.state.route === "STREAMING" &&
        this.state.hud.drawer === "none" &&
        this.state.activeModal.kind === "none"
      ) {
        this.dispatch({ type: "SET_HUD_DIMMED", dimmed: true });
      }
    }, HUD_AUTO_DIM_MS);
  }

  private clearAutoDimTimer(): void {
    if (this.autoDimTimer !== null) {
      this.clock.clearTimeout(this.autoDimTimer);
      this.autoDimTimer = null;
    }
  }

  private clearOperationalTimers(): void {
    this.stopPingTicker();
    this.clearAutoDimTimer();
    if (this.fpsDebounceTimer !== null) {
      this.clock.clearTimeout(this.fpsDebounceTimer);
      this.fpsDebounceTimer = null;
    }
    if (this.bitrateDebounceTimer !== null) {
      this.clock.clearTimeout(this.bitrateDebounceTimer);
      this.bitrateDebounceTimer = null;
    }
    this.pendingFpsValue = null;
    this.pendingBitrateValue = null;
  }

  private clearReloadTimer(): void {
    if (this.reloadTimer !== null) {
      this.clock.clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }
}
