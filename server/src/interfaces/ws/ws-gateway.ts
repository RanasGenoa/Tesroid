import type { WsCloseCode } from "@tesroid/shared";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AppContainer } from "../../app/index.js";
import type { SessionConnectionId, SessionTransportPort } from "../../domains/session/ports.js";

export class WsTransportAdapter implements SessionTransportPort {
  readonly id: SessionConnectionId;

  // Spec: docs/specs/03-streaming-transport.md#2.1
  constructor(id: SessionConnectionId, socket: WebSocket) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  sendBinary(data: Uint8Array): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.3
  getBufferedAmount(): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  close(code: WsCloseCode, reason?: string): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function registerWebSocketGateway(app: FastifyInstance, container: AppContainer): void {
  throw new Error("NOT_IMPLEMENTED");
}
