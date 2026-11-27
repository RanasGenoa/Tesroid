import {
  CHANNEL_ID,
  createInitialStreamingState,
  encodeServerControlFrame,
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

const unusedAsync = (): Promise<never> => Promise.reject(new Error("not exercised by AC-08"));

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

describe("仕様 01 AC-08 認証フレームの単一送信（クライアント側）", () => {
  it("接続確立と AUTH_REQUIRED 受信が同一接続で起きても認証フレームは 1 回のみ送信する", async () => {
    const transport = new ServerPushingAuthRequiredTransport();
    const store = new AppStore({
      rest: new NullRestClient(),
      transport,
      playback: new NullPlaybackController(),
      sessionStorage: new NullTabSessionStorage(),
      wsUrl: "ws://in-car.example/ws",
    });

    void store.loginPrimaryPin("1234");
    await flushMicrotasks();

    expect(transport.authFrames).toEqual(["1234"]);
  });

  it("AUTH_FAILED 後の明示的な PIN 再入力は新しい接続試行として送信が阻害されない", async () => {
    const transport = new ServerPushingAuthRequiredTransport();
    const store = new AppStore({
      rest: new NullRestClient(),
      transport,
      playback: new NullPlaybackController(),
      sessionStorage: new NullTabSessionStorage(),
      wsUrl: "ws://in-car.example/ws",
    });

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
  });
});
