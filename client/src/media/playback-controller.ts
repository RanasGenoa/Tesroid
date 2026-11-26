import type {
  MediaFrame,
  PrimarySyncMetadata,
  StreamingEvent,
  StreamingState,
} from "@tesroid/shared";
import type { WsTransportPort } from "../transport/ports.js";
import type { PlaybackControllerPort, PlaybackStatsSnapshot } from "./ports.js";

export interface PlaybackControllerDeps {
  readonly transport: WsTransportPort;
  readonly onRequestStreamReset: () => void;
}

export class PlaybackController implements PlaybackControllerPort {
  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  constructor(deps: PlaybackControllerDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  attachCanvas(canvas: HTMLCanvasElement): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  getStreamingState(): StreamingState {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  dispatchStreamingEvent(event: StreamingEvent): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  handleMediaFrame(frame: MediaFrame): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.4
  updatePrimarySyncRef(metadata: PrimarySyncMetadata): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  setTargetFps(fps: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  setTargetBufferMs(targetBufferMs: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#3
  setAudioEnabled(enabled: boolean): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  unlockAudioOnGesture(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  resetForNewEpoch(newStreamEpoch: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  getStatsSnapshot(): PlaybackStatsSnapshot {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#3
  dispose(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
