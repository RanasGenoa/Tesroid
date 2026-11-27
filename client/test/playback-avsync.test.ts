import {
  AUDIO_FLAG,
  CHANNEL_ID,
  decodeClientControlFrame,
  INTERACTION_TIMEOUT_MS,
  type MediaFrame,
  PROTOCOL_TIMING,
  VIDEO_FLAG,
  type WsCloseCode,
} from "@tesroid/shared";
import { describe, expect, it } from "vitest";
import {
  AUDIO_PLAYER_CONSTANTS,
  type AudioBufferLike,
  type AudioBufferSourceNodeLike,
  type AudioContextFactory,
  type AudioContextLike,
  type AudioDataLike,
  type AudioDecoderAdapter,
  type AudioDecoderConfigSpec,
  type AudioDecoderFactory,
  type AudioGainNodeLike,
  AudioPlayerPipeline,
  type Canvas2DContextLike,
  Canvas2DRenderer,
  type CanvasElementLike,
  CatchupVideoQueue,
  LiveVideoQueue,
  MasterSyncClock,
  PlaybackController,
  StreamEpochGate,
  selectSyncPolicy,
  VIDEO_DECODER_CONSTANTS,
  type VideoDecoderAdapter,
  type VideoDecoderConfigProbe,
  type VideoDecoderFactory,
  VideoDecoderPipeline,
  type VideoFrameLike,
} from "../src/media/index.js";
import type {
  ClientClock,
  ClientTimerHandle,
  WsClientHandlers,
  WsConnectionStatus,
  WsTransportPort,
} from "../src/transport/ports.js";

class FakeClock implements ClientClock {
  private currentMs: number;
  private nextId = 1;
  private readonly timers = new Set<{
    readonly id: number;
    readonly fireAtMs: number;
    readonly callback: () => void;
    cancelled: boolean;
  }>();

  constructor(initialMs = 10_000) {
    this.currentMs = initialMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  setTimeout(callback: () => void, delayMs: number): ClientTimerHandle {
    const entry = {
      id: this.nextId++,
      fireAtMs: this.currentMs + Math.max(0, delayMs),
      callback,
      cancelled: false,
    };
    this.timers.add(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
        this.timers.delete(entry);
      },
    };
  }

  clearTimeout(handle: ClientTimerHandle): void {
    handle.cancel();
  }

  advanceBy(ms: number): void {
    const targetMs = this.currentMs + ms;
    while (true) {
      let nextTimer: {
        readonly id: number;
        readonly fireAtMs: number;
        readonly callback: () => void;
        cancelled: boolean;
      } | null = null;
      for (const timer of this.timers) {
        if (!timer.cancelled && timer.fireAtMs <= targetMs) {
          if (
            nextTimer === null ||
            timer.fireAtMs < nextTimer.fireAtMs ||
            (timer.fireAtMs === nextTimer.fireAtMs && timer.id < nextTimer.id)
          ) {
            nextTimer = timer;
          }
        }
      }
      if (nextTimer === null) {
        break;
      }
      this.timers.delete(nextTimer);
      this.currentMs = Math.max(this.currentMs, nextTimer.fireAtMs);
      nextTimer.callback();
    }
    this.currentMs = targetMs;
  }
}

class FakeWsTransport implements WsTransportPort {
  readonly sentFrames: Uint8Array[] = [];
  connected = true;

  connect(_url: string, _handlers: WsClientHandlers): void {}

  sendBinary(data: Uint8Array): boolean {
    if (!this.connected) {
      return false;
    }
    this.sentFrames.push(new Uint8Array(data));
    return true;
  }

  disconnect(_code?: WsCloseCode, _reason?: string): void {
    this.connected = false;
  }

  getStatus(): WsConnectionStatus {
    return this.connected ? "CONNECTED" : "DISCONNECTED";
  }
}

class TrackedVideoFrame implements VideoFrameLike {
  closed = false;
  closeCount = 0;

  constructor(
    readonly timestamp: number,
    readonly codedWidth = 1280,
    readonly codedHeight = 720,
    readonly duration: number | null = 33_333,
    private readonly customBytes?: number,
  ) {}

  get displayWidth(): number {
    return this.codedWidth;
  }

  get displayHeight(): number {
    return this.codedHeight;
  }

  allocationSize(): number {
    return this.customBytes ?? this.codedWidth * this.codedHeight * 2;
  }

  close(): void {
    this.closed = true;
    this.closeCount += 1;
  }
}

class TrackedAudioData implements AudioDataLike {
  closed = false;
  closeCount = 0;

  constructor(
    readonly timestamp: number,
    readonly format: AudioSampleFormat | null = "f32-planar",
    readonly numberOfFrames = 960,
    readonly numberOfChannels = 2,
    readonly sampleRate = 48_000,
    private readonly sampleValue = 0.25,
  ) {}

  copyTo(destination: AllowSharedBufferSource, options: AudioDataCopyToOptions): void {
    const target =
      destination instanceof Float32Array
        ? destination
        : new Float32Array(
            ArrayBuffer.isView(destination) ? destination.buffer : destination,
            ArrayBuffer.isView(destination) ? destination.byteOffset : 0,
            destination.byteLength / 4,
          );
    const fillVal = options.planeIndex === 1 ? -this.sampleValue : this.sampleValue;
    target.fill(fillVal);
  }

  close(): void {
    this.closed = true;
    this.closeCount += 1;
  }
}

class FakeCanvasElement implements CanvasElementLike {
  width = 0;
  height = 0;
  requestedContextId: string | null = null;
  requestedContextOptions: CanvasRenderingContext2DSettings | undefined;
  readonly drawnTimestamps: number[] = [];
  throwOnDraw = false;

  private readonly ctx: Canvas2DContextLike = {
    fillStyle: "#000000",
    drawImage: (image) => {
      if (this.throwOnDraw) {
        throw new Error("draw failed");
      }
      this.drawnTimestamps.push(image.timestamp);
    },
    fillRect: () => {},
    clearRect: () => {},
  };

  getContext(
    contextId: "2d",
    options?: CanvasRenderingContext2DSettings,
  ): Canvas2DContextLike | null {
    this.requestedContextId = contextId;
    this.requestedContextOptions = options;
    return this.ctx;
  }
}

interface FakeVideoDecoderInstance extends VideoDecoderAdapter {
  emitOutput(frame: VideoFrameLike): void;
  emitError(error: Error): void;
  readonly decodedTimestamps: number[];
  configuredWith: VideoDecoderConfigProbe | null;
}

