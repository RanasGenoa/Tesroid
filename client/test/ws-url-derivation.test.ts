import { describe, expect, it } from "vitest";
import { AppStore } from "../src/state/index.js";
import type {
  WsClientHandlers,
  WsConnectionStatus,
  WsTransportPort,
} from "../src/transport/ports.js";
import { NullPlaybackController, NullRestClient, NullTabSessionStorage } from "./helpers/fakes.js";

class RecordingTransport implements WsTransportPort {
  readonly connectUrls: string[] = [];
  private status: WsConnectionStatus = "DISCONNECTED";

  connect(url: string, _handlers: WsClientHandlers): void {
    this.connectUrls.push(url);
    this.status = "CONNECTING";
  }
  sendBinary(_data: Uint8Array): boolean {
    return false;
  }
  disconnect(): void {
    this.status = "DISCONNECTED";
  }
  getStatus(): WsConnectionStatus {
    return this.status;
  }
}

interface FakeLocationLike {
  readonly protocol: string;
  readonly host: string;
}

function withBrowserLocation(locationLike: FakeLocationLike, run: () => void): void {
  // 実ブラウザの location はアクセッサプロパティであり、値ディスクリプタとしての読み出しは不可
  const original = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    get: () => locationLike,
  });
  try {
    run();
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(globalThis, "location");
    } else {
      Object.defineProperty(globalThis, "location", original);
    }
  }
}

function createStoreWithoutWsUrl(transport: WsTransportPort): AppStore {
  return new AppStore({
    rest: new NullRestClient(),
    transport,
    playback: new NullPlaybackController(),
    sessionStorage: new NullTabSessionStorage(),
  });
}

describe("仕様 03 AC-07 WS URL の同一 origin 導出", () => {
  it("https ページ（アクセッサ location）では wss://<同一ホスト>/ws へ接続する", () => {
    withBrowserLocation({ protocol: "https:", host: "tesroid.example.test" }, () => {
      const transport = new RecordingTransport();
      const store = createStoreWithoutWsUrl(transport);
      try {
        void store.loginPrimaryPin("0000");
        expect(transport.connectUrls).toEqual(["wss://tesroid.example.test/ws"]);
      } finally {
        store.dispose();
      }
    });
  });

  it("http ページでは ws://<同一ホスト:ポート>/ws へ接続する", () => {
    withBrowserLocation({ protocol: "http:", host: "192.0.2.10:9001" }, () => {
      const transport = new RecordingTransport();
      const store = createStoreWithoutWsUrl(transport);
      try {
        void store.loginPrimaryPin("0000");
        expect(transport.connectUrls).toEqual(["ws://192.0.2.10:9001/ws"]);
      } finally {
        store.dispose();
      }
    });
  });
});
