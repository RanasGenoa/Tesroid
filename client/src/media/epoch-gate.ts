import type { MediaFrame } from "@tesroid/shared";

export interface EpochGateDecision {
  readonly accept: boolean;
  readonly epochChanged: boolean;
  readonly waitingForKeyframe: boolean;
}

export class StreamEpochGate {
  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  getActiveEpoch(): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  advanceToEpoch(newEpoch: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  evaluateVideoFrame(frame: MediaFrame): EpochGateDecision {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  evaluateAudioFrame(frame: MediaFrame): EpochGateDecision {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  isWaitingForKeyframe(): boolean {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  reset(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
