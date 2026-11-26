import fastifyWebsocket from "@fastify/websocket";
import type { WsCloseCode } from "@tesroid/shared";
import type { FastifyInstance } from "fastify";
import { type RawData, WebSocket } from "ws";
import type { AppContainer } from "../../app/index.js";
import type { SessionConnectionId, SessionTransportPort } from "../../domains/session/ports.js";

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  const merged = Buffer.concat(data);
  return new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
}

export class WsTransportAdapter implements SessionTransportPort {
  readonly id: SessionConnectionId;
  private readonly socket: WebSocket;

  // Spec: docs/specs/03-streaming-transport.md#2.1
  constructor(id: SessionConnectionId, socket: WebSocket) {
    this.id = id;
    this.socket = socket;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  sendBinary(data: Uint8Array): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(data, { binary: true });
    }
  }

  // Spec: docs/specs/03-streaming-transport.md#2.3
  getBufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  close(code: WsCloseCode, reason?: string): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(code, reason);
    }
  }
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function registerWebSocketGateway(app: FastifyInstance, container: AppContainer): void {
  let nextConnectionSeq = 1;

  void app.register(fastifyWebsocket);
  void app.register(async (wsApp) => {
    wsApp.get("/ws", { websocket: true }, (socket, request) => {
      request.raw.socket?.setNoDelay?.(true);
      const connectionId = `ws-${nextConnectionSeq++}`;
      const transport = new WsTransportAdapter(connectionId, socket);
      container.coordinator.handleWsOpen(transport);

      let messageChain = Promise.resolve();
      socket.on("message", (raw) => {
        const payload = toUint8Array(raw);
        messageChain = messageChain.then(() =>
          container.coordinator.handleWsBinaryMessage(connectionId, payload),
        );
      });

      socket.on("close", (code) => {
        messageChain = messageChain.then(() => {
          container.coordinator.handleWsClose(connectionId, code);
        });
      });

      socket.on("error", () => {
        // Transport errors are cleaned up on the subsequent close event.
      });
    });
  });
}
