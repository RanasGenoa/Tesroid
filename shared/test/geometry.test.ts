import { describe, it } from "vitest";

describe("shared/geometry (Spec 03, 05, 06, 10)", () => {
  it.todo(
    "Spec 03 §2.1 & Spec 05 AC-02: aligns layout width to 8px (>=640), height to 2px ([360, min(1080, maxSize)]), and clamps DPR to [1.25, 1.5] when width < 1000",
  );
  it.todo(
    "Spec 05 AC-03: scales layout 966x752 with 0.65x lightweight profile to 624x488 across all encoder backends",
  );
  it.todo(
    "Spec 06 AC-02: computes object-fit: contain rect and maps client touch coordinates while excluding letterbox/pillarbox margins and top 20px guard",
  );
  it.todo("Spec 06 §4.1: safely ignores touch mapping when viewport or stream dimensions are <= 0");
  it.todo(
    "Spec 03 AC-02: calculates bitrate-linked LIVE highWaterBytes [512 KiB, 1536 KiB] and lowWaterBytes max(96 KiB, 20% of high)",
  );
  it.todo(
    "Spec 03 AC-03: adapts CATCHUP window, socket guard (32-64 KiB vs 128 KiB), and burst interval (10ms vs 2ms) when drainRate < 0.85x or stalls >= 3",
  );
  it.todo(
    "Spec 03 AC-03: calculates Buffer-Hold trigger [10s, 30s] and resume thresholds preserving >= 7,200 ms hysteresis span for HW (2s) and SW (3s) encoders",
  );
  it.todo(
    "Spec 03 AC-05: computes serverRemainingBufferMs accounting for max(clientVideoBufferedMs, clientAudioBufferedMs)",
  );
  it.todo(
    "Spec 10 AC-02/04: computes auto-sleep delay with 15,000 ms floor, holdTriggerMs + 5,000 ms margin, and null when autoSleepMinutes = 0",
  );
});
