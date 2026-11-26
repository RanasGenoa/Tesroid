import { describe, it } from "vitest";

describe("shared/protocol (Spec 02, 03, 08)", () => {
  it.todo(
    "Spec 03 AC-01: round-trips video and audio media frames with bit-exact 14-byte header (channel, flags, streamEpoch, Int64BE ptsUs)",
  );
  it.todo(
    "Spec 03 AC-01: round-trips 33-byte touch frames and 7-byte resize frames with exact binary layout",
  );
  it.todo(
    "Spec 03 AC-01: round-trips auth, client control, server control, and metrics frames cleanly",
  );
  it.todo(
    "Spec 03 AC-01: increments streamEpoch monotonically (with UInt32 wrap guard) and rejects stale-epoch packets via isCurrentStreamEpoch",
  );
  it.todo(
    "Spec 03 AC-01 / §4.2: throws ProtocolError for truncated frames, unknown channel IDs, and malformed control JSON",
  );
  it.todo(
    "Spec 02 §3 / AC-02: identifies terminal WS close codes (1008, 4000, 4009) and caps reconnect backoff at 30,000 ms",
  );
  it.todo("Spec 08 AC-04: rejects telemetry payloads exceeding 512 KiB with PAYLOAD_TOO_LARGE");
});
