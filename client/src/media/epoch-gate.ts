import {
  CHANNEL_ID,
  MAX_UINT32,
  type MediaFrame,
  STREAM_EPOCH_INITIAL,
  VIDEO_FLAG,
} from "@tesroid/shared";

export interface EpochGateDecision {
  readonly accept: boolean;
  readonly epochChanged: boolean;
  readonly waitingForKeyframe: boolean;
}

function isValidStreamEpoch(epoch: number): boolean {
  return Number.isInteger(epoch) && epoch >= STREAM_EPOCH_INITIAL && epoch <= MAX_UINT32;
}

export class StreamEpochGate {
  private activeEpoch: number = STREAM_EPOCH_INITIAL;
  private waitingForKeyframe = true;

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  getActiveEpoch(): number {
    return this.activeEpoch;
  }

  // Spec: docs/specs/03-streaming-transport.md#2.1
  advanceToEpoch(newEpoch: number): void {
    if (!isValidStreamEpoch(newEpoch) || newEpoch < this.activeEpoch) {
      return;
    }
    this.activeEpoch = newEpoch;
    this.waitingForKeyframe = true;
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  evaluateVideoFrame(frame: MediaFrame): EpochGateDecision {
    if (
      frame.channel !== CHANNEL_ID.VIDEO ||
      !isValidStreamEpoch(frame.streamEpoch) ||
      frame.streamEpoch < this.activeEpoch
    ) {
      return {
        accept: false,
        epochChanged: false,
        waitingForKeyframe: this.waitingForKeyframe,
      };
    }

    let epochChanged = false;
    if (frame.streamEpoch > this.activeEpoch) {
      this.activeEpoch = frame.streamEpoch;
      this.waitingForKeyframe = true;
      epochChanged = true;
    }

    if ((frame.flags & VIDEO_FLAG.CONFIG) !== 0) {
      return {
        accept: true,
        epochChanged,
        waitingForKeyframe: this.waitingForKeyframe,
      };
    }

    // Single AVCC contract: frames without AVCC flag are rejected with no Annex-B fallback.
    if ((frame.flags & VIDEO_FLAG.AVCC) === 0) {
      return {
        accept: false,
        epochChanged,
        waitingForKeyframe: this.waitingForKeyframe,
      };
    }

    const isKeyframe = (frame.flags & VIDEO_FLAG.KEYFRAME) !== 0;
    if (this.waitingForKeyframe) {
      if (!isKeyframe) {
        return {
          accept: false,
          epochChanged,
          waitingForKeyframe: true,
        };
      }
      this.waitingForKeyframe = false;
    }

    return {
      accept: true,
      epochChanged,
      waitingForKeyframe: false,
    };
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  evaluateAudioFrame(frame: MediaFrame): EpochGateDecision {
    if (
      frame.channel !== CHANNEL_ID.AUDIO ||
      !isValidStreamEpoch(frame.streamEpoch) ||
      frame.streamEpoch < this.activeEpoch
    ) {
      return {
        accept: false,
        epochChanged: false,
        waitingForKeyframe: this.waitingForKeyframe,
      };
    }

    let epochChanged = false;
    if (frame.streamEpoch > this.activeEpoch) {
      this.activeEpoch = frame.streamEpoch;
      this.waitingForKeyframe = true;
      epochChanged = true;
    }

    return {
      accept: true,
      epochChanged,
      waitingForKeyframe: this.waitingForKeyframe,
    };
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  isWaitingForKeyframe(): boolean {
    return this.waitingForKeyframe;
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  reset(): void {
    this.waitingForKeyframe = true;
  }
}
