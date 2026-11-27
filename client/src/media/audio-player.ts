import { STREAM_EPOCH_INITIAL } from "@tesroid/shared";
import {
  type ClientClock,
  type ClientTimerHandle,
  createBrowserClock,
} from "../transport/ports.js";
import type {
  AudioBufferLike,
  AudioBufferSourceNodeLike,
  AudioContextFactory,
  AudioContextLike,
  AudioDataLike,
  AudioDecoderAdapter,
  AudioDecoderConfigSpec,
  AudioDecoderFactory,
  AudioGainNodeLike,
} from "./ports.js";
import { SYNC_CLOCK_CONSTANTS } from "./sync-clock.js";

export const AUDIO_PLAYER_CONSTANTS = {
  sampleRate: 48_000,
  channels: 2,
  defaultGain: 0.88,
  declickFadeMs: 1,
  initialCushionMs: 160,
  underrunGapMs: 40,
  underrunRebufferMs: 80,
  scheduleLookaheadMs: 25,
  maxScheduleLookaheadMs: 500,
  maxBufferedMs: 45_000,
} as const;

export interface AudioPlayerPipelineOptions {
  readonly clock?: ClientClock;
  readonly decoderFactory?: AudioDecoderFactory;
  readonly audioContextFactory?: AudioContextFactory;
}

interface QueuedPcmChunk {
  readonly ptsUs: number;
  readonly durationUs: number;
  readonly left: Float32Array<ArrayBuffer>;
  readonly right: Float32Array<ArrayBuffer>;
}

function safeCloseAudioData(data: AudioDataLike): void {
  try {
    data.close();
  } catch {
    // Ignore close errors on already-closed AudioData.
  }
}

function safeCloseAudioDecoder(decoder: AudioDecoderAdapter | null): void {
  if (decoder === null) {
    return;
  }
  try {
    if (decoder.state !== "closed") {
      decoder.close();
    }
  } catch {
    // Ignore close errors during reset/dispose.
  }
}

function createBrowserAudioDecoderFactory(): AudioDecoderFactory {
  return {
    async isConfigSupported(config) {
      if (typeof AudioDecoder === "undefined") {
        return false;
      }
      try {
        const support = await AudioDecoder.isConfigSupported(config);
        return support.supported === true;
      } catch {
        return false;
      }
    },
    create(callbacks) {
      const decoder = new AudioDecoder({
        output: (data) => {
          callbacks.onOutput(data);
        },
        error: (err) => {
          callbacks.onError(err instanceof Error ? err : new Error(String(err)));
        },
      });
      return {
        get state() {
          return decoder.state;
        },
        get decodeQueueSize() {
          return decoder.decodeQueueSize;
        },
        configure(config) {
          decoder.configure(config);
        },
        decode(payload, timestampUs) {
          const chunk = new EncodedAudioChunk({
            type: "key",
            timestamp: timestampUs,
            data: new Uint8Array(payload),
          });
          decoder.decode(chunk);
        },
        close() {
          if (decoder.state !== "closed") {
            decoder.close();
          }
        },
      };
    },
  };
}

const defaultBrowserAudioContextFactory: AudioContextFactory = (options) => {
  const ctx = new AudioContext({
    latencyHint: options.latencyHint,
    sampleRate: options.sampleRate,
  });
  const gainMap = new WeakMap<AudioGainNodeLike, GainNode>();
  const bufferMap = new WeakMap<AudioBufferLike, AudioBuffer>();

  return {
    get state() {
      return ctx.state;
    },
    get currentTime() {
      return ctx.currentTime;
    },
    get sampleRate() {
      return ctx.sampleRate;
    },
    destination: ctx.destination,
    resume: () => ctx.resume(),
    close: () => ctx.close(),
    createGain: () => {
      const node = ctx.createGain();
      const wrapper: AudioGainNodeLike = {
        gain: node.gain,
        connect: (destination) => {
          if (destination === ctx.destination) {
            node.connect(ctx.destination);
          }
        },
        disconnect: () => node.disconnect(),
      };
      gainMap.set(wrapper, node);
      return wrapper;
    },
    createBuffer: (channels, length, sampleRate) => {
      const buf = ctx.createBuffer(channels, length, sampleRate);
      bufferMap.set(buf, buf);
      return buf;
    },
    createBufferSource: () => {
      const src = ctx.createBufferSource();
      let currentBuffer: AudioBufferLike | null = null;
      let onEndedCallback: (() => void) | null = null;
      const wrapper: AudioBufferSourceNodeLike = {
        get buffer() {
          return currentBuffer;
        },
        set buffer(value) {
          currentBuffer = value;
          src.buffer = value !== null ? (bufferMap.get(value) ?? null) : null;
        },
        playbackRate: src.playbackRate,
        connect: (destination) => {
          const realGain = gainMap.get(destination);
          if (realGain !== undefined) {
            src.connect(realGain);
          }
        },
        disconnect: () => src.disconnect(),
        start: (when) => src.start(when),
        stop: (when) => src.stop(when),
        get onended(): (() => void) | null {
          return onEndedCallback;
        },
        set onended(cb: (() => void) | null) {
          onEndedCallback = cb;
          src.onended = cb ? () => cb() : null;
        },
      };
      return wrapper;
    },
  };
};

