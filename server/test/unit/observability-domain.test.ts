import { describe, it } from "vitest";

describe("server/domains/observability (Spec 08)", () => {
  it.todo(
    "AC-01: aggregates 10s window deltas across 360-entry ring buffer without double-counting drops/errors and preserves signed A/V drift > 5,000 ms",
  );
  it.todo(
    "AC-02: performs zero disk I/O when telemetryEnabled = false and creates session JSONL lazily on first valid event across all 7 categories",
  );
  it.todo(
    "AC-03: enforces 10 MiB per-session file cap (restored across restart) and rotates oldest session beyond 15 files",
  );
  it.todo("AC-04: sanitizes sessionId against path traversal and caps batches at 500 events");
});
