import { describe, it } from "vitest";

describe("client/media (Spec 04)", () => {
  it.todo(
    "AC-01: renders video solely onto <canvas> (alpha: false, desynchronized: true), accepts AVCC frames without Annex-B fallback, and calls close() on 100% of rendered/dropped/reset VideoFrames and AudioData",
  );
  it.todo(
    "AC-02: drops stale streamEpoch packets before and after decode, discards deltas until first keyframe in new epoch, and recovers decoder error after 150 ms with cached SPS/PPS + stream reset",
  );
  it.todo(
    "AC-03: separates LIVE and CATCHUP (<= 48 MiB) queues, preserves audio at 1.0x gain 0.88 without underrun on <40 ms jitter, and keeps Opus re-config idempotent within same streamEpoch",
  );
  it.todo(
    "AC-04: converges |avDriftMs| <= 60 ms within 4 seconds via video-only master-clock sync after DIRECT_LIVE->LIVE, 2s burst, or 1,500 ms offset without hunting for 8+ seconds and counts sync drops",
  );
  it.todo(
    "AC-05: reports true signed avDriftMs even beyond 5,000 ms without relative fallback or zero-reset concealment",
  );
});