function extractStereoPcm(
  data: AudioDataLike,
): { readonly left: Float32Array<ArrayBuffer>; readonly right: Float32Array<ArrayBuffer> } | null {
  const frames = data.numberOfFrames;
  const channels = data.numberOfChannels;
  if (frames <= 0 || channels <= 0) {
    return null;
  }

  const left = new Float32Array(frames);
  const right = new Float32Array(frames);

  if (data.format === "f32") {
    const interleaved = new Float32Array(frames * channels);
    data.copyTo(interleaved, { planeIndex: 0, format: "f32" });
    if (channels === 1) {
      left.set(interleaved);
      right.set(interleaved);
      return { left, right };
    }
    for (let i = 0; i < frames; i += 1) {
      left[i] = interleaved[i * channels] ?? 0;
      right[i] = interleaved[i * channels + 1] ?? 0;
    }
    return { left, right };
  }

  // Planar f32 (default Opus decode output on WebCodecs) and compatible planar conversions.
  data.copyTo(left, { planeIndex: 0, format: "f32-planar" });
  if (channels >= 2) {
    data.copyTo(right, { planeIndex: 1, format: "f32-planar" });
  } else {
    right.set(left);
  }
  return { left, right };
}

function applyDeclickFadeIn(
  left: Float32Array<ArrayBuffer>,
  right: Float32Array<ArrayBuffer>,
  sampleRate: number,
): void {
  const fadeSamples = Math.min(
    left.length,
    Math.max(1, Math.round((sampleRate * AUDIO_PLAYER_CONSTANTS.declickFadeMs) / 1_000)),
  );
  for (let i = 0; i < fadeSamples; i += 1) {
    const scale = i / fadeSamples;
    left[i] = (left[i] ?? 0) * scale;
    right[i] = (right[i] ?? 0) * scale;
  }
}

export class AudioPlayerPipeline {
  private readonly clock: ClientClock;
  private readonly decoderFactory: AudioDecoderFactory;
  private readonly audioContextFactory: AudioContextFactory;

  private activeEpoch: number = STREAM_EPOCH_INITIAL;
  private decoderGen = 0;
  private decoder: AudioDecoderAdapter | null = null;
  private configured = false;
  private disposed = false;

  private ctx: AudioContextLike | null = null;
  private gainNode: AudioGainNodeLike | null = null;
  private readonly activeSources = new Set<AudioBufferSourceNodeLike>();
  private readonly pcmQueue: QueuedPcmChunk[] = [];
  private queuedDurationUs = 0;

  private muted = false;
  private targetGain: number = AUDIO_PLAYER_CONSTANTS.defaultGain;
  private adaptiveDelayMs = 0;
  private holdForVideoBuffering = false;
  private holdStartedAtMs: number | null = null;
  private holdTimer: ClientTimerHandle | null = null;

  private playing = false;
  private needsDeclickFade = true;
  private rebufferThresholdMs: number = AUDIO_PLAYER_CONSTANTS.initialCushionMs;
  private nextScheduleCtxTimeSec = 0;
  private anchorCtxTimeSec: number | null = null;
  private anchorPtsUs: number | null = null;
  private lastScheduledEndPtsUs: number | null = null;
  private underrunCount = 0;

