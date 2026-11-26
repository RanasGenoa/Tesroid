import type { WsTransportPort } from "../transport/ports.js";

export interface MetricsCollectorDeps {
  readonly transport: WsTransportPort;
}

export class ClientMetricsCollector {
  // Spec: docs/specs/08-observability.md#2.1
  constructor(deps: MetricsCollectorDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  start(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  stop(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  recordFrameRendered(renderDurationMs: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  recordDroppedFrames(count: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  recordDecoderError(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  recordVideoPacket(byteLength: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  recordAudioPacket(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.6
  recordRttSample(rawRttMs: number, isLiveZeroQueue: boolean): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  setAvDriftMs(driftMs: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  setDecodeQueueSize(size: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  setViewportMetrics(width: number, height: number, dpr: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.6
  getEffectiveRttMs(): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.1
  flushWindow(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
