import {
  calculateLiveWatermarks,
  LIVE_HYSTERESIS_BOUNDS,
  type LiveWatermarks,
} from "@tesroid/shared";

export interface SocketDropDecision {
  readonly send: boolean;
  readonly congestionTriggered: boolean;
}

export class SocketLiveHysteresis {
  private watermarks: LiveWatermarks;
  private droppingGop = false;

  // Spec: docs/specs/03-streaming-transport.md#2.3
  constructor(initialBitrateBps: number) {
    this.watermarks = calculateLiveWatermarks(initialBitrateBps);
  }

  // Spec: docs/specs/03-streaming-transport.md#2.3
  evaluatePacket(
    mediaType: "video" | "audio",
    isKeyframe: boolean,
    bufferedAmountBytes: number,
  ): SocketDropDecision {
    if (mediaType === "audio") {
      return {
        send: bufferedAmountBytes <= LIVE_HYSTERESIS_BOUNDS.audioMaxBufferedBytes,
        congestionTriggered: false,
      };
    }

    if (!this.droppingGop) {
      if (bufferedAmountBytes > this.watermarks.highWaterBytes) {
        this.droppingGop = true;
        return { send: false, congestionTriggered: true };
      }
      return { send: true, congestionTriggered: false };
    }

    if (bufferedAmountBytes <= this.watermarks.lowWaterBytes && isKeyframe) {
      this.droppingGop = false;
      return { send: true, congestionTriggered: false };
    }
    return { send: false, congestionTriggered: false };
  }

  // Spec: docs/specs/03-streaming-transport.md#2.3
  updateBitrate(videoBitrateBps: number): void {
    this.watermarks = calculateLiveWatermarks(videoBitrateBps);
  }

  // Spec: docs/specs/03-streaming-transport.md#2.3
  isDroppingGop(): boolean {
    return this.droppingGop;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.3
  reset(): void {
    this.droppingGop = false;
  }
}
