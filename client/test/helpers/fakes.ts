import {
  createInitialStreamingState,
  type MediaFrame,
  type PrimarySyncMetadata,
  type StreamingEvent,
  type StreamingState,
} from "@tesroid/shared";
import type {
  CanvasElementLike,
  PlaybackControllerPort,
  PlaybackStatsSnapshot,
} from "../../src/media/ports.js";
import type { TabSessionStoragePort } from "../../src/state/index.js";
import type { RestApiClientPort } from "../../src/transport/ports.js";

const unusedAsync = (): Promise<never> => Promise.reject(new Error("not exercised by this test"));

export class NullRestClient implements RestApiClientPort {
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

export class NullPlaybackController implements PlaybackControllerPort {
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

export class NullTabSessionStorage implements TabSessionStoragePort {
  load() {
    return null;
  }
  save(_session: never): void {}
  clear(): void {}
}