class FakeVideoDecoderFactory implements VideoDecoderFactory {
  readonly probedConfigs: VideoDecoderConfigProbe[] = [];
  readonly instances: FakeVideoDecoderInstance[] = [];
  readonly createdFrames: TrackedVideoFrame[] = [];
  autoOutput = true;
  simulatedQueueSize = 0;
  supportHandler: (config: VideoDecoderConfigProbe) => Promise<boolean> = async () => true;
  onConfiguredHook?: (config: VideoDecoderConfigProbe) => void;

  getLatestInstance(): FakeVideoDecoderInstance | undefined {
    return this.instances[this.instances.length - 1];
  }

  async isConfigSupported(config: VideoDecoderConfigProbe): Promise<boolean> {
    this.probedConfigs.push(config);
    return this.supportHandler(config);
  }

  create(callbacks: {
    readonly onOutput: (frame: VideoFrameLike) => void;
    readonly onError: (error: Error) => void;
  }): VideoDecoderAdapter {
    let state: "unconfigured" | "configured" | "closed" = "unconfigured";
    const decodedTimestamps: number[] = [];
    const factory = this;
    const instance: FakeVideoDecoderInstance = {
      get state() {
        return state;
      },
      get decodeQueueSize() {
        return factory.simulatedQueueSize;
      },
      decodedTimestamps,
      configuredWith: null,
      configure: (cfg) => {
        state = "configured";
        instance.configuredWith = cfg;
        factory.onConfiguredHook?.(cfg);
      },
      decode: (_payload, timestampUs) => {
        decodedTimestamps.push(timestampUs);
        if (factory.autoOutput) {
          const frame = new TrackedVideoFrame(timestampUs);
          factory.createdFrames.push(frame);
          callbacks.onOutput(frame);
        }
      },
      close: () => {
        state = "closed";
      },
      emitOutput: (frame) => {
        callbacks.onOutput(frame);
      },
      emitError: (error) => {
        callbacks.onError(error);
      },
    };
    this.instances.push(instance);
    return instance;
  }
}

interface FakeAudioDecoderInstance extends AudioDecoderAdapter {
  emitOutput(data: AudioDataLike): void;
  configuredWith: AudioDecoderConfigSpec | null;
}

class FakeAudioDecoderFactory implements AudioDecoderFactory {
  readonly instances: FakeAudioDecoderInstance[] = [];
  readonly createdAudioData: TrackedAudioData[] = [];
  configureCount = 0;
  defaultFormat: AudioSampleFormat = "f32-planar";
  supportHandler: (config: AudioDecoderConfigSpec) => Promise<boolean> = async () => true;

  getLatestInstance(): FakeAudioDecoderInstance | undefined {
    return this.instances[this.instances.length - 1];
  }

  async isConfigSupported(config: AudioDecoderConfigSpec): Promise<boolean> {
    return this.supportHandler(config);
  }

  create(callbacks: {
    readonly onOutput: (data: AudioDataLike) => void;
    readonly onError: (error: Error) => void;
  }): AudioDecoderAdapter {
    let state: "unconfigured" | "configured" | "closed" = "unconfigured";
    const instance: FakeAudioDecoderInstance = {
      get state() {
        return state;
      },
      get decodeQueueSize() {
        return 0;
      },
      configuredWith: null,
      configure: (cfg) => {
        state = "configured";
        instance.configuredWith = cfg;
        this.configureCount += 1;
      },
      decode: (_payload, timestampUs) => {
        const audioData = new TrackedAudioData(timestampUs, this.defaultFormat);
        this.createdAudioData.push(audioData);
        callbacks.onOutput(audioData);
      },
      close: () => {
        state = "closed";
      },
      emitOutput: (data) => {
        callbacks.onOutput(data);
      },
    };
    this.instances.push(instance);
    return instance;
  }
}

class FakeAudioContextHarness {
  readonly createdOptions: Array<{
    readonly latencyHint: "interactive";
    readonly sampleRate: number;
  }> = [];
  readonly gainNodes: AudioGainNodeLike[] = [];
  readonly scheduledSources: Array<{
    readonly source: AudioBufferSourceNodeLike;
    readonly startWhenSec: number;
    isStopped: () => boolean;
  }> = [];
  currentTimeSec = 0;
  state: AudioContextState = "suspended";

  readonly factory: AudioContextFactory = (options) => {
    this.createdOptions.push(options);
    const destination = {};
    const gainNode: AudioGainNodeLike = {
      gain: { value: 1 },
      connect: () => {},
      disconnect: () => {},
    };
    this.gainNodes.push(gainNode);

    const harness = this;
    const ctx: AudioContextLike = {
      get state() {
        return harness.state;
      },
      get currentTime() {
        return harness.currentTimeSec;
      },
      sampleRate: options.sampleRate,
      destination,
      resume: async () => {
        harness.state = "running";
      },
      close: async () => {
        harness.state = "closed";
      },
      createGain: () => gainNode,
      createBuffer: (channels, length, sampleRate) => {
        const planes = Array.from({ length: channels }, () => new Float32Array(length));
        const buffer: AudioBufferLike = {
          duration: length / sampleRate,
          length,
          sampleRate,
          numberOfChannels: channels,
          copyToChannel: (src, ch) => {
            planes[ch]?.set(src);
          },
        };
        return buffer;
      },
      createBufferSource: () => {
        let stopped = false;
        const source: AudioBufferSourceNodeLike = {
          buffer: null,
          playbackRate: { value: 1 },
          connect: () => {},
          disconnect: () => {},
          start: (when = 0) => {
            harness.scheduledSources.push({
              source,
              startWhenSec: when,
              isStopped: () => stopped,
            });
          },
          stop: () => {
            stopped = true;
          },
          onended: null,
        };
        return source;
      },
    };
    return ctx;
  };
}

function makeAvcAnnexBConfig(profile = 0x42, level = 0x1f): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0x00,
    0x00,
    0x00,
    0x01,
    0x67,
    profile,
    0xc0,
    level,
    0xda,
    0x01,
    0x40,
    0x16,
    0xec,
    0x04,
    0x40,
    0x00,
    0x00,
    0x03,
    0x00,
    0x40,
    0x00,
    0x00,
    0x0f,
    0x03,
    0xc6,
    0x0c,
    0x65,
    0x80,
    0x00,
    0x00,
    0x00,
    0x01,
    0x68,
    0xce,
    0x38,
    0x80,
  ]);
}

