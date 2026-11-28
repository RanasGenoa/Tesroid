import {
  AUDIO_FLAG,
  CATCHUP_FLOW_CONSTANTS,
  CHANNEL_ID,
  decodeMediaFrame,
  decodeServerControlFrame,
  nextStreamEpoch,
  type ServerControlMessage,
  STREAM_EPOCH_INITIAL,
  VIDEO_FLAG,
} from "@tesroid/shared";
import { describe, expect, it } from "vitest";
import {
  AuthService,
  CryptoTokenGenerator,
  LockoutManager,
  SessionTokenStore,
} from "../../src/domains/auth/index.js";
import type { PasswordHasher } from "../../src/domains/auth/ports.js";
import { SessionRegistry, SessionService } from "../../src/domains/session/index.js";
import { SettingsService } from "../../src/domains/settings/index.js";
import {
  CatchupPacer,
  MediaRingBuffer,
  SocketLiveHysteresis,
  StreamingController,
} from "../../src/domains/streaming/index.js";
import {
  FakeAtomicJsonStore,
  FakeClock,
  FakeProcessExit,
  FakeSessionTransport,
} from "../helpers/fakes.js";

const fastHasher: PasswordHasher = {
  hash: async (pin) => `plain:${pin}`,
  verify: async (pin, hash) => hash === `plain:${pin}`,
};

function decodeControls(transport: FakeSessionTransport): ServerControlMessage[] {
  const results: ServerControlMessage[] = [];
  for (const frame of transport.sentFrames) {
    if (frame[0] === CHANNEL_ID.CONTROL_RESPONSE) {
      results.push(decodeServerControlFrame(frame));
    }
  }
  return results;
}

function decodeMediaFrames(transport: FakeSessionTransport) {
  return transport.sentFrames
    .filter((f) => f[0] === CHANNEL_ID.VIDEO || f[0] === CHANNEL_ID.AUDIO)
    .map((f) => decodeMediaFrame(f));
}

