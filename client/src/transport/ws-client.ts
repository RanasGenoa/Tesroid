import {
  calculateReconnectDelayMs,
  isTerminalCloseCode,
  WS_CLOSE_CODE,
  type WsCloseCode,
} from "@tesroid/shared";
import {
  type ClientClock,
  type ClientTimerHandle,
  createBrowserClock,
  type WebSocketFactory,
  type WebSocketLike,
  WS_READY_STATE,
  type WsClientHandlers,
  type WsConnectionStatus,
  type WsTransportPort,
} from "./ports.js";

export interface ReconnectingWsClientOptions {
  readonly clock?: ClientClock;
  readonly createSocket?: WebSocketFactory;
}

function defaultCreateSocket(url: string): WebSocketLike {
  if (typeof globalThis.WebSocket !== "function") {
    throw new Error("WebSocket is not available in this environment");
  }
  return new globalThis.WebSocket(url) as unknown as WebSocketLike;
}

function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function detachSocketHandlers(ws: WebSocketLike): void {
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
}

export class ReconnectingWsClient implements WsTransportPort {
  private readonly clock: ClientClock;
  private readonly createSocket: WebSocketFactory;

  private status: WsConnectionStatus = "DISCONNECTED";
  private socket: WebSocketLike | null = null;
  private url: string | null = null;
  private handlers: WsClientHandlers | null = null;
  private reconnectTimer: ClientTimerHandle | null = null;
  private reconnectAttempt = 0;
  private manualDisconnect = false;

  // Spec: docs/specs/03-streaming-transport.md#2.1
  constructor(options?: ReconnectingWsClientOptions) {
    this.clock = options?.clock ?? createBrowserClock();
    this.createSocket = options?.createSocket ?? defaultCreateSocket;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  connect(url: string, handlers: WsClientHandlers): void {
    this.clearReconnectTimer();
    this.teardownCurrentSocket(WS_CLOSE_CODE.NORMAL, "Reconnecting");

    this.url = url;
    this.handlers = handlers;
    this.manualDisconnect = false;
    this.reconnectAttempt = 0;
    this.openSocket();
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  sendBinary(data: Uint8Array): boolean {
    if (
      this.socket === null ||
      this.status !== "CONNECTED" ||
      this.socket.readyState !== WS_READY_STATE.OPEN
    ) {
      return false;
    }
    try {
      this.socket.send(data);
      return true;
    } catch {
      return false;
    }
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  disconnect(code?: WsCloseCode, reason?: string): void {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    this.teardownCurrentSocket(code ?? WS_CLOSE_CODE.NORMAL, reason);
    this.status = "DISCONNECTED";
  }

  // Spec: docs/specs/02-session-multidisplay.md#3
  getStatus(): WsConnectionStatus {
    return this.status;
  }

  private openSocket(): void {
    if (this.url === null || this.handlers === null || this.manualDisconnect) {
      return;
    }

    this.status = "CONNECTING";
    const ws = this.createSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.socket = ws;

    ws.onopen = () => {
      if (this.socket !== ws || this.manualDisconnect) {
        return;
      }
      this.status = "CONNECTED";
      this.reconnectAttempt = 0;
      this.handlers?.onOpen?.();
    };

    ws.onmessage = (event) => {
      if (this.socket !== ws || this.manualDisconnect) {
        return;
      }
      const bytes = toUint8Array(event.data);
      if (bytes !== null) {
        this.handlers?.onBinaryMessage(bytes);
      }
    };

    ws.onerror = () => {
      if (this.socket !== ws || this.manualDisconnect) {
        return;
      }
      this.handlers?.onError?.();
    };

    ws.onclose = (event) => {
      if (this.socket !== ws) {
        return;
      }
      detachSocketHandlers(ws);
      this.socket = null;
      if (this.manualDisconnect) {
        return;
      }

      const code = typeof event.code === "number" ? event.code : 1006;
      const reason = typeof event.reason === "string" ? event.reason : "";
      const terminal = isTerminalCloseCode(code);

      this.status = terminal ? "TERMINAL_CLOSED" : "DISCONNECTED";
      this.handlers?.onClose?.({ code, reason, terminal });

      if (!terminal && !this.manualDisconnect && this.url !== null) {
        const delayMs = calculateReconnectDelayMs(this.reconnectAttempt);
        this.reconnectAttempt += 1;
        this.reconnectTimer = this.clock.setTimeout(() => {
          this.reconnectTimer = null;
          this.openSocket();
        }, delayMs);
      }
    };
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.clock.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private teardownCurrentSocket(code: WsCloseCode, reason?: string): void {
    const prev = this.socket;
    if (prev === null) {
      return;
    }
    this.socket = null;
    detachSocketHandlers(prev);
    if (prev.readyState === WS_READY_STATE.CONNECTING || prev.readyState === WS_READY_STATE.OPEN) {
      prev.close(code, reason);
    }
  }
}
