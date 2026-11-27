import { CHANNEL_ID, encodeServerControlFrame } from "@tesroid/shared";
import { describe, expect, it } from "vitest";
import { AppStore } from "../src/state/index.js";
import type {
  WsClientHandlers,
  WsConnectionStatus,
  WsTransportPort,
} from "../src/transport/ports.js";
import { NullPlaybackController, NullRestClient, NullTabSessionStorage } from "./helpers/fakes.js";

// 実サーバーの実測挙動（接続確立直後に AUTH_REQUIRED をプッシュする）を再現する fake
class ServerPushingAuthRequiredTransport implements WsTransportPort {
  readonly authFrames: string[] = [];
  private status: WsConnectionStatus = "DISCONNECTED";
  private handlers: WsClientHandlers | null = null;

  connect(_url: string, handlers: WsClientHandlers): void {
    this.handlers = handlers;
    this.status = "CONNECTING";
    queueMicrotask(() => {
      if (this.handlers !== handlers) {
        return;
      }
      this.status = "CONNECTED";
      handlers.onOpen?.();
      handlers.onBinaryMessage(
        encodeServerControlFrame({ type: "AUTH_REQUIRED", isSetupCompleted: true }),
      );
    });
  }
  sendBinary(data: Uint8Array): boolean {
    if (data[0] === CHANNEL_ID.AUTH) {
      this.authFrames.push(new TextDecoder().decode(data.subarray(1)));
    }
    return true;
  }
  disconnect(): void {
    this.status = "DISCONNECTED";
  }
  getStatus(): WsConnectionStatus {
    return this.status;
  }
  triggerControl(message: Parameters<typeof encodeServerControlFrame>[0]): void {
    this.handlers?.onBinaryMessage(encodeServerControlFrame(message));
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

function createStore(transport: WsTransportPort): AppStore {
  return new AppStore({
    rest: new NullRestClient(),
    transport,
    playback: new NullPlaybackController(),
    sessionStorage: new NullTabSessionStorage(),
    wsUrl: "ws://in-car.example/ws",
  });
}

describe("仕様 01 AC-08 認証フレームの単一送信（クライアント側）", () => {
  it("接続確立と AUTH_REQUIRED 受信が同一接続で起きても認証フレームは 1 回のみ送信する", async () => {
    const transport = new ServerPushingAuthRequiredTransport();
    const store = createStore(transport);
    try {
      void store.loginPrimaryPin("1234");
      await flushMicrotasks();

      expect(transport.authFrames).toEqual(["1234"]);
    } finally {
      store.dispose();
    }
  });

  it("AUTH_FAILED 後の明示的な PIN 再入力は新しい接続試行として送信が阻害されない", async () => {
    const transport = new ServerPushingAuthRequiredTransport();
    const store = createStore(transport);
    try {
      void store.loginPrimaryPin("1234");
      await flushMicrotasks();
      transport.triggerControl({
        type: "AUTH_FAILED",
        reason: "INVALID_PIN",
        remainingAttempts: 9,
      });

      void store.loginPrimaryPin("5678");
      await flushMicrotasks();

      expect(transport.authFrames).toEqual(["1234", "5678"]);
    } finally {
      store.dispose();
    }
  });

  it("認証フレームの送信が失敗した接続では AUTH_REQUIRED 応答で再送される", async () => {
    // ソケット輻輳等で sendBinary が false を返す経路: 送信済みフラグを立てず、再試行可能に保つ
    class FlakySendTransport extends ServerPushingAuthRequiredTransport {
      private authAttempts = 0;
      override sendBinary(data: Uint8Array): boolean {
        if (data[0] === CHANNEL_ID.AUTH) {
          this.authAttempts += 1;
          if (this.authAttempts === 1) {
            return false;
          }
        }
        return super.sendBinary(data);
      }
    }

    const transport = new FlakySendTransport();
    const store = createStore(transport);
    try {
      void store.loginPrimaryPin("1234");
      await flushMicrotasks();

      expect(transport.authFrames).toEqual(["1234"]);
    } finally {
      store.dispose();
    }
  });
});
