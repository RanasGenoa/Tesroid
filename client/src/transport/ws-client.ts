import type { WsCloseCode } from "@tesroid/shared";
import type { WsClientHandlers, WsConnectionStatus, WsTransportPort } from "./ports.js";

export class ReconnectingWsClient implements WsTransportPort {
  // Spec: docs/specs/03-streaming-transport.md#2.1
  connect(url: string, handlers: WsClientHandlers): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  sendBinary(data: Uint8Array): boolean {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  disconnect(code?: WsCloseCode, reason?: string): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#3
  getStatus(): WsConnectionStatus {
    throw new Error("NOT_IMPLEMENTED");
  }
}
