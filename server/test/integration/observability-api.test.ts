import { describe, it } from "vitest";

describe("Integration: Observability HTTP & WS API (Spec 08)", () => {
  it.todo(
    "AC-01: ingests client metrics exclusively via WS 0x14 and serves accurate summary and history via /api/metrics/*",
  );
  it.todo(
    "AC-02/03: ingests telemetry via WS 0x15, serves session list, NDJSON downloads (404 when missing), and DELETE /api/telemetry/sessions",
  );
  it.todo(
    "AC-04: drops > 512 KiB telemetry frames and unauthenticated WS 0x14/0x15 frames, permits loopback REST access, and enforces Bearer auth from remote IPs",
  );
});
