import { describe, it } from "vitest";

describe("client/observability (Spec 03, 08)", () => {
  it.todo(
    "Spec 08 AC-01: computes 10-second delta metrics (FPS, p50/p95 frame time, dropped frames, decoder errors, signed avDriftMs) and emits exclusively over WS 0x14",
  );
  it.todo(
    "Spec 08 AC-02: performs zero collection or console hooks when telemetryEnabled = false, batches over WS 0x15 every 1,000 ms (500 limit) when enabled, throttles sync logs (500 ms), and survives circular objects",
  );
  it.todo(
    "Spec 03 AC-05: updates EWMA RTT only during LIVE zero-queue samples and resets stale RTT (> 5,000 ms) to connecting state",
  );
});
