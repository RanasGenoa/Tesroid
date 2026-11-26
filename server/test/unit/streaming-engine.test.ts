import { describe, it } from "vitest";

describe("server/domains/streaming (Spec 03)", () => {
  it.todo(
    "AC-01: drops stale streamEpoch packets at server send queue before dispatching to sockets",
  );
  it.todo(
    "AC-02: enforces bitrate-linked LIVE hysteresis per socket independently, keeps single IDR bursts intact, isolates secondary congestion, and resumes only on <= lowWater + IDR keyframe",
  );
  it.todo(
    "AC-03: retains 60s / 48 MiB in ring buffer with separate CONFIG slots and evicts oldest complete GOP + preceding audio while protecting active GOP",
  );
  it.todo(
    "AC-03: handles 25-30s tunnel disconnect recovery lossless and switches to congested CATCHUP profile (window shrink, 32-64 KiB guard, 10ms burst) when drainRate < 0.85x or stalls >= 3",
  );
  it.todo(
    "AC-03 & AC-05: uses max(PTS delta, videoBufferedMs, audioBufferedMs) for flow control and triggers BUFFER_HOLD at triggerMs or 85% buffer usage",
  );
  it.todo(
    "AC-04 & AC-06: drives all transitions exclusively through transitionStreamingState without boolean soup and clears queues on STREAM_RESET",
  );
});