async function createStreamingHarness(options?: {
  videoBitrate?: number;
  targetBufferMs?: number;
  maxSeconds?: number;
  maxBytes?: number;
  idleToBufferSeconds?: number;
  asyncResetGate?: () => Promise<void>;
}) {
  const clock = new FakeClock(1_700_000_000_000);
  const store = new FakeAtomicJsonStore();
  const settings = new SettingsService({ store, filePath: "/data/settings.json" });
  await settings.load();
  await settings.completeSetup({
    pinHash: "plain:1234",
    timezone: "Asia/Tokyo",
  });
  if (options?.videoBitrate !== undefined || options?.targetBufferMs !== undefined) {
    await settings.updateSettings(
      {
        stream: {
          videoBitrate: options.videoBitrate,
          targetBufferMs: options.targetBufferMs,
        },
      },
      { backend: "vaapi" },
    );
  }

  const tokenStore = new SessionTokenStore({ clock, tokenGenerator: new CryptoTokenGenerator() });
  const lockout = new LockoutManager({
    clock,
    store,
    filePath: "/data/lockout.json",
    processExit: new FakeProcessExit(),
  });
  const auth = new AuthService({
    clock,
    settings,
    passwordHasher: fastHasher,
    tokenStore,
    lockout,
    shutdownHandler: { onLockoutTriggered: async () => {} },
  });

  let currentEpoch = STREAM_EPOCH_INITIAL;
  let sessionServiceRef: SessionService | undefined;
  const registry = new SessionRegistry({
    clock,
    onGraceExpired: () => {
      sessionServiceRef?.handleReloadGraceExpired();
    },
  });
  const session = new SessionService({
    clock,
    auth,
    settings,
    registry,
    callbacks: { getStreamEpoch: () => currentEpoch },
  });
  sessionServiceRef = session;

  const ringBuffer = new MediaRingBuffer({
    maxSeconds: options?.maxSeconds ?? CATCHUP_FLOW_CONSTANTS.ringBufferMaxSeconds,
    maxBytes: options?.maxBytes ?? CATCHUP_FLOW_CONSTANTS.ringBufferMaxBytes,
  });
  const catchupPacer = new CatchupPacer({ clock });

  const lifecycleEvents: string[] = [];
  let inFlightInteractiveReset: Promise<void> | null = null;
  let interactiveResetCalls = 0;
  let controllerRef: StreamingController | undefined;

  const controller = new StreamingController({
    clock,
    settings,
    session,
    ringBuffer,
    catchupPacer,
    idleToBufferSeconds: options?.idleToBufferSeconds,
    lifecycle: {
      requestBufferHold: async () => {
        lifecycleEvents.push("HOLD");
        controllerRef?.onPowerHoldEntered(clock.nowMs());
      },
      requestExitBufferHold: async (reason, atMs) => {
        lifecycleEvents.push(`EXIT_HOLD:${reason}`);
        currentEpoch = nextStreamEpoch(currentEpoch);
        controllerRef?.clearBufferAndQueues();
        controllerRef?.onPowerHoldExited(currentEpoch, reason, atMs);
      },
      requestInteractiveEpochReset: async (atMs) => {
        if (inFlightInteractiveReset !== null) {
          return inFlightInteractiveReset;
        }
        interactiveResetCalls += 1;
        const run = (async () => {
          if (options?.asyncResetGate !== undefined) {
            await options.asyncResetGate();
          }
          currentEpoch = nextStreamEpoch(currentEpoch);
          controllerRef?.clearBufferAndQueues();
          controllerRef?.completeInteractiveEpochReset(atMs, currentEpoch);
        })().finally(() => {
          inFlightInteractiveReset = null;
        });
        inFlightInteractiveReset = run;
        return run;
      },
    },
  });
  controllerRef = controller;

  const connectPrimary = async (id = "p-1") => {
    const transport = new FakeSessionTransport(id);
    const outcome = await session.authenticatePrimaryPin(transport, "1234");
    if (!outcome.ok) {
      throw new Error(`Expected primary auth success, got ${outcome.reason}`);
    }
    controller.handleSessionActivated(id, currentEpoch, null);
    return { transport, outcome };
  };

  const connectSecondary = async (id = "s-1") => {
    const transport = new FakeSessionTransport(id);
    const outcome = await session.authenticateSecondaryPin(transport, "1234");
    if (!outcome.ok) {
      throw new Error(`Expected secondary auth success, got ${outcome.reason}`);
    }
    controller.handleSessionActivated(id, currentEpoch, null);
    return { transport, outcome };
  };

  return {
    clock,
    settings,
    session,
    ringBuffer,
    catchupPacer,
    controller,
    lifecycleEvents,
    getInteractiveResetCalls: () => interactiveResetCalls,
    getEpoch: () => currentEpoch,
    setEpoch: (epoch: number) => {
      currentEpoch = epoch;
    },
    connectPrimary,
    connectSecondary,
  };
}

