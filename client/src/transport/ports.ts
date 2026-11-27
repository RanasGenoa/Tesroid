import type {
  ClientMetricsSample,
  HealthResponse,
  MetricsSummary,
  PowerActionResult,
  PowerStatusSnapshot,
  PublicAppSettings,
  SessionRole,
  SettingsUpdateInput,
  SetupRequestInput,
  SystemStatusResponse,
  TelemetrySessionSummary,
  WsCloseCode,
} from "@tesroid/shared";

export interface ClientTimerHandle {
  cancel(): void;
}

export interface ClientClock {
  nowMs(): number;
  setTimeout(callback: () => void, delayMs: number): ClientTimerHandle;
  clearTimeout(handle: ClientTimerHandle): void;
}

export function createBrowserClock(): ClientClock {
  return {
    nowMs: () => Date.now(),
    setTimeout: (callback, delayMs) => {
      const id = globalThis.setTimeout(callback, delayMs);
      return {
        cancel: () => {
          globalThis.clearTimeout(id);
        },
      };
    },
    clearTimeout: (handle) => {
      handle.cancel();
    },
  };
}

export const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export interface WebSocketMessageEventLike {
  readonly data: unknown;
}

export interface WebSocketCloseEventLike {
  readonly code: number;
  readonly reason: string;
}

export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: WebSocketMessageEventLike) => void) | null;
  onclose: ((event: WebSocketCloseEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type WsConnectionStatus = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "TERMINAL_CLOSED";

export interface WsCloseEventInfo {
  readonly code: number;
  readonly reason: string;
  readonly terminal: boolean;
}

export interface WsClientHandlers {
  readonly onOpen?: () => void;
  readonly onBinaryMessage: (data: Uint8Array) => void;
  readonly onClose?: (info: WsCloseEventInfo) => void;
  readonly onError?: () => void;
}

export interface WsTransportPort {
  connect(url: string, handlers: WsClientHandlers): void;
  sendBinary(data: Uint8Array): boolean;
  disconnect(code?: WsCloseCode, reason?: string): void;
  getStatus(): WsConnectionStatus;
}

export type RestApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly code?: string;
      readonly data?: T;
    };

export interface PinVerifyApiResponse {
  readonly ok: boolean;
  readonly token?: string;
  readonly role?: SessionRole;
  readonly remainingAttempts?: number;
  readonly error?: string;
}

export interface RestApiClientPort {
  setToken(token: string | null): void;
  getStatus(): Promise<RestApiResult<SystemStatusResponse>>;
  getHealth(): Promise<RestApiResult<HealthResponse>>;
  completeSetup(input: SetupRequestInput): Promise<RestApiResult<PublicAppSettings>>;
  verifyPin(pin: string): Promise<RestApiResult<PinVerifyApiResponse>>;
  getSettings(): Promise<RestApiResult<PublicAppSettings>>;
  updateSettings(patch: SettingsUpdateInput): Promise<RestApiResult<PublicAppSettings>>;
  getPowerStatus(): Promise<RestApiResult<PowerStatusSnapshot>>;
  sleepPower(): Promise<RestApiResult<PowerActionResult>>;
  resumePower(): Promise<RestApiResult<PowerActionResult>>;
  restartBrowser(): Promise<RestApiResult<PowerActionResult>>;
  resetStream(): Promise<RestApiResult<PowerActionResult>>;
  getMetricsSummary(): Promise<RestApiResult<MetricsSummary>>;
  getMetricsHistory(limit?: number): Promise<RestApiResult<readonly ClientMetricsSample[]>>;
  listTelemetrySessions(): Promise<RestApiResult<readonly TelemetrySessionSummary[]>>;
  deleteTelemetrySessions(): Promise<RestApiResult<{ readonly ok: boolean }>>;
}
