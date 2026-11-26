import type { Clock } from "../../infra/index.js";
import type { BufferedMediaEntry } from "./ports.js";

export interface CatchupDrainSample {
  readonly renderedPtsUs: number;
  readonly nowMs: number;
}

export interface CatchupPacerDeps {
  readonly clock: Clock;
}

export class CatchupPacer {
  // Spec: docs/specs/03-streaming-transport.md#2.4
  constructor(deps: CatchupPacerDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  start(
    initialEntries: readonly BufferedMediaEntry[],
    targetBufferMs: number,
    onEmit: (entry: BufferedMediaEntry) => boolean,
    onDrained: () => void,
  ): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  enqueue(entry: BufferedMediaEntry): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  recordProgress(sample: CatchupDrainSample): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  recordSocketStall(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  flush(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  isDrained(): boolean {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  getQueueSize(): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  getDrainRate(): number {
    throw new Error("NOT_IMPLEMENTED");
  }
}
