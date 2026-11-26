import {
  AUDIO_FLAG,
  CHANNEL_ID,
  type ClientControlMessage,
  type ClientMetricsSample,
  calculateReconnectDelayMs,
  DEFAULT_APP_SETTINGS,
  decodeAuthFrame,
  decodeClientControlFrame,
  decodeMediaFrame,
  decodeMetricsFrame,
  decodeResizeFrame,
  decodeServerControlFrame,
  decodeTelemetryFrame,
  decodeTouchFrame,
  encodeAuthFrame,
  encodeClientControlFrame,
  encodeMediaFrame,
  encodeMetricsFrame,
  encodeResizeFrame,
  encodeServerControlFrame,
  encodeTelemetryFrame,
  encodeTouchFrame,
  FRAME_SIZE,
  isCurrentStreamEpoch,
  isTerminalCloseCode,
  MAX_UINT32,
  nextStreamEpoch,
  ProtocolError,
  type ServerControlMessage,
  STREAM_EPOCH_INITIAL,
  TOUCH_ACTION,
  toPublicSettings,
  VIDEO_FLAG,
  WS_CLOSE_CODE,
} from "@tesroid/shared";
import { describe, expect, it } from "vitest";

function expectProtocolError(fn: () => unknown, code: ProtocolError["code"]): void {
  try {
    fn();
    expect.unreachable(`Expected ProtocolError(${code}) to be thrown`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
  }
}

describe("shared/protocol (Spec 02, 03, 08)", () => {
  it("Spec 03 AC-01: round-trips video and audio media frames with bit-exact 14-byte header (channel, flags, streamEpoch, Int64BE ptsUs)", () => {
    const videoPayload = new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x65, 0x88]);
    const videoEncoded = encodeMediaFrame({
      channel: CHANNEL_ID.VIDEO,
      flags: VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC,
      streamEpoch: 42,
      ptsUs: 123_456_789_012n,
      payload: videoPayload,
    });

    expect(videoEncoded.byteLength).toBe(FRAME_SIZE.MEDIA_HEADER_BYTES + videoPayload.byteLength);
    expect(videoEncoded[0]).toBe(CHANNEL_ID.VIDEO);
    expect(videoEncoded[1]).toBe(VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC);

    const view = new DataView(
      videoEncoded.buffer,
      videoEncoded.byteOffset,
      videoEncoded.byteLength,
    );
    expect(view.getUint32(2, false)).toBe(42);
    expect(view.getBigInt64(6, false)).toBe(123_456_789_012n);

    // Verify non-zero byteOffset slice handling
    const backing = new Uint8Array(videoEncoded.byteLength + 5);
    backing.set(videoEncoded, 3);
    const sliced = backing.subarray(3, 3 + videoEncoded.byteLength);
    const decodedVideo = decodeMediaFrame(sliced);
    expect(decodedVideo.channel).toBe(CHANNEL_ID.VIDEO);
    expect(decodedVideo.flags).toBe(VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC);
    expect(decodedVideo.streamEpoch).toBe(42);
    expect(decodedVideo.ptsUs).toBe(123_456_789_012n);
    expect(decodedVideo.payload).toEqual(videoPayload);

    const audioPayload = new Uint8Array([0xfc, 0xff, 0xfe]);
    const audioEncoded = encodeMediaFrame({
      channel: CHANNEL_ID.AUDIO,
      flags: AUDIO_FLAG.CONFIG,
      streamEpoch: MAX_UINT32,
      ptsUs: -500n,
      payload: audioPayload,
    });
    const decodedAudio = decodeMediaFrame(audioEncoded);
    expect(decodedAudio.channel).toBe(CHANNEL_ID.AUDIO);
    expect(decodedAudio.flags).toBe(AUDIO_FLAG.CONFIG);
    expect(decodedAudio.streamEpoch).toBe(MAX_UINT32);
    expect(decodedAudio.ptsUs).toBe(-500n);
    expect(decodedAudio.payload).toEqual(audioPayload);
  });

  it("Spec 03 AC-01: round-trips 33-byte touch frames and 7-byte resize frames with exact binary layout", () => {
    const touchFrame = {
      action: TOUCH_ACTION.POINTER_DOWN,
      pointerId: 9_007_199_254_740_993n,
      x: -12,
      y: 740,
      screenWidth: 1280,
      screenHeight: 720,
      pressure: 512,
      actionButton: 1,
      buttons: 3,
    } as const;

    const encodedTouch = encodeTouchFrame(touchFrame);
    expect(encodedTouch.byteLength).toBe(FRAME_SIZE.TOUCH_BYTES);
    expect(encodedTouch[0]).toBe(CHANNEL_ID.TOUCH);
    expect(encodedTouch[1]).toBe(2);
    expect(encodedTouch[2]).toBe(TOUCH_ACTION.POINTER_DOWN);
    expect(decodeTouchFrame(encodedTouch)).toEqual(touchFrame);

    const resizeFrame = { width: 1184, height: 846, dprX100: 153 } as const;
    const encodedResize = encodeResizeFrame(resizeFrame);
    expect(encodedResize.byteLength).toBe(FRAME_SIZE.RESIZE_BYTES);
    expect(encodedResize[0]).toBe(CHANNEL_ID.RESIZE);
    expect(decodeResizeFrame(encodedResize)).toEqual(resizeFrame);
  });

  it("Spec 03 AC-01: round-trips auth, client control, server control, and metrics frames cleanly", () => {
    for (const auth of [
      { kind: "PRIMARY_PIN", pin: "1234" },
      { kind: "SECONDARY_PIN", pin: "5678" },
      { kind: "TOKEN", token: "abcdef0123456789" },
    ] as const) {
      expect(decodeAuthFrame(encodeAuthFrame(auth))).toEqual(auth);
    }

    const clientMessages: readonly ClientControlMessage[] = [
      { type: "PING", clientTimestampMs: 1_700_000_000_000 },
      {
        type: "PLAYBACK_FEEDBACK",
        streamEpoch: 3,
        renderedPtsUs: 4_500_000,
        videoBufferedMs: 120,
        audioBufferedMs: 80,
      },
      { type: "SET_ZOOM", scale: 110 },
      { type: "NAVIGATE", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
      { type: "INPUT_TEXT", text: "Tesroid テスト" },
      { type: "INPUT_KEY", key: "Enter" },
      { type: "PAUSE_BROWSER" },
      { type: "DISCONNECT" },
    ];
    for (const msg of clientMessages) {
      expect(decodeClientControlFrame(encodeClientControlFrame(msg))).toEqual(msg);
    }

    const serverMessages: readonly ServerControlMessage[] = [
      { type: "AUTH_REQUIRED", isSetupCompleted: true },
      {
        type: "AUTH_OK",
        role: "PRIMARY",
        token: "0".repeat(64),
        streamEpoch: 2,
        settings: toPublicSettings(DEFAULT_APP_SETTINGS),
        powerState: "ACTIVE",
      },
      {
        type: "PONG",
        clientTimestampMs: 100,
        serverTimestampMs: 105,
        latestMediaPtsUs: 5_000_000,
        mode: "LIVE",
        serverRemainingBufferMs: 420,
        primaryRenderedPts: 4_900_000,
        primaryFeedbackAgeMs: 40,
        primaryTargetBufferMs: 10_000,
        primaryMode: "LIVE",
      },
      {
        type: "STREAM_STATE",
        state: {
          kind: "CATCHUP",
          streamEpoch: 2,
          targetBufferMs: 10_000,
          resumePtsUs: 1_234_567,
        },
      },
      {
        type: "STREAM_STATE",
        state: {
          kind: "BUFFER_HOLD",
          streamEpoch: 2,
          holdSinceMs: 1_234_567,
        },
      },
      {
        type: "BUFFER_HOLD",
        active: true,
        streamEpoch: 2,
      },
      {
        type: "SERVER_STATS",
        stats: {
          timestamp: 1_700_000_000_000,
          encodeFps: 30,
          sendBitrateKbps: 980,
          audioPps: 50,
          powerState: "ACTIVE",
        },
      },
    ];
    for (const msg of serverMessages) {
      expect(decodeServerControlFrame(encodeServerControlFrame(msg))).toEqual(msg);
    }

    const metrics: ClientMetricsSample = {
      timestamp: 1_700_000_000_000,
      windowMs: 10_000,
      fps: 29.8,
      minFps: 27,
      maxFps: 30,
      droppedFrames: 1,
      decoderErrors: 0,
      totalRenderedFrames: 300,
      videoPackets: 300,
      videoBytes: 1_250_000,
      audioPackets: 500,
      bitrateKbps: 1_000,
      frameTimeP50Ms: 2.1,
      frameTimeP95Ms: 4.5,
      decodeQueueSize: 1,
      rttMs: 28,
      avDriftMs: -12,
      displayWidth: 773,
      displayHeight: 553,
      dpr: 1.53,
    };
    expect(decodeMetricsFrame(encodeMetricsFrame(metrics))).toEqual(metrics);
  });

  it("Spec 03 AC-01: increments streamEpoch monotonically (with UInt32 wrap guard) and rejects stale-epoch packets via isCurrentStreamEpoch", () => {
    expect(nextStreamEpoch(STREAM_EPOCH_INITIAL)).toBe(2);
    expect(nextStreamEpoch(99)).toBe(100);
    expect(nextStreamEpoch(MAX_UINT32)).toBe(STREAM_EPOCH_INITIAL);
    expect(nextStreamEpoch(0)).toBe(STREAM_EPOCH_INITIAL);
    expect(nextStreamEpoch(-1)).toBe(STREAM_EPOCH_INITIAL);

    expect(isCurrentStreamEpoch(5, 5)).toBe(true);
    expect(isCurrentStreamEpoch(4, 5)).toBe(false);
    expect(isCurrentStreamEpoch(6, 5)).toBe(false);
    expect(isCurrentStreamEpoch(0, 0)).toBe(false);
  });

  it("Spec 03 AC-01 / §4.2: throws ProtocolError for truncated frames, unknown channel IDs, and malformed control JSON", () => {
    expectProtocolError(() => decodeMediaFrame(new Uint8Array([])), "FRAME_TOO_SHORT");
    expectProtocolError(
      () => decodeMediaFrame(new Uint8Array([CHANNEL_ID.VIDEO, 0, 0, 0, 1])),
      "FRAME_TOO_SHORT",
    );
    expectProtocolError(() => decodeMediaFrame(new Uint8Array(14).fill(0x99)), "UNKNOWN_CHANNEL");

    expectProtocolError(
      () => decodeTouchFrame(new Uint8Array([CHANNEL_ID.TOUCH, 2])),
      "FRAME_TOO_SHORT",
    );
    expectProtocolError(() => decodeTouchFrame(new Uint8Array(33).fill(0xff)), "UNKNOWN_CHANNEL");
    expectProtocolError(
      () => decodeResizeFrame(new Uint8Array([CHANNEL_ID.RESIZE, 1, 2])),
      "FRAME_TOO_SHORT",
    );

    const encoder = new TextEncoder();
    const badJsonFrame = new Uint8Array([
      CHANNEL_ID.CONTROL_COMMAND,
      ...encoder.encode("{not-json"),
    ]);
    expectProtocolError(() => decodeClientControlFrame(badJsonFrame), "INVALID_CONTROL_JSON");

    const unknownTypeFrame = new Uint8Array([
      CHANNEL_ID.CONTROL_COMMAND,
      ...encoder.encode('{"type":"UNKNOWN_CMD"}'),
    ]);
    expectProtocolError(() => decodeClientControlFrame(unknownTypeFrame), "INVALID_CONTROL_JSON");

    const wrongChannel = new Uint8Array([CHANNEL_ID.CONTROL_RESPONSE, ...encoder.encode("{}")]);
    expectProtocolError(() => decodeClientControlFrame(wrongChannel), "UNKNOWN_CHANNEL");
  });

  it("Spec 02 §3 / AC-02: identifies terminal WS close codes (1008, 4000, 4009) and caps reconnect backoff at 30,000 ms", () => {
    expect(isTerminalCloseCode(WS_CLOSE_CODE.POLICY_VIOLATION)).toBe(true);
    expect(isTerminalCloseCode(WS_CLOSE_CODE.SESSION_SUPERSEDED)).toBe(true);
    expect(isTerminalCloseCode(WS_CLOSE_CODE.SESSION_CONFLICT)).toBe(true);
    expect(isTerminalCloseCode(WS_CLOSE_CODE.NORMAL)).toBe(false);
    expect(isTerminalCloseCode(WS_CLOSE_CODE.GOING_AWAY)).toBe(false);
    expect(isTerminalCloseCode(1006)).toBe(false);

    expect(calculateReconnectDelayMs(0)).toBe(1_000);
    expect(calculateReconnectDelayMs(1)).toBe(2_000);
    expect(calculateReconnectDelayMs(2)).toBe(4_000);
    expect(calculateReconnectDelayMs(4)).toBe(16_000);
    expect(calculateReconnectDelayMs(5)).toBe(30_000);
    expect(calculateReconnectDelayMs(20)).toBe(30_000);
    expect(calculateReconnectDelayMs(-3)).toBe(1_000);
  });

  it("Spec 08 AC-04: rejects telemetry payloads exceeding 512 KiB with PAYLOAD_TOO_LARGE", () => {
    const validBatch = {
      events: [{ category: "network", event: "rtt_spike", timestamp: 1_000, data: { rtt: 120 } }],
    } as const;
    expect(decodeTelemetryFrame(encodeTelemetryFrame(validBatch))).toEqual(validBatch);

    const oversizedBatch = {
      events: [
        {
          category: "log",
          event: "oversized",
          data: { blob: "x".repeat(FRAME_SIZE.MAX_TELEMETRY_BYTES + 64) },
        },
      ],
    } as const;
    expectProtocolError(() => encodeTelemetryFrame(oversizedBatch), "PAYLOAD_TOO_LARGE");

    const rawOversized = new Uint8Array(FRAME_SIZE.MAX_TELEMETRY_BYTES + 1);
    rawOversized[0] = CHANNEL_ID.TELEMETRY;
    expectProtocolError(() => decodeTelemetryFrame(rawOversized), "PAYLOAD_TOO_LARGE");
  });
});
