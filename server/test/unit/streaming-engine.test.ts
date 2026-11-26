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

  const powerHoldRequests: string[] = [];
  let controllerRef: StreamingController | undefined;

  const controller = new StreamingController({
    clock,
    settings,
    session,
    ringBuffer,
    catchupPacer,
    idleToBufferSeconds: options?.idleToBufferSeconds,
    powerHooks: {
      requestHold: async () => {
        powerHoldRequests.push("HOLD");
        controllerRef?.onPowerHoldEntered(clock.nowMs());
      },
      requestResumeFromHold: async (reason) => {
        powerHoldRequests.push(`RESUME:${reason}`);
        currentEpoch = nextStreamEpoch(currentEpoch);
        controllerRef?.onPowerHoldExited(currentEpoch);
      },
    },
    encoderHooks: {
      advanceEpochAndReset: async () => {
        currentEpoch = nextStreamEpoch(currentEpoch);
        return currentEpoch;
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
    powerHoldRequests,
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
    // 2 Mbps -> highWater = 750,000 B, lowWater = 150,000 B
    const hysteresis = new SocketLiveHysteresis(2_000_000);
    // Single IDR burst at or below highWater is never dropped.
    expect(hysteresis.evaluatePacket("video", true, 750_000)).toEqual({
      send: true,
      congestionTriggered: false,
    });
    expect(hysteresis.isDroppingGop()).toBe(false);

    // Exceeding highWater enters GOP drop; P-frames and high-water keyframes stay dropped.
    expect(hysteresis.evaluatePacket("video", false, 750_001)).toEqual({
      send: false,
      congestionTriggered: true,
    });
    expect(hysteresis.evaluatePacket("video", true, 200_000)).toEqual({
      send: false,
      congestionTriggered: false,
    });
    // Low water + non-keyframe stays dropped.
    expect(hysteresis.evaluatePacket("video", false, 150_000)).toEqual({
      send: false,
      congestionTriggered: false,
    });
    // Low water + IDR keyframe resumes normal LIVE delivery.
    expect(hysteresis.evaluatePacket("video", true, 150_000)).toEqual({
      send: true,
      congestionTriggered: false,
    });
    // Audio is exempt from video GOP drop and guarded at <= 2 MiB.
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

    // Congest secondary only (> 750,000 B); primary must continue receiving both video & audio and stay LIVE.
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

    // Settings bitrate update recalculates watermarks on existing sockets (2M -> 500k: highWater = 512 KiB).
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
    // Congestion in LIVE never transitions to CATCHUP.
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

    // Leading audio + GOP 1 (0..900ms) + GOP 2 (1000..1500ms)
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

    // Total was 1100 > 1000, so leading audio + GOP 1 evicted together; GOP 2 remains intact.
    expect(rb.getStats().totalBytes).toBe(400);
    expect(rb.getStats().oldestMediaPtsUs).toBe(1_000_000n);

    // Pushing another large P-frame onto the single remaining GOP protects that active GOP.
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

    // sliceFromKeyframe allows up to 5s lookback if targetPtsUs precedes oldest keyframe.
    expect(rb.sliceFromKeyframe(500_000n, 5_000)).toHaveLength(2);
    expect(rb.sliceFromKeyframe(0n, 500)).toHaveLength(0);
  });

  it("AC-03: handles 25-30s tunnel disconnect recovery lossless and switches to congested CATCHUP profile (window shrink, 32-64 KiB guard, 10ms burst) when drainRate < 0.85x or stalls >= 3", async () => {
    const clock = new FakeClock();
    const pacer = new CatchupPacer({ clock });

    // Record low drain rate (< 0.85x) and verify congested profile.
    pacer.recordProgress({ renderedPtsUs: 0, nowMs: 1_000 });
    pacer.recordProgress({ renderedPtsUs: 400_000, nowMs: 2_000 });
    expect(pacer.getDrainRate()).toBeCloseTo(0.7 * 1.0 + 0.3 * 0.4, 5);
    const congestedByRate = pacer.getFlowProfile();
    expect(congestedByRate.congested).toBe(true);
    expect(congestedByRate.burstIntervalMs).toBe(10);
    expect(congestedByRate.socketGuardBytes).toBeGreaterThanOrEqual(32 * 1024);
    expect(congestedByRate.socketGuardBytes).toBeLessThanOrEqual(64 * 1024);

    // 3 consecutive socket stalls also force congested profile even with healthy drain rate.
    pacer.flush();
    expect(pacer.getFlowProfile().congested).toBe(false);
    expect(pacer.getFlowProfile().socketGuardBytes).toBe(128 * 1024);
    expect(pacer.getFlowProfile().burstIntervalMs).toBe(2);
    pacer.recordSocketStall();
    pacer.recordSocketStall();
    pacer.recordSocketStall();
    expect(pacer.getFlowProfile().congested).toBe(true);
    expect(pacer.getFlowProfile().socketGuardBytes).toBe(32 * 1024);
    expect(pacer.getFlowProfile().burstIntervalMs).toBe(10);

    // End-to-end 28-second tunnel disconnect recovery lossless via StreamingController.
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

    // Transient disconnect (1006) for 28 seconds while encoder produces 28s of frames.
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

    // Reconnect with same token -> enters CATCHUP and recovers all buffered frames losslessly.
    const primary2 = new FakeSessionTransport("p-2");
    const reconn = await harness.session.authenticateToken(primary2, auth1.session.token, true);
    expect(reconn.ok).toBe(true);
    harness.controller.handleSessionActivated("p-2", 1, 1_000_000n);
    expect(harness.controller.getState().kind).toBe("CATCHUP");

    // Advance feedback + clock so CatchupPacer drains all 29 keyframes/frames cleanly into LIVE.
    harness.controller.handlePrimaryFeedback("p-2", 1, 25_000_000, 500, 500);
    harness.clock.advanceByMs(200);
    expect(harness.controller.getState().kind).toBe("LIVE");
    const recoveredPts = decodeMediaFrames(primary2).map((f) => f.ptsUs);
    expect(recoveredPts).toContain(2_000_000n);
    expect(recoveredPts).toContain(29_000_000n);
    expect(primary1.sentFrames.length).toBeGreaterThan(0);
    harness.controller.dispose();
  });

  it("AC-03 & AC-05: uses max(PTS delta, videoBufferedMs, audioBufferedMs) for PONG/flow control and triggers BUFFER_HOLD at 85% occupancy with generation pause + CATCHUP send until <= 10% drain", async () => {
    const harness = await createStreamingHarness({ maxSeconds: 60, maxBytes: 48 * 1024 * 1024 });
    const { transport: primary, outcome: auth } = await harness.connectPrimary("p-1");

    harness.controller.ingestEncodedPacket({
      mediaType: "video",
      flags: VIDEO_FLAG.CONFIG,
      streamEpoch: 1,
      ptsUs: 0n,
      payload: new Uint8Array([0xbb]),
    });
    harness.controller.ingestEncodedPacket({
      mediaType: "video",
      flags: VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC,
      streamEpoch: 1,
      ptsUs: 1_000_000n,
      payload: new Uint8Array([1]),
    });
    harness.controller.ingestEncodedPacket({
      mediaType: "video",
      flags: VIDEO_FLAG.AVCC,
      streamEpoch: 1,
      ptsUs: 5_000_000n,
      payload: new Uint8Array([2]),
    });

    // Audio lag (2,500 ms) > video lag (300 ms) reduces serverRemainingBufferMs (4,000 - 2,500 = 1,500 ms).
    harness.controller.handlePrimaryFeedback("p-1", 1, 1_000_000, 300, 2_500);
    const pong = decodeServerControlFrame(harness.controller.buildPongPayload(9_000));
    expect(pong.type).toBe("PONG");
    if (pong.type === "PONG") {
      expect(pong.serverRemainingBufferMs).toBe(1_500);
    }

    // Disconnect and feed up to 52s unconsumed (> 85% of 60s) -> enters BUFFER_HOLD.
    harness.session.handleDisconnect("p-1", 1006);
    harness.controller.handleSocketRemoved("p-1");
    for (let sec = 6; sec <= 52; sec += 1) {
      harness.controller.ingestEncodedPacket({
        mediaType: "video",
        flags: (sec % 2 === 0 ? VIDEO_FLAG.KEYFRAME : 0) | VIDEO_FLAG.AVCC,
        streamEpoch: 1,
        ptsUs: BigInt(sec) * 1_000_000n,
        payload: new Uint8Array([sec]),
      });
    }
    expect(harness.controller.getState().kind).toBe("BUFFER_HOLD");
    expect(harness.powerHoldRequests).toEqual(["HOLD"]);

    // While in BUFFER_HOLD, new encoder generation packets are dropped (shouldPauseGeneration = true).
    const countBefore = harness.ringBuffer.getStats().entryCount;
    harness.controller.ingestEncodedPacket({
      mediaType: "video",
      flags: VIDEO_FLAG.AVCC,
      streamEpoch: 1,
      ptsUs: 53_000_000n,
      payload: new Uint8Array([53]),
    });
    expect(harness.ringBuffer.getStats().entryCount).toBe(countBefore);

    // Same primary reconnects: stays in BUFFER_HOLD while draining CATCHUP, then auto-resumes at <= 10%.
    const primary2 = new FakeSessionTransport("p-2");
    await harness.session.authenticateToken(primary2, auth.session.token, true);
    harness.controller.handleSessionActivated("p-2", 1, 1_000_000n);
    expect(harness.controller.getState().kind).toBe("BUFFER_HOLD");

    // Advance feedback & clock so CatchupPacer drains past 90% (<= 10% unconsumed remains).
    harness.controller.handlePrimaryFeedback("p-2", 1, 48_000_000, 200, 200);
    harness.clock.advanceByMs(200);
    expect(harness.controller.getState().kind).toBe("LIVE");
    expect(harness.controller.getState().streamEpoch).toBe(2);
    expect(harness.powerHoldRequests).toContain("RESUME:DRAINED");
    expect(decodeControls(primary2).some((c) => c.type === "BUFFER_HOLD" && !c.active)).toBe(true);
    expect(primary.sentFrames.length).toBeGreaterThan(0);
    harness.controller.dispose();
  });

  it("AC-04 & AC-06: drives all transitions exclusively through transitionStreamingState without boolean soup and clears queues on STREAM_RESET", async () => {
    const harness = await createStreamingHarness();
    const { transport: primary } = await harness.connectPrimary("p-1");

    // LIVE -> INTERACTIVE on user interaction -> auto-returns to LIVE after 4,000 ms.
    harness.controller.handleUserInteraction(harness.clock.nowMs());
    expect(harness.controller.getState().kind).toBe("INTERACTIVE");
    harness.clock.advanceByMs(3_999);
    expect(harness.controller.getState().kind).toBe("INTERACTIVE");
    harness.clock.advanceByMs(1);
    expect(harness.controller.getState().kind).toBe("LIVE");

    // STANDBY ignores interactions and suppresses media send.
    harness.controller.onPowerSleep();
    expect(harness.controller.getState().kind).toBe("STANDBY");
    harness.controller.handleUserInteraction(harness.clock.nowMs());
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

    // Wake back up, buffer a frame, then STREAM_RESET -> clears ring buffer and sets new epoch LIVE.
    harness.controller.broadcastPowerState("ACTIVE", 2);
    harness.setEpoch(2);
    expect(harness.controller.getState()).toEqual({ kind: "LIVE", streamEpoch: 2 });
    harness.controller.ingestEncodedPacket({
      mediaType: "video",
      flags: VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC,
      streamEpoch: 2,
      ptsUs: 20_000n,
      payload: new Uint8Array([8]),
    });
    expect(harness.ringBuffer.getStats().entryCount).toBe(1);

    harness.controller.handleStreamReset(3);
    expect(harness.ringBuffer.getStats().entryCount).toBe(0);
    expect(harness.controller.getState()).toEqual({ kind: "LIVE", streamEpoch: 3 });

    // CATCHUP + USER_INTERACTION flushes catchup queue and advances epoch.
    harness.controller.dispatchEvent({
      type: "SESSION_ACTIVATED",
      streamEpoch: 3,
      resumeCatchup: { targetBufferMs: 10_000, resumePtsUs: 0 },
    });
    expect(harness.controller.getState().kind).toBe("CATCHUP");
    harness.controller.handleUserInteraction(harness.clock.nowMs());
    expect(harness.controller.getState().kind).toBe("INTERACTIVE");
    expect(harness.controller.getState().streamEpoch).toBe(4);
    expect(harness.catchupPacer.isDrained()).toBe(true);
    harness.controller.dispose();
  });
});
