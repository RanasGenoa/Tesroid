import {
  createInitialStreamingState,
  type MediaFrame,
  type PrimarySyncMetadata,
  type StreamingEvent,
  type StreamingState,
} from "@tesroid/shared";
import { describe, expect, it } from "vitest";
import type {
  CanvasElementLike,
  PlaybackControllerPort,
  PlaybackStatsSnapshot,
} from "../src/media/ports.js";
import { AppStore, type TabSessionStoragePort } from "../src/state/index.js";
import type {
  RestApiClientPort,
  WsClientHandlers,
  WsConnectionStatus,
  WsTransportPort,
} from "../src/transport/ports.js";

const unusedAsync = (): Promise<never> => Promise.reject(new Error("not exercised by AC-07"));

class NullRestClient implements RestApiClientPort {
  setToken(_token: string | null): void {}
  getStatus(): Promise<never> {
    return unusedAsync();
  }
  getHealth(): Promise<never> {
    return unusedAsync();
  }
  completeSetup(): Promise<never> {
    return unusedAsync();
  }
  verifyPin(): Promise<never> {
    return unusedAsync();
  }
  getSettings(): Promise<never> {
    return unusedAsync();
  }
  updateSettings(): Promise<never> {
    return unusedAsync();
  }
  getPowerStatus(): Promise<never> {
    return unusedAsync();
  }
  sleepPower(): Promise<never> {
    return unusedAsync();
  }
  resumePower(): Promise<never> {
    return unusedAsync();
  }
  restartBrowser(): Promise<never> {
    return unusedAsync();
  }
  resetStream(): Promise<never> {
    return unusedAsync();
  }
  getMetricsSummary(): Promise<never> {
    return unusedAsync();
  }
  getMetricsHistory(): Promise<never> {
    return unusedAsync();
  }
  listTelemetrySessions(): Promise<never> {
    return unusedAsync();
  }
  deleteTelemetrySessions(): Promise<never> {
    return unusedAsync();
  }
}

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

class NullPlaybackController implements PlaybackControllerPort {
  private streamingState: StreamingState = createInitialStreamingState();

  attachCanvas(_canvas: CanvasElementLike): void {}
  getStreamingState(): StreamingState {
    return this.streamingState;
  }
  dispatchStreamingEvent(_event: StreamingEvent): void {}
  handleMediaFrame(_frame: MediaFrame): void {}
  updatePrimarySyncRef(_metadata: PrimarySyncMetadata): void {}
  setTargetFps(_fps: number): void {}
  setTargetBufferMs(_targetBufferMs: number): void {}
  setPrimaryAuthority(_isPrimary: boolean): void {}
  setAudioEnabled(_enabled: boolean): void {}
  async unlockAudioOnGesture(): Promise<void> {}
  resetForNewEpoch(newStreamEpoch: number): void {
    this.streamingState = { ...this.streamingState, streamEpoch: newStreamEpoch };
  }
  getStatsSnapshot(): PlaybackStatsSnapshot {
    return {
      renderedFps: 0,
      isStaticScreen: false,
      localVideoBufferedMs: 0,
      localAudioBufferedMs: 0,
      avDriftMs: 0,
      decodeQueueSize: 0,
      droppedFramesDelta: 0,
      decoderErrorsDelta: 0,
      frameRenderTimeMs: null,
      waitingForKeyframe: false,
    };
  }
  dispose(): void {}
}

class NullTabSessionStorage implements TabSessionStoragePort {
  load() {
    return null;
  }
  save(_session: never): void {}
  clear(): void {}
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
      void store.loginPrimaryPin("0000");
      expect(transport.connectUrls).toEqual(["wss://tesroid.example.test/ws"]);
    });
  });

  it("http ページでは ws://<同一ホスト:ポート>/ws へ接続する", () => {
    withBrowserLocation({ protocol: "http:", host: "192.0.2.10:9001" }, () => {
      const transport = new RecordingTransport();
      const store = createStoreWithoutWsUrl(transport);
      void store.loginPrimaryPin("0000");
      expect(transport.connectUrls).toEqual(["ws://192.0.2.10:9001/ws"]);
    });
  });
});
