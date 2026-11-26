import { describe, it } from "vitest";

describe("server/domains/encoder (Spec 05)", () => {
  it.todo(
    "AC-01: prioritizes NVENC -> AMD radeonsi -> Intel iHD/i965 -> WSL2 d3d12 -> libx264 in auto mode and honors fixed ENCODER_MODE=nvenc/vaapi without fallback to software",
  );
  it.todo(
    "AC-01: steps down fallback ladder on < 5,000 ms zero-frame exit with exponential backoff [1s, 2s, 4s, 8s, 10s] and resets backoff after first valid frame",
  );
  it.todo(
    "AC-02: parses Annex-B H.264 split at 1-byte boundaries or missing AUD, drops NAL 6/9, emits 4-byte SPS/PPS CONFIG (PTS=0), and packs slices into single AVCC AU",
  );
  it.todo(
    "AC-02: parses OggOpus pages, emits >= 19B OpusHead CONFIG, skips OpusTags, and emits 20ms raw Opus packets",
  );
  it.todo(
    "AC-03: applies scaling filter across VAAPI, NVENC, and Software backends and updates active dimensions atomically after encoder restart",
  );
  it.todo(
    "AC-04: keeps video process uninterrupted when only audioBitrate changes, and triggers video watchdog restart after >= 3,000 ms stall",
  );
});
