import type {
  HudModeBadge,
  PowerState,
  PublicAppSettings,
  SessionRole,
  SettingsUpdateInput,
  SetupRequestInput,
  StreamingState,
  SystemStatusResponse,
} from "@tesroid/shared";
import type { PlaybackControllerPort } from "../media/ports.js";
import type { RestApiClientPort, WsConnectionStatus, WsTransportPort } from "../transport/ports.js";
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

export type ActiveModalState =
  | { readonly kind: "none" }
  | { readonly kind: "onboarding_guide" }
  | { readonly kind: "power_control" }
  | { readonly kind: "restart_confirm" }
  | { readonly kind: "pin_reauth" }
  | { readonly kind: "settings"; readonly activeTab: "browser" | "general" | "metrics" };

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
  readonly systemStatus: SystemStatusResponse | null;
  readonly settings: PublicAppSettings | null;
  readonly activeModal: ActiveModalState;
  readonly hud: HudUiState;
  readonly remainingPinAttempts: number;
  readonly errorBanner: string | null;
}

export type AppAction =
  | { readonly type: "SET_ROUTE"; readonly route: AppRoute }
  | { readonly type: "SET_SYSTEM_STATUS"; readonly status: SystemStatusResponse }
  | { readonly type: "SET_WS_STATUS"; readonly wsStatus: WsConnectionStatus }
  | { readonly type: "SET_POWER_STATE"; readonly powerState: PowerState }
  | { readonly type: "SET_STREAMING_STATE"; readonly streamingState: StreamingState }
  | { readonly type: "SET_ROLE"; readonly role: SessionRole | null }
  | { readonly type: "SET_SETTINGS"; readonly settings: PublicAppSettings }
  | { readonly type: "SET_DRAWER"; readonly drawer: HudDrawerState }
  | { readonly type: "SET_HUD_DIMMED"; readonly dimmed: boolean }
  | { readonly type: "OPEN_MODAL"; readonly modal: ActiveModalState }
  | { readonly type: "CLOSE_MODAL" }
  | { readonly type: "SET_PIN_ATTEMPTS"; readonly remainingAttempts: number }
  | { readonly type: "SET_ERROR_BANNER"; readonly message: string | null }
  | {
      readonly type: "UPDATE_PAGE_INFO";
      readonly url: string | null;
      readonly title: string | null;
    };

export type AppStateListener = (state: AppState) => void;

export interface AppStoreDeps {
  readonly rest: RestApiClientPort;
  readonly transport: WsTransportPort;
  readonly playback: PlaybackControllerPort;
  readonly sessionStorage: TabSessionStoragePort;
}

export class AppStore {
  // Spec: docs/architecture.md#3.3
  constructor(deps: AppStoreDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#3.3
  getState(): AppState {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#3.3
  subscribe(listener: AppStateListener): () => void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#3.3
  dispatch(action: AppAction): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  bootstrap(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.3
  submitSetup(input: SetupRequestInput): Promise<boolean> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  loginPrimaryPin(pin: string): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  loginSecondaryPin(pin: string, preferStandby?: boolean): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  disconnectExplicit(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  requestStreamReset(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  cycleFps(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  cycleBitrate(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.4
  saveSettings(patch: SettingsUpdateInput): Promise<boolean> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  navigateToUrl(url: string): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  openSettingsWithAuthCheck(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.2
  sleepSystem(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.1
  resumeSystem(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.2
  restartBrowser(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#3.3
  dispose(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