  constructor(options: AudioPlayerPipelineOptions = {}) {
    this.clock = options.clock ?? createBrowserClock();
    this.decoderFactory = options.decoderFactory ?? createBrowserAudioDecoderFactory();
    this.audioContextFactory = options.audioContextFactory ?? defaultBrowserAudioContextFactory;
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  async unlock(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.ensureAudioContext();
    if (this.ctx === null) {
      return;
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    this.drainSchedule();
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  async configure(opusHeadBytes: Uint8Array, streamEpoch: number): Promise<boolean> {
    if (this.disposed || streamEpoch < this.activeEpoch) {
      return false;
    }

    // Same-epoch Opus CONFIG retransmission is idempotent so audio plays continuously without gaps.
    if (
      streamEpoch === this.activeEpoch &&
      this.configured &&
      this.decoder !== null &&
      this.decoder.state === "configured"
    ) {
      return true;
    }

    if (streamEpoch > this.activeEpoch) {
      this.resetForNewEpoch(streamEpoch);
    }

    this.ensureAudioContext();

    const probeGen = ++this.decoderGen;
    const config: AudioDecoderConfigSpec = {
      codec: "opus",
      sampleRate: AUDIO_PLAYER_CONSTANTS.sampleRate,
      numberOfChannels: AUDIO_PLAYER_CONSTANTS.channels,
      description: new Uint8Array(opusHeadBytes),
    };

    let supported = false;
    try {
      supported = await this.decoderFactory.isConfigSupported(config);
    } catch {
      supported = false;
    }
    if (
      !supported ||
      this.disposed ||
      probeGen !== this.decoderGen ||
      streamEpoch !== this.activeEpoch
    ) {
      return false;
    }

    safeCloseAudioDecoder(this.decoder);
    const boundEpoch = streamEpoch;

    const adapter = this.decoderFactory.create({
      onOutput: (audioData) => {
        this.handleDecodedAudioData(audioData, probeGen, boundEpoch);
      },
      onError: () => {
        if (probeGen === this.decoderGen) {
          this.configured = false;
        }
      },
    });

    try {
      adapter.configure(config);
      this.decoder = adapter;
      this.configured = true;
      return true;
    } catch {
      safeCloseAudioDecoder(adapter);
      this.configured = false;
      return false;
    }
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  decode(opusPayload: Uint8Array, ptsUs: number, streamEpoch: number): void {
    if (
      this.disposed ||
      this.muted ||
      !this.configured ||
      this.decoder === null ||
      this.decoder.state !== "configured" ||
      streamEpoch !== this.activeEpoch
    ) {
      return;
    }

    try {
      this.decoder.decode(opusPayload, ptsUs);
    } catch {
      this.configured = false;
    }
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      if (this.gainNode !== null) {
        this.gainNode.gain.value = 0;
      }
      this.clearPlaybackSchedule();
      return;
    }
    if (this.gainNode !== null) {
      this.gainNode.gain.value = this.targetGain;
    }
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  setGain(gain: number): void {
    if (!Number.isFinite(gain)) {
      return;
    }
    this.targetGain = Math.min(1, Math.max(0, gain));
    if (!this.muted && this.gainNode !== null) {
      this.gainNode.gain.value = this.targetGain;
    }
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  setAdaptiveDelayMs(delayMs: number): void {
    if (!Number.isFinite(delayMs)) {
      return;
    }
    this.adaptiveDelayMs = Math.min(SYNC_CLOCK_CONSTANTS.adaptiveDelayMaxMs, Math.max(0, delayMs));
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  setHoldForVideoBuffering(holding: boolean): void {
    if (holding) {
      if (!this.holdForVideoBuffering && !this.disposed) {
        this.holdForVideoBuffering = true;
        this.holdStartedAtMs = this.clock.nowMs();
        this.armHoldReleaseTimer();
      }
      return;
    }
    this.cancelHoldTimer();
    if (this.holdForVideoBuffering) {
      this.holdForVideoBuffering = false;
      this.holdStartedAtMs = null;
      this.drainSchedule();
    }
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.3
  getPlaybackPtsUs(): number | null {
    if (
      this.disposed ||
      this.muted ||
      !this.playing ||
      this.ctx === null ||
      this.anchorCtxTimeSec === null ||
      this.anchorPtsUs === null
    ) {
      return null;
    }
    const elapsedSec = Math.max(0, this.ctx.currentTime - this.anchorCtxTimeSec);
    const estimatedPtsUs = this.anchorPtsUs + elapsedSec * 1_000_000;
    if (this.lastScheduledEndPtsUs !== null) {
      return Math.min(estimatedPtsUs, this.lastScheduledEndPtsUs);
    }
    return estimatedPtsUs;
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  getBufferedMs(): number {
    const queuedMs = this.queuedDurationUs / 1_000;
    const scheduledMs =
      this.playing && this.ctx !== null
        ? Math.max(0, (this.nextScheduleCtxTimeSec - this.ctx.currentTime) * 1_000)
        : 0;
    return queuedMs + scheduledMs;
  }

  getUnderrunCount(): number {
    return this.underrunCount;
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  resetForNewEpoch(newStreamEpoch: number): void {
    this.decoderGen += 1;
    if (newStreamEpoch >= this.activeEpoch) {
      this.activeEpoch = newStreamEpoch;
    }
    safeCloseAudioDecoder(this.decoder);
    this.decoder = null;
    this.configured = false;
    this.clearPlaybackSchedule();
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.2
  dispose(): void {
    this.disposed = true;
    this.resetForNewEpoch(this.activeEpoch);
    try {
      this.gainNode?.disconnect?.();
    } catch {
      // Ignore disconnect errors on detached audio nodes.
    }
    this.gainNode = null;
    if (this.ctx !== null) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }

  private ensureAudioContext(): void {
    if (this.ctx !== null) {
      return;
    }
    if (
      this.audioContextFactory === defaultBrowserAudioContextFactory &&
      typeof AudioContext === "undefined"
    ) {
      return;
    }
    try {
      const ctx = this.audioContextFactory({
        latencyHint: "interactive",
        sampleRate: AUDIO_PLAYER_CONSTANTS.sampleRate,
      });
      const gainNode = ctx.createGain();
      gainNode.gain.value = this.muted ? 0 : this.targetGain;
      gainNode.connect(ctx.destination);
      this.ctx = ctx;
      this.gainNode = gainNode;
    } catch {
      this.ctx = null;
      this.gainNode = null;
    }
  }

  private handleDecodedAudioData(
    audioData: AudioDataLike,
    boundGen: number,
    boundEpoch: number,
  ): void {
    try {
      if (
        this.disposed ||
        boundGen !== this.decoderGen ||
        boundEpoch !== this.activeEpoch ||
        this.muted
      ) {
        return;
      }

      const pcm = extractStereoPcm(audioData);
      if (pcm === null) {
        return;
      }

      const sampleRate =
        audioData.sampleRate > 0 ? audioData.sampleRate : AUDIO_PLAYER_CONSTANTS.sampleRate;
      const durationUs = Math.round((audioData.numberOfFrames / sampleRate) * 1_000_000);
      this.pcmQueue.push({
        ptsUs: audioData.timestamp,
        durationUs,
        left: pcm.left,
        right: pcm.right,
      });
      this.queuedDurationUs += durationUs;

      const maxBufferedUs = AUDIO_PLAYER_CONSTANTS.maxBufferedMs * 1_000;
      while (this.queuedDurationUs > maxBufferedUs && this.pcmQueue.length > 0) {
        const dropped = this.pcmQueue.shift();
        if (dropped !== undefined) {
          this.queuedDurationUs = Math.max(0, this.queuedDurationUs - dropped.durationUs);
        }
      }

      this.drainSchedule();
    } finally {
      safeCloseAudioData(audioData);
    }
  }

  private drainSchedule(): void {
    if (
      this.disposed ||
      this.muted ||
      this.ctx === null ||
      this.gainNode === null ||
      this.ctx.state !== "running" ||
      this.pcmQueue.length === 0
    ) {
      return;
    }

    if (this.holdForVideoBuffering) {
      if (
        this.holdStartedAtMs !== null &&
        this.clock.nowMs() - this.holdStartedAtMs < SYNC_CLOCK_CONSTANTS.stallCushionMaxMs
      ) {
        return;
      }
      this.cancelHoldTimer();
      this.holdForVideoBuffering = false;
      this.holdStartedAtMs = null;
    }

    const nowSec = this.ctx.currentTime;
    if (this.playing) {
      const gapMs = (nowSec - this.nextScheduleCtxTimeSec) * 1_000;
      if (gapMs > AUDIO_PLAYER_CONSTANTS.underrunGapMs) {
        this.playing = false;
        this.needsDeclickFade = true;
        this.rebufferThresholdMs = AUDIO_PLAYER_CONSTANTS.underrunRebufferMs;
        this.anchorCtxTimeSec = null;
        this.anchorPtsUs = null;
        this.underrunCount += 1;
      } else if (gapMs > 0) {
        if (this.anchorCtxTimeSec !== null) {
          this.anchorCtxTimeSec += gapMs / 1_000;
        }
        this.nextScheduleCtxTimeSec = nowSec;
      }
    }

    if (!this.playing) {
      const requiredCushionMs = this.rebufferThresholdMs + this.adaptiveDelayMs;
      if (this.queuedDurationUs / 1_000 < requiredCushionMs) {
        return;
      }
      const first = this.pcmQueue[0];
      if (first === undefined) {
        return;
      }
      this.playing = true;
      this.nextScheduleCtxTimeSec = nowSec + AUDIO_PLAYER_CONSTANTS.scheduleLookaheadMs / 1_000;
      this.anchorCtxTimeSec = this.nextScheduleCtxTimeSec;
      this.anchorPtsUs = first.ptsUs;
    }

    const maxAheadSec =
      (AUDIO_PLAYER_CONSTANTS.maxScheduleLookaheadMs + this.adaptiveDelayMs) / 1_000;

    while (this.pcmQueue.length > 0) {
      if (this.nextScheduleCtxTimeSec - nowSec >= maxAheadSec) {
        break;
      }
      const chunk = this.pcmQueue.shift();
      if (chunk === undefined) {
        break;
      }
      this.queuedDurationUs = Math.max(0, this.queuedDurationUs - chunk.durationUs);

      if (this.needsDeclickFade) {
        applyDeclickFadeIn(chunk.left, chunk.right, this.ctx.sampleRate);
        this.needsDeclickFade = false;
      }

      const buffer = this.ctx.createBuffer(
        AUDIO_PLAYER_CONSTANTS.channels,
        chunk.left.length,
        this.ctx.sampleRate,
      );
      buffer.copyToChannel(chunk.left, 0);
      buffer.copyToChannel(chunk.right, 1);

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = 1.0;
      source.connect(this.gainNode);
      this.activeSources.add(source);
      source.onended = () => {
        this.activeSources.delete(source);
      };
      source.start(this.nextScheduleCtxTimeSec);

      this.nextScheduleCtxTimeSec += chunk.durationUs / 1_000_000;
      this.lastScheduledEndPtsUs = chunk.ptsUs + chunk.durationUs;
    }
  }

  private clearPlaybackSchedule(): void {
    this.cancelHoldTimer();
    for (const source of this.activeSources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Ignore stop errors on sources that have already completed.
      }
      try {
        source.disconnect?.();
      } catch {
        // Ignore disconnect errors on detached audio nodes.
      }
    }
    this.activeSources.clear();
    this.pcmQueue.length = 0;
    this.queuedDurationUs = 0;
    this.playing = false;
    this.needsDeclickFade = true;
    this.rebufferThresholdMs = AUDIO_PLAYER_CONSTANTS.initialCushionMs;
    this.nextScheduleCtxTimeSec = 0;
    this.anchorCtxTimeSec = null;
    this.anchorPtsUs = null;
    this.lastScheduledEndPtsUs = null;
    this.holdForVideoBuffering = false;
    this.holdStartedAtMs = null;
  }

  private armHoldReleaseTimer(): void {
    this.cancelHoldTimer();
    this.holdTimer = this.clock.setTimeout(() => {
      this.holdTimer = null;
      if (this.disposed || !this.holdForVideoBuffering) {
        return;
      }
      this.holdForVideoBuffering = false;
      this.holdStartedAtMs = null;
      this.drainSchedule();
    }, SYNC_CLOCK_CONSTANTS.stallCushionMaxMs);
  }

  private cancelHoldTimer(): void {
    if (this.holdTimer !== null) {
      this.clock.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }
}