describe("server/domains/streaming (Spec 03)", () => {
  it("AC-01: drops stale streamEpoch packets at server send queue before dispatching to sockets", async () => {
    const harness = await createStreamingHarness();
    const { transport: primary } = await harness.connectPrimary();

    harness.controller.handleStreamReset(2);
    harness.setEpoch(2);
    primary.sentFrames.length = 0;

    harness.controller.ingestEncodedPacket({
      mediaType: "video",
      flags: VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC,
      streamEpoch: 1,
      ptsUs: 100_000n,
      payload: new Uint8Array([0x01, 0x02]),
    });
    harness.controller.ingestEncodedPacket({
      mediaType: "audio",
      flags: AUDIO_FLAG.KEYFRAME,
      streamEpoch: 1,
      ptsUs: 120_000n,
      payload: new Uint8Array([0x03]),
    });
    expect(decodeMediaFrames(primary)).toHaveLength(0);
    expect(harness.ringBuffer.getStats().entryCount).toBe(0);

    harness.controller.ingestEncodedPacket({
      mediaType: "video",
      flags: VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC,
      streamEpoch: 2,
      ptsUs: 200_000n,
      payload: new Uint8Array([0x04, 0x05]),
    });
    const delivered = decodeMediaFrames(primary);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.streamEpoch).toBe(2);
    expect(delivered[0]?.ptsUs).toBe(200_000n);
    harness.controller.dispose();
  });

  it("AC-02: enforces bitrate-linked LIVE hysteresis per socket independently, keeps single IDR bursts intact, isolates secondary congestion, and resumes only on <= lowWater + IDR keyframe", async () => {
    const hysteresis = new SocketLiveHysteresis(2_000_000);
    expect(hysteresis.evaluatePacket("video", true, 750_000)).toEqual({
      send: true,
      congestionTriggered: false,
    });
    expect(hysteresis.isDroppingGop()).toBe(false);

    expect(hysteresis.evaluatePacket("video", false, 750_001)).toEqual({
      send: false,
      congestionTriggered: true,
    });
    expect(hysteresis.evaluatePacket("video", true, 200_000)).toEqual({
      send: false,
      congestionTriggered: false,
    });
    expect(hysteresis.evaluatePacket("video", false, 150_000)).toEqual({
      send: false,
      congestionTriggered: false,
    });
    expect(hysteresis.evaluatePacket("video", true, 150_000)).toEqual({
      send: true,
      congestionTriggered: false,
    });
    expect(hysteresis.evaluatePacket("audio", true, 2 * 1024 * 1024)).toEqual({
      send: true,
      congestionTriggered: false,
    });
    expect(hysteresis.evaluatePacket("audio", true, 2 * 1024 * 1024 + 1)).toEqual({
      send: false,
      congestionTriggered: false,
    });

    const harness = await createStreamingHarness({ videoBitrate: 2_000_000 });
    const { transport: primary } = await harness.connectPrimary();
    const { transport: secondary } = await harness.connectSecondary();
    primary.sentFrames.length = 0;
    secondary.sentFrames.length = 0;

    secondary.setBufferedAmount(900_000);
    primary.setBufferedAmount(0);

    harness.controller.ingestEncodedPacket({
      mediaType: "video",
      flags: VIDEO_FLAG.AVCC,
      streamEpoch: 1,
      ptsUs: 500_000n,
      payload: new Uint8Array([1, 2]),
    });
    harness.controller.ingestEncodedPacket({
      mediaType: "audio",
      flags: AUDIO_FLAG.KEYFRAME,
      streamEpoch: 1,
      ptsUs: 520_000n,
      payload: new Uint8Array([3, 4]),
    });

    expect(decodeMediaFrames(primary)).toHaveLength(2);
    expect(decodeMediaFrames(secondary)).toHaveLength(0);
    expect(harness.controller.getState().kind).toBe("LIVE");

    await harness.settings.updateSettings(
      { stream: { videoBitrate: 500_000 } },
      { backend: "vaapi" },
    );
    primary.sentFrames.length = 0;
    primary.setBufferedAmount(600_000);
    harness.controller.ingestEncodedPacket({
      mediaType: "video",
      flags: VIDEO_FLAG.AVCC,
      streamEpoch: 1,
      ptsUs: 600_000n,
      payload: new Uint8Array([5]),
    });
    expect(decodeMediaFrames(primary)).toHaveLength(0);
    expect(harness.controller.getState().kind).toBe("LIVE");
    harness.controller.dispose();
  });

  it("AC-03: retains 60s / 48 MiB in ring buffer with separate CONFIG slots and evicts oldest complete GOP + preceding audio while protecting active GOP", () => {
    const rb = new MediaRingBuffer({ maxSeconds: 60, maxBytes: 1_000 });

    const vConfig = {
      mediaType: "video" as const,
      flags: VIDEO_FLAG.CONFIG,
      streamEpoch: 1,
      ptsUs: 0n,
      isKeyframe: false,
      frameBytes: new Uint8Array(600),
    };
    const aConfig = {
      mediaType: "audio" as const,
      flags: AUDIO_FLAG.CONFIG,
      streamEpoch: 1,
      ptsUs: 0n,
      isKeyframe: false,
      frameBytes: new Uint8Array(600),
    };
    rb.push(vConfig, true);
    rb.push(aConfig, true);
    expect(rb.getVideoConfig()).toBe(vConfig);
    expect(rb.getAudioConfig()).toBe(aConfig);
    expect(rb.getStats().totalBytes).toBe(0);

    rb.push(
      {
        mediaType: "audio",
        flags: AUDIO_FLAG.KEYFRAME,
        streamEpoch: 1,
        ptsUs: 50_000n,
        isKeyframe: true,
        frameBytes: new Uint8Array(200),
      },
      false,
    );
    rb.push(
      {
        mediaType: "video",
        flags: VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC,
        streamEpoch: 1,
        ptsUs: 100_000n,
        isKeyframe: true,
        frameBytes: new Uint8Array(300),
      },
      false,
    );
    rb.push(
      {
        mediaType: "video",
        flags: VIDEO_FLAG.AVCC,
        streamEpoch: 1,
        ptsUs: 200_000n,
        isKeyframe: false,
        frameBytes: new Uint8Array(200),
      },
      false,
    );
    rb.push(
      {
        mediaType: "video",
        flags: VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC,
        streamEpoch: 1,
        ptsUs: 1_000_000n,
        isKeyframe: true,
        frameBytes: new Uint8Array(400),
      },
      false,
    );

    expect(rb.getStats().totalBytes).toBe(400);
    expect(rb.getStats().oldestMediaPtsUs).toBe(1_000_000n);

    rb.push(
      {
        mediaType: "video",
        flags: VIDEO_FLAG.AVCC,
        streamEpoch: 1,
        ptsUs: 1_100_000n,
        isKeyframe: false,
        frameBytes: new Uint8Array(700),
      },
      false,
    );
    expect(rb.getStats().entryCount).toBe(2);
    expect(rb.getStats().oldestMediaPtsUs).toBe(1_000_000n);

    expect(rb.sliceFromKeyframe(500_000n, 5_000)).toHaveLength(2);
    expect(rb.sliceFromKeyframe(0n, 500)).toHaveLength(0);
  });

  it("AC-03: updates CatchupPacer EWMA drain rate and recovers 28-second tunnel disconnect cleanly", async () => {
    const clock = new FakeClock();
    const pacer = new CatchupPacer({ clock });

    pacer.recordProgress({ renderedPtsUs: 0, nowMs: 1_000 });
    pacer.recordProgress({ renderedPtsUs: 400_000, nowMs: 2_000 });
    expect(pacer.getDrainRate()).toBeCloseTo(0.7 * 1.0 + 0.3 * 0.4, 5);
    expect(pacer.getFlowProfile().congested).toBe(true);

    pacer.flush();
    expect(pacer.getFlowProfile().congested).toBe(false);
    pacer.recordSocketStall();
    pacer.recordSocketStall();
    pacer.recordSocketStall();
    expect(pacer.getFlowProfile().congested).toBe(true);

    const harness = await createStreamingHarness({
      targetBufferMs: 10_000,
      idleToBufferSeconds: 5,
    });
    const { transport: primary1, outcome: auth1 } = await harness.connectPrimary("p-1");
    harness.controller.ingestEncodedPacket({
      mediaType: "video",
      flags: VIDEO_FLAG.CONFIG,
      streamEpoch: 1,
      ptsUs: 0n,
      payload: new Uint8Array([0xaa]),
    });
    harness.controller.ingestEncodedPacket({
      mediaType: "video",
      flags: VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC,
      streamEpoch: 1,
      ptsUs: 1_000_000n,
      payload: new Uint8Array([1]),
    });
    harness.controller.handlePrimaryFeedback("p-1", 1, 1_000_000, 100, 100);

    harness.session.handleDisconnect("p-1", 1006);
    harness.controller.handleSocketRemoved("p-1");
    for (let sec = 2; sec <= 29; sec += 1) {
      harness.clock.advanceByMs(1_000);
      harness.controller.ingestEncodedPacket({
        mediaType: "video",
        flags: (sec % 2 === 0 ? VIDEO_FLAG.KEYFRAME : 0) | VIDEO_FLAG.AVCC,
        streamEpoch: 1,
        ptsUs: BigInt(sec) * 1_000_000n,
        payload: new Uint8Array([sec]),
      });
    }
    expect(harness.controller.getState().kind).toBe("LIVE");

    const primary2 = new FakeSessionTransport("p-2");
    const reconn = await harness.session.authenticateToken(primary2, auth1.session.token, true);
    expect(reconn.ok).toBe(true);
    harness.controller.handleSessionActivated("p-2", 1, 1_000_000n);
    expect(harness.controller.getState().kind).toBe("CATCHUP");

    harness.controller.handlePrimaryFeedback("p-2", 1, 25_000_000, 500, 500);
    harness.clock.advanceByMs(200);
    expect(harness.controller.getState().kind).toBe("LIVE");
    const recoveredPts = decodeMediaFrames(primary2).map((f) => f.ptsUs);
    expect(recoveredPts).toContain(2_000_000n);
    expect(recoveredPts).toContain(29_000_000n);
    expect(primary1.sentFrames.length).toBeGreaterThan(0);
    harness.controller.dispose();
  });

  it("仕様 02 AC-03 拡張: プライマリがライブ端より 300 ms 以上後方を視聴中にセカンダリが参加した場合、プライマリ確認済み PTS 付近のキーフレームから追っかけ配送を開始する", async () => {
    const harness = await createStreamingHarness({ maxSeconds: 60, maxBytes: 48 * 1024 * 1024 });
    await harness.connectPrimary("p-1");

    // 2s 間隔でキーフレーム、ライブ端 5s まで映像を蓄積し、プライマリは 2.0s 地点を再生確認済みとする。
    for (let sec = 1; sec <= 5; sec += 1) {
      harness.controller.ingestEncodedPacket({
        mediaType: "video",
        flags: (sec % 2 === 0 ? VIDEO_FLAG.KEYFRAME : 0) | VIDEO_FLAG.AVCC,
        streamEpoch: 1,
        ptsUs: BigInt(sec) * 1_000_000n,
        payload: new Uint8Array([sec]),
      });
    }
    harness.controller.handlePrimaryFeedback("p-1", 1, 2_000_000, 100, 100);
    expect(harness.session.getPrimaryConfirmedPtsUs(1)).toBe(2_000_000n);

    const { transport: secondary } = await harness.connectSecondary("s-1");
    const joinedPts = decodeMediaFrames(secondary).map((frame) => frame.ptsUs);

    // 確認済み PTS 付近（2s のキーフレーム境界）から 5s までの GOP が届き、それより前は送らない。
    expect(joinedPts).toContain(2_000_000n);
    expect(joinedPts).toContain(5_000_000n);
    expect(joinedPts).not.toContain(1_000_000n);

    harness.controller.dispose();
  });

  it("仕様 02 AC-03 拡張: プライマリがライブ端付近（lag ≤ 300 ms）の参加では追っかけ配送せずライブエッジ配信のみとする", async () => {
    const harness = await createStreamingHarness({ maxSeconds: 60, maxBytes: 48 * 1024 * 1024 });
    await harness.connectPrimary("p-1");

    for (let sec = 1; sec <= 5; sec += 1) {
      harness.controller.ingestEncodedPacket({
        mediaType: "video",
        flags: (sec % 2 === 0 ? VIDEO_FLAG.KEYFRAME : 0) | VIDEO_FLAG.AVCC,
        streamEpoch: 1,
        ptsUs: BigInt(sec) * 1_000_000n,
        payload: new Uint8Array([sec]),
      });
    }
    harness.controller.handlePrimaryFeedback("p-1", 1, 4_800_000, 100, 100);

    const { transport: secondary } = await harness.connectSecondary("s-1");
    expect(decodeMediaFrames(secondary).map((frame) => frame.ptsUs)).toEqual([]);

    // 以降のライブ配信は従来通りセカンダリへ届く。
    secondary.sentFrames.length = 0;
    harness.controller.ingestEncodedPacket({
      mediaType: "video",
      flags: VIDEO_FLAG.AVCC,
      streamEpoch: 1,
      ptsUs: 5_100_000n,
      payload: new Uint8Array([6]),
    });
    expect(decodeMediaFrames(secondary).map((frame) => frame.ptsUs)).toContain(5_100_000n);

    harness.controller.dispose();
  });

  it("AC-03: treats unreceived confirmed PTS as 0% occupancy and keeps occupancy from rising during LIVE GOP skip while audio playback advances", async () => {
    const harness = await createStreamingHarness({ maxSeconds: 60, maxBytes: 48 * 1024 * 1024 });
    const { transport: primary } = await harness.connectPrimary("p-1");

    for (let sec = 1; sec <= 55; sec += 1) {
      harness.controller.ingestEncodedPacket({
        mediaType: "video",
        flags: (sec % 2 === 0 ? VIDEO_FLAG.KEYFRAME : 0) | VIDEO_FLAG.AVCC,
        streamEpoch: 1,
        ptsUs: BigInt(sec) * 1_000_000n,
        payload: new Uint8Array([sec]),
      });
    }
    expect(harness.controller.getState().kind).toBe("LIVE");
    expect(harness.session.getPrimaryConfirmedPtsUs(1)).toBeNull();
    harness.controller.clearBufferAndQueues();

    primary.setBufferedAmount(2_000_000);
    for (let sec = 1; sec <= 58; sec += 1) {
      harness.controller.ingestEncodedPacket({
        mediaType: "video",
        flags: VIDEO_FLAG.AVCC,
        streamEpoch: 1,
        ptsUs: BigInt(sec) * 1_000_000n,
        payload: new Uint8Array([sec]),
      });
      harness.controller.ingestEncodedPacket({
        mediaType: "audio",
        flags: AUDIO_FLAG.KEYFRAME,
        streamEpoch: 1,
        ptsUs: BigInt(sec) * 1_000_000n,
        payload: new Uint8Array([sec]),
      });
      harness.controller.handlePrimaryFeedback("p-1", 1, sec * 1_000_000, 50, 50);
    }
    expect(harness.controller.getState().kind).toBe("LIVE");
    expect(harness.lifecycleEvents).toEqual([]);
    harness.controller.dispose();
  });

  it("AC-04 & AC-06: drives all transitions exclusively through transitionStreamingState, clears confirmed PTS across STREAM_RESET/CATCHUP interaction, and cleans up resources on dispose", async () => {
    let releaseResetGate!: () => void;
    const harness = await createStreamingHarness({
      asyncResetGate: () =>
        new Promise<void>((resolve) => {
          releaseResetGate = resolve;
        }),
    });
    const { transport: primary } = await harness.connectPrimary("p-1");

    await harness.controller.handleUserInteraction(harness.clock.nowMs());
    expect(harness.controller.getState().kind).toBe("INTERACTIVE");
    harness.clock.advanceByMs(3_999);
    expect(harness.controller.getState().kind).toBe("INTERACTIVE");
    harness.clock.advanceByMs(1);
    expect(harness.controller.getState().kind).toBe("LIVE");

    harness.controller.onPowerSleep();
    expect(harness.controller.getState().kind).toBe("STANDBY");
    await harness.controller.handleUserInteraction(harness.clock.nowMs());
    expect(harness.controller.getState().kind).toBe("STANDBY");
    primary.sentFrames.length = 0;
    harness.controller.ingestEncodedPacket({
      mediaType: "video",
      flags: VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC,
      streamEpoch: 1,
      ptsUs: 10_000n,
      payload: new Uint8Array([9]),
    });
    expect(decodeMediaFrames(primary)).toHaveLength(0);

    harness.setEpoch(2);
    harness.controller.onPowerActive(2);
    harness.controller.broadcastPowerState("ACTIVE", 2);
    expect(harness.controller.getState()).toEqual({ kind: "LIVE", streamEpoch: 2 });
    harness.controller.ingestEncodedPacket({
      mediaType: "video",
      flags: VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC,
      streamEpoch: 2,
      ptsUs: 50_000_000n,
      payload: new Uint8Array([8]),
    });
    harness.controller.handlePrimaryFeedback("p-1", 2, 40_000_000, 50, 50);
    expect(harness.session.getPrimaryConfirmedPtsUs(2)).toBe(40_000_000n);
    expect(harness.ringBuffer.getStats().entryCount).toBe(1);

    harness.controller.handleStreamReset(3);
    harness.setEpoch(3);
    expect(harness.ringBuffer.getStats().entryCount).toBe(0);
    expect(harness.controller.getState()).toEqual({ kind: "LIVE", streamEpoch: 3 });
    expect(harness.session.getPrimaryConfirmedPtsUs(3)).toBeNull();
    expect(harness.session.getPrimarySyncMetadata().primaryRenderedPts).toBeNull();

    harness.controller.handlePrimaryFeedback("p-1", 2, 41_000_000, 50, 50);
    expect(harness.session.getPrimaryConfirmedPtsUs(3)).toBeNull();
    harness.controller.ingestEncodedPacket({
      mediaType: "video",
      flags: VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC,
      streamEpoch: 3,
      ptsUs: 0n,
      payload: new Uint8Array([7]),
    });
    expect(harness.controller.getState().kind).toBe("LIVE");
    harness.controller.handlePrimaryFeedback("p-1", 3, 50_000, 50, 50);
    expect(harness.session.getPrimaryConfirmedPtsUs(3)).toBe(50_000n);

    // Concurrent DOWN -> UP interactions in CATCHUP share a single in-flight encoder reset.
    harness.controller.dispatchEvent({
      type: "SESSION_ACTIVATED",
      streamEpoch: 3,
      resumeCatchup: { targetBufferMs: 10_000, resumePtsUs: 0 },
    });
    expect(harness.controller.getState().kind).toBe("CATCHUP");
    const firstTap = harness.controller.handleUserInteraction(harness.clock.nowMs());
    const secondTap = harness.controller.handleUserInteraction(harness.clock.nowMs() + 20);
    releaseResetGate();
    await Promise.all([firstTap, secondTap]);
    expect(harness.getInteractiveResetCalls()).toBe(1);
    expect(harness.controller.getState().kind).toBe("INTERACTIVE");
    expect(harness.controller.getState().streamEpoch).toBe(4);
    expect(harness.session.getPrimaryConfirmedPtsUs(4)).toBeNull();
    expect(harness.catchupPacer.isDrained()).toBe(true);

    // INTERACTIVE expires back to LIVE, then BUFFER_HOLD -> USER_INTERACTION emits BUFFER_HOLD(false) and resumes INTERACTIVE on new epoch.
    harness.clock.advanceByMs(4_000);
    expect(harness.controller.getState().kind).toBe("LIVE");
    harness.controller.onPowerHoldEntered(harness.clock.nowMs());
    expect(harness.controller.getState().kind).toBe("BUFFER_HOLD");
    primary.sentFrames.length = 0;
    await harness.controller.handleUserInteraction(harness.clock.nowMs());
    expect(harness.lifecycleEvents).toContain("EXIT_HOLD:INTERACTION");
    expect(harness.controller.getState().kind).toBe("INTERACTIVE");
    expect(harness.controller.getState().streamEpoch).toBe(5);
    expect(decodeControls(primary).some((c) => c.type === "BUFFER_HOLD" && !c.active)).toBe(true);

    // dispose() clears ring buffer and guards against post-dispose timer re-arming.
    harness.controller.ingestEncodedPacket({
      mediaType: "video",
      flags: VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC,
      streamEpoch: 5,
      ptsUs: 100_000n,
      payload: new Uint8Array([1]),
    });
    expect(harness.ringBuffer.getStats().entryCount).toBe(1);
    harness.controller.dispose();
    expect(harness.ringBuffer.getStats().entryCount).toBe(0);
    await harness.controller.handleUserInteraction(harness.clock.nowMs());
    harness.clock.advanceByMs(10_000);
    expect(harness.controller.getState().kind).toBe("INTERACTIVE");
  });
});