const SAMPLE_ANNEXB_SPS_PPS = makeAvcAnnexBConfig(0x42, 0x1f);

const SAMPLE_OPUS_HEAD = new Uint8Array([
  0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 0x01, 0x02, 0x38, 0x01, 0x80, 0xbb, 0x00, 0x00,
  0x00, 0x00, 0x00,
]);

function makeVideoFrame(
  streamEpoch: number,
  ptsUs: number,
  flags: number,
  payload: Uint8Array = new Uint8Array([0, 0, 0, 2, 0x65, 0x88]),
): MediaFrame {
  return {
    channel: CHANNEL_ID.VIDEO,
    flags,
    streamEpoch,
    ptsUs: BigInt(ptsUs),
    payload,
  };
}

function makeAudioFrame(
  streamEpoch: number,
  ptsUs: number,
  flags = 0,
  payload = new Uint8Array([0xfc, 0xff, 0xfe]),
): MediaFrame {
  return {
    channel: CHANNEL_ID.AUDIO,
    flags,
    streamEpoch,
    ptsUs: BigInt(ptsUs),
    payload,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe("client/media (Spec 04)", () => {
  it("AC-01: renders video solely onto <canvas> (alpha: false, desynchronized: true), accepts AVCC frames without Annex-B fallback, and calls close() on 100% of rendered/dropped/reset VideoFrames and AudioData", async () => {
    const clock = new FakeClock(1_000);
    const canvas = new FakeCanvasElement();
    const renderer = new Canvas2DRenderer(clock);
    renderer.attach(canvas);

    expect(canvas.requestedContextId).toBe("2d");
    expect(canvas.requestedContextOptions).toEqual({ alpha: false, desynchronized: true });

    const renderedFrame = new TrackedVideoFrame(33_000, 960, 540);
    renderer.renderFrame(renderedFrame);
    expect(canvas.width).toBe(960);
    expect(canvas.height).toBe(540);
    expect(canvas.drawnTimestamps).toEqual([33_000]);
    expect(renderedFrame.closed).toBe(true);

    canvas.throwOnDraw = true;
    const errorFrame = new TrackedVideoFrame(66_000);
    expect(() => renderer.renderFrame(errorFrame)).toThrow("draw failed");
    expect(errorFrame.closed).toBe(true);
    canvas.throwOnDraw = false;

    const gate = new StreamEpochGate();
    expect(gate.evaluateVideoFrame(makeVideoFrame(1, 0, VIDEO_FLAG.KEYFRAME)).accept).toBe(false);
    expect(gate.isWaitingForKeyframe()).toBe(true);
    expect(
      gate.evaluateVideoFrame(makeVideoFrame(1, 0, VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC)).accept,
    ).toBe(true);
    expect(gate.isWaitingForKeyframe()).toBe(false);

    const transport = new FakeWsTransport();
    const videoFactory = new FakeVideoDecoderFactory();
    const audioFactory = new FakeAudioDecoderFactory();
    const audioHarness = new FakeAudioContextHarness();

    const controller = new PlaybackController({
      transport,
      onRequestStreamReset: () => {},
      clock,
      videoDecoderFactory: videoFactory,
      audioDecoderFactory: audioFactory,
      audioContextFactory: audioHarness.factory,
    });
    controller.attachCanvas(new FakeCanvasElement());
    controller.dispatchStreamingEvent({ type: "SESSION_ACTIVATED", streamEpoch: 1 });
    await controller.unlockAudioOnGesture();

    controller.handleMediaFrame(makeVideoFrame(1, 0, VIDEO_FLAG.CONFIG, SAMPLE_ANNEXB_SPS_PPS));
    controller.handleMediaFrame(makeAudioFrame(1, 0, AUDIO_FLAG.CONFIG, SAMPLE_OPUS_HEAD));
    await flushMicrotasks();

    for (let i = 0; i < 20; i += 1) {
      const flags = i === 0 ? VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC : VIDEO_FLAG.AVCC;
      controller.handleMediaFrame(makeVideoFrame(1, i * 33_333, flags));
      clock.advanceBy(10);
    }
    audioFactory.defaultFormat = "f32-planar";
    for (let i = 0; i < 5; i += 1) {
      controller.handleMediaFrame(makeAudioFrame(1, i * 20_000));
    }
    audioFactory.defaultFormat = "f32";
    for (let i = 5; i < 10; i += 1) {
      controller.handleMediaFrame(makeAudioFrame(1, i * 20_000));
    }

    controller.resetForNewEpoch(2);
    controller.dispose();

    expect(videoFactory.createdFrames.length).toBe(20);
    expect(videoFactory.createdFrames.every((f) => f.closed)).toBe(true);
    expect(audioFactory.createdAudioData.length).toBe(10);
    expect(audioFactory.createdAudioData.every((a) => a.closed)).toBe(true);
  });

  it("AC-02: drops stale streamEpoch packets before and after decode, resets keyframe gate on delta drop while preserving epoch, orders error recovery reconfigure before reset, cancels recovery on STANDBY, and resolves concurrent configure() in favor of latest call", async () => {
    const clock = new FakeClock(20_000);
    const transport = new FakeWsTransport();
    const videoFactory = new FakeVideoDecoderFactory();
    const audioFactory = new FakeAudioDecoderFactory();
    const audioHarness = new FakeAudioContextHarness();
    const eventLog: string[] = [];

    videoFactory.supportHandler = async (cfg) => cfg.hardwareAcceleration !== "prefer-hardware";
    videoFactory.onConfiguredHook = () => {
      eventLog.push("reconfigured");
    };

    const controller = new PlaybackController({
      transport,
      onRequestStreamReset: () => {
        eventLog.push("reset_requested");
      },
      clock,
      videoDecoderFactory: videoFactory,
      audioDecoderFactory: audioFactory,
      audioContextFactory: audioHarness.factory,
    });
    const canvas = new FakeCanvasElement();
    controller.attachCanvas(canvas);
    controller.dispatchStreamingEvent({ type: "SESSION_ACTIVATED", streamEpoch: 1 });
    await controller.unlockAudioOnGesture();

    controller.handleMediaFrame(makeVideoFrame(1, 0, VIDEO_FLAG.CONFIG, SAMPLE_ANNEXB_SPS_PPS));
    controller.handleMediaFrame(makeAudioFrame(1, 0, AUDIO_FLAG.CONFIG, SAMPLE_OPUS_HEAD));
    await flushMicrotasks();

    expect(videoFactory.probedConfigs.slice(0, 3)).toEqual([
      expect.objectContaining({
        hardwareAcceleration: "prefer-hardware",
        optimizeForLatency: true,
      }),
      expect.objectContaining({
        hardwareAcceleration: "prefer-hardware",
      }),
      expect.objectContaining({
        optimizeForLatency: true,
      }),
    ]);

    // Delta before keyframe in epoch 1 must be discarded.
    controller.handleMediaFrame(makeVideoFrame(1, 33_333, VIDEO_FLAG.AVCC));
    expect(canvas.drawnTimestamps).toEqual([]);
    expect(controller.getStatsSnapshot().waitingForKeyframe).toBe(true);

    // Keyframe unlocks delta decoding; decode queue overflow drops delta & resets keyframe gate without losing activeEpoch.
    controller.handleMediaFrame(makeVideoFrame(1, 66_666, VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC));
    expect(canvas.drawnTimestamps).toEqual([66_666]);
    expect(controller.getStatsSnapshot().waitingForKeyframe).toBe(false);

    videoFactory.simulatedQueueSize = 14;
    controller.handleMediaFrame(makeVideoFrame(1, 100_000, VIDEO_FLAG.AVCC));
    videoFactory.simulatedQueueSize = 0;
    const overflowSnap = controller.getStatsSnapshot();
    expect(overflowSnap.waitingForKeyframe).toBe(true);
    expect(overflowSnap.droppedFramesDelta).toBe(1);

    // Subsequent delta in epoch 1 is blocked until next keyframe, and epoch 0 stale frames stay rejected.
    controller.handleMediaFrame(makeVideoFrame(1, 133_333, VIDEO_FLAG.AVCC));
    controller.handleMediaFrame(makeVideoFrame(0, 133_333, VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC));
    expect(canvas.drawnTimestamps).toEqual([66_666]);
    controller.handleMediaFrame(makeVideoFrame(1, 166_666, VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC));
    clock.advanceBy(100);
    expect(canvas.drawnTimestamps).toEqual([66_666, 166_666]);

    // Advance to streamEpoch = 2 via resetForNewEpoch (flows through STREAM_RESET -> streamingState.streamEpoch stays synced).
    const epoch1Decoder = videoFactory.getLatestInstance();
    controller.resetForNewEpoch(2);
    expect(controller.getStreamingState().streamEpoch).toBe(2);
    expect(controller.getStatsSnapshot().waitingForKeyframe).toBe(true);

    controller.handleMediaFrame(makeVideoFrame(1, 200_000, VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC));
    controller.handleMediaFrame(makeAudioFrame(1, 200_000));
    expect(epoch1Decoder?.state).toBe("closed");

    const stragglerFrame = new TrackedVideoFrame(200_000);
    epoch1Decoder?.emitOutput(stragglerFrame);
    expect(stragglerFrame.closed).toBe(true);
    expect(canvas.drawnTimestamps).not.toContain(200_000);

    // Configure epoch 2 and verify error recovery runs reconfigure BEFORE onNeedsReset after 150 ms.
    eventLog.length = 0;
    controller.handleMediaFrame(makeVideoFrame(2, 0, VIDEO_FLAG.CONFIG, SAMPLE_ANNEXB_SPS_PPS));
    await flushMicrotasks();
    expect(eventLog).toEqual(["reconfigured"]);
    eventLog.length = 0;

    controller.handleMediaFrame(makeVideoFrame(2, 33_333, VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC));
    const epoch2Decoder = videoFactory.getLatestInstance();
    epoch2Decoder?.emitError(new Error("hardware decode fault"));
    expect(epoch2Decoder?.state).toBe("closed");
    expect(controller.getStatsSnapshot().decoderErrorsDelta).toBe(1);

    clock.advanceBy(VIDEO_DECODER_CONSTANTS.errorRecoveryDelayMs - 1);
    expect(eventLog).toEqual([]);

    clock.advanceBy(1);
    await flushMicrotasks();
    expect(eventLog).toEqual(["reconfigured", "reset_requested"]);

    // Entering STANDBY within 150ms of decoder error must cancel recovery timer and stop scheduled audio.
    eventLog.length = 0;
    controller.handleMediaFrame(makeAudioFrame(2, 0, AUDIO_FLAG.CONFIG, SAMPLE_OPUS_HEAD));
    await flushMicrotasks();
    for (let i = 0; i < 9; i += 1) {
      controller.handleMediaFrame(makeAudioFrame(2, i * 20_000));
    }
    expect(audioHarness.scheduledSources.length).toBe(9);
    videoFactory.getLatestInstance()?.emitError(new Error("second fault"));
    controller.dispatchStreamingEvent({ type: "POWER_SLEEP" });
    expect(audioHarness.scheduledSources.every((s) => s.isStopped())).toBe(true);
    clock.advanceBy(VIDEO_DECODER_CONSTANTS.errorRecoveryDelayMs + 50);
    await flushMicrotasks();
    expect(eventLog).toEqual([]);

    // Concurrent configure(A) then configure(B) must let newer B win when A resolves later.
    const concurrentFactory = new FakeVideoDecoderFactory();
    let resolveProbeA: ((supported: boolean) => void) | undefined;
    let resolveProbeB: ((supported: boolean) => void) | undefined;
    let probeCall = 0;
    concurrentFactory.supportHandler = () => {
      probeCall += 1;
      if (probeCall === 1) {
        return new Promise<boolean>((resolve) => {
          resolveProbeA = resolve;
        });
      }
      return new Promise<boolean>((resolve) => {
        resolveProbeB = resolve;
      });
    };
    const concurrentPipeline = new VideoDecoderPipeline(
      {
        onFrame: (frame) => frame.close(),
        onDecoderError: () => {},
        onNeedsReset: () => {},
      },
      { clock, decoderFactory: concurrentFactory },
    );
    const configA = makeAvcAnnexBConfig(0x42, 0x1e); // avc1.42c01e
    const configB = makeAvcAnnexBConfig(0x64, 0x28); // avc1.64c028
    const promiseA = concurrentPipeline.configure(configA, 1);
    const promiseB = concurrentPipeline.configure(configB, 1);
    resolveProbeB?.(true);
    resolveProbeA?.(true);
    expect(await promiseB).toBe(true);
    expect(await promiseA).toBe(false);
    expect(concurrentFactory.getLatestInstance()?.configuredWith?.codec).toBe("avc1.64c028");

    controller.dispose();
    concurrentPipeline.dispose();
  });

  it("AC-03: separates LIVE and CATCHUP queues, keeps audio 1.0x gain 0.88 without underrun or anchor drift on repeated <40 ms jitter, enforces stall buffering vs static screen guard with 450 ms auto-release, and keeps primary mute feedback active", async () => {
    const liveQueue = new LiveVideoQueue(4);
    const liveFrames: TrackedVideoFrame[] = [];
    for (let i = 0; i < 7; i += 1) {
      const f = new TrackedVideoFrame(i * 33_333);
      liveFrames.push(f);
      liveQueue.push({ streamEpoch: 1, ptsUs: f.timestamp, frame: f, receivedAtMs: i * 33 });
    }
    expect(liveQueue.getMetrics().count).toBe(4);
    expect(liveQueue.consumeEvictedCount()).toBe(3);
    expect(liveFrames.slice(0, 3).every((f) => f.closed)).toBe(true);
    liveQueue.clearAndCloseAll();
    expect(liveFrames.every((f) => f.closed)).toBe(true);

    const catchupQueue = new CatchupVideoQueue();
    const bigFrameA = new TrackedVideoFrame(0, 1920, 1080, 33_333, 30 * 1024 * 1024);
    const bigFrameB = new TrackedVideoFrame(33_333, 1920, 1080, 33_333, 30 * 1024 * 1024);
    catchupQueue.push({ streamEpoch: 1, ptsUs: 0, frame: bigFrameA, receivedAtMs: 0 });
    catchupQueue.push({ streamEpoch: 1, ptsUs: 33_333, frame: bigFrameB, receivedAtMs: 33 });
    expect(catchupQueue.getMetrics().estimatedBytes).toBeLessThanOrEqual(48 * 1024 * 1024);
    expect(bigFrameA.closed).toBe(true);
    expect(bigFrameB.closed).toBe(false);
    catchupQueue.clearAndCloseAll();
    expect(bigFrameB.closed).toBe(true);

    // LIVE stays LIVE on SOCKET_CONGESTED; CATCHUP flushes on USER_INTERACTION.
    const clock = new FakeClock(30_000);
    const transport = new FakeWsTransport();
    const videoFactory = new FakeVideoDecoderFactory();
    const audioFactory = new FakeAudioDecoderFactory();
    const audioHarness = new FakeAudioContextHarness();
    let resetCalls = 0;

    const controller = new PlaybackController({
      transport,
      onRequestStreamReset: () => {
        resetCalls += 1;
      },
      clock,
      videoDecoderFactory: videoFactory,
      audioDecoderFactory: audioFactory,
      audioContextFactory: audioHarness.factory,
    });
    controller.attachCanvas(new FakeCanvasElement());

    controller.dispatchStreamingEvent({ type: "SESSION_ACTIVATED", streamEpoch: 1 });
    expect(selectSyncPolicy(controller.getStreamingState())).toBe("MASTER_CLOCK");
    controller.dispatchStreamingEvent({ type: "SOCKET_CONGESTED" });
    expect(controller.getStreamingState().kind).toBe("LIVE");

    controller.dispatchStreamingEvent({
      type: "SESSION_ACTIVATED",
      streamEpoch: 2,
      resumeCatchup: { targetBufferMs: 10_000, resumePtsUs: 0 },
    });
    expect(controller.getStreamingState().kind).toBe("CATCHUP");
    videoFactory.autoOutput = false;
    controller.handleMediaFrame(makeVideoFrame(2, 0, VIDEO_FLAG.CONFIG, SAMPLE_ANNEXB_SPS_PPS));
    await flushMicrotasks();
    controller.handleMediaFrame(makeVideoFrame(2, 0, VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC));
    controller.handleMediaFrame(makeVideoFrame(2, 33_333, VIDEO_FLAG.AVCC));
    const catchupFrame1 = new TrackedVideoFrame(0);
    const catchupFrame2 = new TrackedVideoFrame(33_333);
    videoFactory.getLatestInstance()?.emitOutput(catchupFrame1);
    videoFactory.getLatestInstance()?.emitOutput(catchupFrame2);
    controller.dispatchStreamingEvent({
      type: "USER_INTERACTION",
      atMs: clock.nowMs(),
      newStreamEpoch: 3,
    });
    expect(controller.getStreamingState().kind).toBe("INTERACTIVE");
    expect(catchupFrame1.closed).toBe(true);
    expect(catchupFrame2.closed).toBe(true);

    // Primary mute (setAudioEnabled(false) while isPrimaryAuthority=true) keeps PLAYBACK_FEEDBACK & reset alive;
    // Secondary (setPrimaryAuthority(false)) suppresses both.
    videoFactory.autoOutput = true;
    controller.handleMediaFrame(makeVideoFrame(3, 0, VIDEO_FLAG.CONFIG, SAMPLE_ANNEXB_SPS_PPS));
    await flushMicrotasks();
    controller.setAudioEnabled(false);
    controller.handleMediaFrame(makeVideoFrame(3, 500_000, VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC));
    clock.advanceBy(PROTOCOL_TIMING.feedbackIntervalMs);
    const sentWhileMuted = transport.sentFrames.length;
    expect(sentWhileMuted).toBeGreaterThan(0);
    const feedbackMsg = decodeClientControlFrame(
      transport.sentFrames[sentWhileMuted - 1] ?? new Uint8Array(0),
    );
    expect(feedbackMsg).toEqual(
      expect.objectContaining({
        type: "PLAYBACK_FEEDBACK",
        streamEpoch: 3,
        renderedPtsUs: 500_000,
      }),
    );

    controller.setPrimaryAuthority(false);
    clock.advanceBy(PROTOCOL_TIMING.feedbackIntervalMs);
    expect(transport.sentFrames.length).toBe(sentWhileMuted);
    videoFactory.getLatestInstance()?.emitError(new Error("secondary fault"));
    clock.advanceBy(VIDEO_DECODER_CONSTANTS.errorRecoveryDelayMs);
    await flushMicrotasks();
    expect(resetCalls).toBe(0);

    // AudioPlayerPipeline: 1.0x, gain 0.88, idempotent Opus reconfig, repeated <40 ms jitter without anchor drift.
    const standaloneAudioHarness = new FakeAudioContextHarness();
    const standaloneAudioFactory = new FakeAudioDecoderFactory();
    const player = new AudioPlayerPipeline({
      clock,
      decoderFactory: standaloneAudioFactory,
      audioContextFactory: standaloneAudioHarness.factory,
    });
    await player.unlock();
    expect(standaloneAudioHarness.createdOptions[0]).toEqual({
      latencyHint: "interactive",
      sampleRate: AUDIO_PLAYER_CONSTANTS.sampleRate,
    });
    expect(standaloneAudioHarness.gainNodes[0]?.gain.value).toBeCloseTo(
      AUDIO_PLAYER_CONSTANTS.defaultGain,
      5,
    );

    expect(await player.configure(SAMPLE_OPUS_HEAD, 1)).toBe(true);
    for (let i = 0; i < 9; i += 1) {
      player.decode(new Uint8Array([0xfc]), i * 20_000, 1);
    }
    expect(standaloneAudioHarness.scheduledSources.length).toBe(9);
    expect(
      standaloneAudioHarness.scheduledSources.every(
        (entry) => entry.source.playbackRate.value === 1.0,
      ),
    ).toBe(true);

    const countBeforeReconfig = standaloneAudioFactory.configureCount;
    expect(await player.configure(SAMPLE_OPUS_HEAD, 1)).toBe(true);
    expect(standaloneAudioFactory.configureCount).toBe(countBeforeReconfig);

    // 3 repeated 30 ms (< 40 ms) jitter gaps: underrunCount stays 0, gain stays 0.88, and anchor stays synchronized!
    // Initial scheduled end = 0.025 + 0.180 = 0.205s.
    standaloneAudioHarness.currentTimeSec = 0.235; // 30ms gap
    player.decode(new Uint8Array([0xfc]), 9 * 20_000, 1); // pts 180ms..200ms scheduled at 0.235..0.255
    standaloneAudioHarness.currentTimeSec = 0.285; // 30ms gap
    player.decode(new Uint8Array([0xfc]), 10 * 20_000, 1); // pts 200ms..220ms scheduled at 0.285..0.305
    standaloneAudioHarness.currentTimeSec = 0.335; // 30ms gap
    player.decode(new Uint8Array([0xfc]), 11 * 20_000, 1); // pts 220ms..240ms scheduled at 0.335..0.355
    expect(player.getUnderrunCount()).toBe(0);
    expect(standaloneAudioHarness.gainNodes[0]?.gain.value).toBeCloseTo(
      AUDIO_PLAYER_CONSTANTS.defaultGain,
      5,
    );
    // At currentTimeSec = 0.345s (10ms into chunk 11 which spans 220ms..240ms), playbackPtsUs must be 230_000 us (no 90ms error!).
    standaloneAudioHarness.currentTimeSec = 0.345;
    expect(player.getPlaybackPtsUs()).toBeCloseTo(230_000, -1);

    // > 40ms gap triggers underrun cleanly.
    standaloneAudioHarness.currentTimeSec = 0.41;
    player.decode(new Uint8Array([0xfc]), 12 * 20_000, 1);
    expect(player.getUnderrunCount()).toBe(1);

    // Network stall buffering while audio IS running (RTT spike >= 90ms + arrival gap >= 120ms) vs static screen guard.
    const stallClock = new MasterSyncClock();
    stallClock.recordRttSample(30);
    stallClock.recordRttSample(30);
    stallClock.recordRttSample(30);
    stallClock.recordVideoArrival(0, true);
    stallClock.recordVideoArrival(33, true);
    // Static screen while audio is running (no RTT jump): gap >= 120ms must NOT trigger stall cushion or buffering.
    stallClock.recordVideoArrival(333, true);
    stallClock.notifyVideoQueueEmpty(340, true);
    expect(stallClock.getJitterState()).toEqual({
      adaptiveDelayMs: 0,
      stallCushionMs: 0,
      isBuffering: false,
    });

    // Post-recovery decay test: even when adaptiveDelayMs > 0 from earlier jitter, healthy RTT on static screen does NOT trigger buffering.
    const decayClock = new MasterSyncClock();
    decayClock.recordVideoArrival(0, true);
    decayClock.recordVideoArrival(10, true);
    decayClock.recordVideoArrival(20, true);
    decayClock.recordVideoArrival(30, true);
    decayClock.recordVideoArrival(250, true); // video arrival jitter gives adaptiveDelayMs > 0
    decayClock.recordRttSample(25);
    decayClock.recordRttSample(25);
    decayClock.recordRttSample(25);
    expect(decayClock.getJitterState().adaptiveDelayMs).toBeGreaterThan(0);
    decayClock.recordVideoArrival(500, true);
    decayClock.notifyVideoQueueEmpty(510, true);
    expect(decayClock.getJitterState().isBuffering).toBe(false);

    // True network stall with RTT increase (>= +90 ms jump) while audio IS running activates buffering and 450ms auto-release!
    stallClock.recordRttSample(160);
    stallClock.recordVideoArrival(500, true);
    stallClock.notifyVideoQueueEmpty(510, true);
    expect(stallClock.getJitterState().stallCushionMs).toBeGreaterThanOrEqual(180);
    expect(stallClock.getJitterState().isBuffering).toBe(true);

    // Verify AudioPlayerPipeline 450 ms auto-release timer unholds and resumes scheduling automatically.
    const holdAudioHarness = new FakeAudioContextHarness();
    const holdPlayer = new AudioPlayerPipeline({
      clock,
      decoderFactory: new FakeAudioDecoderFactory(),
      audioContextFactory: holdAudioHarness.factory,
    });
    await holdPlayer.unlock();
    await holdPlayer.configure(SAMPLE_OPUS_HEAD, 1);
    holdPlayer.setHoldForVideoBuffering(true);
    for (let i = 0; i < 9; i += 1) {
      holdPlayer.decode(new Uint8Array([0xfc]), i * 20_000, 1);
    }
    expect(holdAudioHarness.scheduledSources.length).toBe(0);
    clock.advanceBy(449);
    expect(holdAudioHarness.scheduledSources.length).toBe(0);
    clock.advanceBy(1);
    expect(holdAudioHarness.scheduledSources.length).toBe(9);

    controller.dispose();
    player.dispose();
    holdPlayer.dispose();
  });

  it("AC-04: converges |avDriftMs| <= 60 ms within 4 seconds via video-only master-clock sync after DIRECT_LIVE->LIVE, 2s burst, +1,500 ms video ahead, and -1,500 ms video lag without hunting for 8+ seconds and preserves mode on early new-epoch frames", async () => {
    const runConvergenceScenario = async (
      scenario: "DIRECT_TO_LIVE" | "BURST_2S" | "AHEAD_1500MS" | "LAG_1500MS",
    ) => {
      const clock = new FakeClock(100_000);
      const transport = new FakeWsTransport();
      const videoFactory = new FakeVideoDecoderFactory();
      const audioFactory = new FakeAudioDecoderFactory();
      const audioHarness = new FakeAudioContextHarness();
      let resetCalls = 0;

      const controller = new PlaybackController({
        transport,
        onRequestStreamReset: () => {
          resetCalls += 1;
        },
        clock,
        videoDecoderFactory: videoFactory,
        audioDecoderFactory: audioFactory,
        audioContextFactory: audioHarness.factory,
      });
      controller.attachCanvas(new FakeCanvasElement());
      controller.dispatchStreamingEvent({ type: "SESSION_ACTIVATED", streamEpoch: 1 });
      await controller.unlockAudioOnGesture();
      controller.handleMediaFrame(makeVideoFrame(1, 0, VIDEO_FLAG.CONFIG, SAMPLE_ANNEXB_SPS_PPS));
      controller.handleMediaFrame(makeAudioFrame(1, 0, AUDIO_FLAG.CONFIG, SAMPLE_OPUS_HEAD));
      await flushMicrotasks();

      let audioProducedMs = 0;
      const pumpAudioTo = (targetAudioMs: number) => {
        while (audioProducedMs < targetAudioMs) {
          controller.handleMediaFrame(makeAudioFrame(1, audioProducedMs * 1_000));
          audioProducedMs += 20;
        }
      };

      pumpAudioTo(200);
      audioHarness.currentTimeSec = AUDIO_PLAYER_CONSTANTS.scheduleLookaheadMs / 1_000;

      let mediaClockMs = 0;
      const advanceAudioAndClock = (dtMs: number) => {
        const steps = Math.max(1, Math.ceil(dtMs / 10));
        const stepMs = dtMs / steps;
        for (let i = 0; i < steps; i += 1) {
          mediaClockMs += stepMs;
          clock.advanceBy(stepMs);
          audioHarness.currentTimeSec += stepMs / 1_000;
          pumpAudioTo(mediaClockMs + 200);
        }
      };

      const step30fpsWithAudio = (durationMs: number, videoOffsetMs = 0) => {
        const steps = Math.round(durationMs / 33);
        for (let s = 0; s < steps; s += 1) {
          advanceAudioAndClock(33);
          controller.handleMediaFrame(
            makeVideoFrame(
              1,
              Math.round((mediaClockMs + videoOffsetMs) * 1_000),
              s === 0 ? VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC : VIDEO_FLAG.AVCC,
            ),
          );
        }
      };

      controller.handleMediaFrame(makeVideoFrame(1, 0, VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC));
      let totalDrops = 0;

      if (scenario === "DIRECT_TO_LIVE") {
        // Natural INTERACTIVE -> LIVE convergence: video runs +350ms ahead in INTERACTIVE, then 4,000ms timeout enters LIVE.
        controller.dispatchStreamingEvent({
          type: "USER_INTERACTION",
          atMs: clock.nowMs(),
          newStreamEpoch: 1,
        });
        step30fpsWithAudio(500, 350);
        advanceAudioAndClock(INTERACTION_TIMEOUT_MS);
        expect(controller.getStreamingState().kind).toBe("LIVE");
        // Resuming normal 1x video frames converges within 4s via WAIT/render pacing.
        step30fpsWithAudio(1_000, 0);
      } else if (scenario === "BURST_2S") {
        step30fpsWithAudio(500);
        advanceAudioAndClock(2_000);
        for (let i = 0; i < 30; i += 1) {
          controller.handleMediaFrame(
            makeVideoFrame(1, Math.round((mediaClockMs - 2_000 + i * 33) * 1_000), VIDEO_FLAG.AVCC),
          );
        }
        controller.handleMediaFrame(
          makeVideoFrame(
            1,
            Math.round(mediaClockMs * 1_000),
            VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC,
          ),
        );
        step30fpsWithAudio(1_000);
      } else if (scenario === "AHEAD_1500MS") {
        // Video +1,500 ms ahead -> waits for audio 1.0x catch-up without dropping frames, then converges <= 60ms within 4s.
        step30fpsWithAudio(500);
        controller.handleMediaFrame(
          makeVideoFrame(1, Math.round((mediaClockMs + 1_500) * 1_000), VIDEO_FLAG.AVCC),
        );
        expect(controller.getStatsSnapshot().avDriftMs).toBeGreaterThan(1_400);
        advanceAudioAndClock(2_000);
        step30fpsWithAudio(1_000);
      } else {
        // Video -1,500 ms behind -> drops late frames and converges <= 60ms within 4s.
        step30fpsWithAudio(500);
        for (let i = 0; i < 45; i += 1) {
          controller.handleMediaFrame(
            makeVideoFrame(1, Math.round((mediaClockMs - 1_500 + i * 33) * 1_000), VIDEO_FLAG.AVCC),
          );
        }
        controller.handleMediaFrame(
          makeVideoFrame(
            1,
            Math.round(mediaClockMs * 1_000),
            VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC,
          ),
        );
        step30fpsWithAudio(1_000);
      }

      const afterConverge = controller.getStatsSnapshot();
      totalDrops += afterConverge.droppedFramesDelta;
      expect(Math.abs(afterConverge.avDriftMs)).toBeLessThanOrEqual(60);
      if (scenario === "BURST_2S" || scenario === "LAG_1500MS") {
        expect(totalDrops).toBeGreaterThan(0);
      } else if (scenario === "AHEAD_1500MS") {
        expect(totalDrops).toBe(0);
      }

      for (let sec = 0; sec < 9; sec += 1) {
        step30fpsWithAudio(1_000);
        const snap = controller.getStatsSnapshot();
        totalDrops += snap.droppedFramesDelta;
        expect(Math.abs(snap.avDriftMs)).toBeLessThanOrEqual(60);
      }
      expect(resetCalls).toBe(0);
      controller.dispose();
    };

    await runConvergenceScenario("DIRECT_TO_LIVE");
    await runConvergenceScenario("BURST_2S");
    await runConvergenceScenario("AHEAD_1500MS");
    await runConvergenceScenario("LAG_1500MS");

    // Early new-epoch media frame during INTERACTIVE must NOT rewind INTERACTIVE back to LIVE.
    const earlyClock = new FakeClock(60_000);
    const earlyController = new PlaybackController({
      transport: new FakeWsTransport(),
      onRequestStreamReset: () => {},
      clock: earlyClock,
      videoDecoderFactory: new FakeVideoDecoderFactory(),
      audioDecoderFactory: new FakeAudioDecoderFactory(),
      audioContextFactory: new FakeAudioContextHarness().factory,
    });
    earlyController.dispatchStreamingEvent({ type: "SESSION_ACTIVATED", streamEpoch: 1 });
    earlyController.dispatchStreamingEvent({
      type: "USER_INTERACTION",
      atMs: earlyClock.nowMs(),
      newStreamEpoch: 1,
    });
    expect(earlyController.getStreamingState().kind).toBe("INTERACTIVE");
    earlyController.handleMediaFrame(
      makeVideoFrame(2, 0, VIDEO_FLAG.CONFIG, SAMPLE_ANNEXB_SPS_PPS),
    );
    expect(earlyController.getStreamingState().kind).toBe("INTERACTIVE");
    expect(earlyController.getStreamingState().streamEpoch).toBe(2);
    earlyController.dispose();

    // Secondary sync follows fresh (< 5s) PrimarySyncMetadata and rejects stale (>= 5s).
    const secClock = new FakeClock(50_000);
    const secSync = new MasterSyncClock();
    secSync.updateSecondaryPrimaryRef(
      {
        primaryRenderedPts: 2_000_000,
        primaryFeedbackAgeMs: 100,
        primaryTargetBufferMs: 10_000,
        primaryMode: "LIVE",
      },
      secClock.nowMs(),
    );
    expect(secSync.getMasterClockSnapshot(secClock.nowMs()).source).toBe("PRIMARY_REF");
    expect(secSync.getMasterClockSnapshot(secClock.nowMs()).audioPlaybackPtsUs).toBe(2_100_000);

    secClock.advanceBy(PROTOCOL_TIMING.primaryFeedbackMaxAgeMs);
    expect(secSync.getMasterClockSnapshot(secClock.nowMs()).valid).toBe(false);
  });

  it("AC-05: reports true signed avDriftMs even beyond 5,000 ms without relative fallback or zero-reset concealment", async () => {
    const syncClock = new MasterSyncClock();
    expect(syncClock.computeSignedAvDriftMs(11_500_000, 5_000_000)).toBe(6_500);
    expect(syncClock.computeSignedAvDriftMs(2_000_000, 9_250_000)).toBe(-7_250);

    syncClock.updateLocalAudioClock(5_000_000, 1_000);
    const aheadEval = syncClock.evaluateVideoFrame(11_500_000, 1_000);
    expect(aheadEval.action).toBe("WAIT");
    expect(aheadEval.signedDriftMs).toBe(6_500);

    const behindEval = syncClock.evaluateVideoFrame(1_000_000, 1_000);
    expect(behindEval.action).toBe("DROP_LATE");
    expect(behindEval.signedDriftMs).toBe(-4_000);

    const clock = new FakeClock(10_000);
    const audioHarness = new FakeAudioContextHarness();
    const primaryAudio = new FakeAudioContextHarness();

    const primaryCtrl = new PlaybackController({
      transport: new FakeWsTransport(),
      onRequestStreamReset: () => {},
      clock,
      videoDecoderFactory: new FakeVideoDecoderFactory(),
      audioDecoderFactory: new FakeAudioDecoderFactory(),
      audioContextFactory: primaryAudio.factory,
    });
    primaryCtrl.attachCanvas(new FakeCanvasElement());
    primaryCtrl.dispatchStreamingEvent({ type: "SESSION_ACTIVATED", streamEpoch: 1 });
    await primaryCtrl.unlockAudioOnGesture();
    primaryCtrl.handleMediaFrame(makeVideoFrame(1, 0, VIDEO_FLAG.CONFIG, SAMPLE_ANNEXB_SPS_PPS));
    primaryCtrl.handleMediaFrame(makeAudioFrame(1, 0, AUDIO_FLAG.CONFIG, SAMPLE_OPUS_HEAD));
    await flushMicrotasks();

    for (let i = 0; i < 9; i += 1) {
      primaryCtrl.handleMediaFrame(makeAudioFrame(1, i * 20_000));
    }
    primaryAudio.currentTimeSec = AUDIO_PLAYER_CONSTANTS.scheduleLookaheadMs / 1_000;

    primaryCtrl.handleMediaFrame(
      makeVideoFrame(1, 6_500_000, VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC),
    );
    expect(primaryCtrl.getStatsSnapshot().avDriftMs).toBe(6_500);
    primaryCtrl.dispose();

    const secController = new PlaybackController({
      transport: new FakeWsTransport(),
      onRequestStreamReset: () => {},
      clock,
      videoDecoderFactory: new FakeVideoDecoderFactory(),
      audioDecoderFactory: new FakeAudioDecoderFactory(),
      audioContextFactory: audioHarness.factory,
      initialPrimaryAuthority: false,
    });
    secController.attachCanvas(new FakeCanvasElement());
    secController.setAudioEnabled(false);
    secController.dispatchStreamingEvent({ type: "SESSION_ACTIVATED", streamEpoch: 1 });
    secController.handleMediaFrame(makeVideoFrame(1, 0, VIDEO_FLAG.CONFIG, SAMPLE_ANNEXB_SPS_PPS));
    await flushMicrotasks();
    secController.updatePrimarySyncRef({
      primaryRenderedPts: 7_250_000,
      primaryFeedbackAgeMs: 0,
      primaryTargetBufferMs: 10_000,
      primaryMode: "LIVE",
    });
    secController.handleMediaFrame(makeVideoFrame(1, 0, VIDEO_FLAG.KEYFRAME | VIDEO_FLAG.AVCC));
    expect(secController.getStatsSnapshot().avDriftMs).toBe(-7_250);
    secController.dispose();
  });
});
