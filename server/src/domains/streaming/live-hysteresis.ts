export interface SocketDropDecision {
  readonly send: boolean;
  readonly congestionTriggered: boolean;
}

export class SocketLiveHysteresis {
  // Spec: docs/specs/03-streaming-transport.md#2.3
  constructor(initialBitrateBps: number) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.3
  evaluatePacket(
    mediaType: "video" | "audio",
    isKeyframe: boolean,
    bufferedAmountBytes: number,
  ): SocketDropDecision {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.3
  updateBitrate(videoBitrateBps: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.3
  isDroppingGop(): boolean {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/03-streaming-transport.md#2.3
  reset(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
