import { STREAM_EPOCH_INITIAL } from "@tesroid/shared";
import {
  type ClientClock,
  type ClientTimerHandle,
  createBrowserClock,
} from "../transport/ports.js";
import type {
  Canvas2DContextLike,
  CanvasElementLike,
  VideoDecoderAdapter,
  VideoDecoderConfigProbe,
  VideoDecoderFactory,
  VideoFrameLike,
} from "./ports.js";

export interface VideoDecoderCallbacks {
  readonly onFrame: (frame: VideoFrameLike, streamEpoch: number, isKeyframe: boolean) => void;
  readonly onDecoderError: (error: Error) => void;
  readonly onNeedsReset: () => void;
}

export interface VideoDecoderPipelineOptions {
  readonly clock?: ClientClock;
  readonly decoderFactory?: VideoDecoderFactory;
}

export const VIDEO_DECODER_CONSTANTS = {
  errorRecoveryDelayMs: 150,
  minQueueLimit: 14,
  maxQueueLimit: 24,
  fpsQueueDivisor: 3,
} as const;

export interface ParsedAvccConfig {
  readonly codec: string;
  readonly description: Uint8Array<ArrayBuffer>;
}

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function formatAvcCodec(profile: number, compat: number, level: number): string {
  return `avc1.${toHexByte(profile)}${toHexByte(compat)}${toHexByte(level)}`;
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array): boolean {
  if (a === null || a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function extractAnnexBNals(bytes: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let i = 0;
  let nalStart = -1;

  while (i < bytes.byteLength) {
    const is4Byte =
      i + 3 < bytes.byteLength &&
      bytes[i] === 0 &&
      bytes[i + 1] === 0 &&
      bytes[i + 2] === 0 &&
      bytes[i + 3] === 1;
    const is3Byte =
      !is4Byte &&
      i + 2 < bytes.byteLength &&
      bytes[i] === 0 &&
      bytes[i + 1] === 0 &&
      bytes[i + 2] === 1;

    if (is4Byte || is3Byte) {
      if (nalStart >= 0 && i > nalStart) {
        nals.push(bytes.subarray(nalStart, i));
      }
      const scLen = is4Byte ? 4 : 3;
      i += scLen;
      nalStart = i;
      continue;
    }
    i += 1;
  }

  if (nalStart >= 0 && bytes.byteLength > nalStart) {
    nals.push(bytes.subarray(nalStart));
  }
  return nals;
}

// Spec: docs/specs/04-client-playback-avsync.md#2.1
export function parseAvccConfigRecord(configBytes: Uint8Array): ParsedAvccConfig | null {
  if (configBytes.byteLength === 0) {
    return null;
  }

  // Accept raw ISO 14496-15 AVCDecoderConfigurationRecord directly if already formatted.
  if (
    configBytes.byteLength >= 7 &&
    configBytes[0] === 0x01 &&
    (configBytes[4] ?? 0) >= 0xfc &&
    configBytes[1] !== undefined &&
    configBytes[2] !== undefined &&
    configBytes[3] !== undefined
  ) {
    return {
      codec: formatAvcCodec(configBytes[1], configBytes[2], configBytes[3]),
      description: new Uint8Array(configBytes),
    };
  }

  const nals = extractAnnexBNals(configBytes);
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;

  for (const nal of nals) {
    const header = nal[0];
    if (header === undefined) {
      continue;
    }
    const nalType = header & 0x1f;
    if (nalType === 7 && nal.byteLength >= 4) {
      sps = nal;
    } else if (nalType === 8 && nal.byteLength >= 1) {
      pps = nal;
    }
  }

  if (sps === null || pps === null) {
    return null;
  }

  const profile = sps[1] ?? 0;
  const compat = sps[2] ?? 0;
  const level = sps[3] ?? 0;
  const totalLen = 11 + sps.byteLength + pps.byteLength;
  const description = new Uint8Array(totalLen);
  const view = new DataView(description.buffer);

  let offset = 0;
  description[offset++] = 0x01;
  description[offset++] = profile;
  description[offset++] = compat;
  description[offset++] = level;
  description[offset++] = 0xff; // 4-byte NAL length prefix (lengthSizeMinusOne = 3)
  description[offset++] = 0xe1; // 1 SPS
  view.setUint16(offset, sps.byteLength, false);
  offset += 2;
  description.set(sps, offset);
  offset += sps.byteLength;
  description[offset++] = 0x01; // 1 PPS
  view.setUint16(offset, pps.byteLength, false);
  offset += 2;
  description.set(pps, offset);

  return {
    codec: formatAvcCodec(profile, compat, level),
    description,
  };
}

function buildProbeCandidates(parsed: ParsedAvccConfig): readonly VideoDecoderConfigProbe[] {
  return [
    {
      codec: parsed.codec,
      description: parsed.description,
      hardwareAcceleration: "prefer-hardware",
      optimizeForLatency: true,
    },
    {
      codec: parsed.codec,
      description: parsed.description,
      hardwareAcceleration: "prefer-hardware",
    },
    {
      codec: parsed.codec,
      description: parsed.description,
      optimizeForLatency: true,
    },
    {
      codec: parsed.codec,
      description: parsed.description,
    },
  ];
}

function createBrowserVideoDecoderFactory(): VideoDecoderFactory {
  return {
    async isConfigSupported(config) {
      if (typeof VideoDecoder === "undefined") {
        return false;
      }
      try {
        const support = await VideoDecoder.isConfigSupported(config);
        return support.supported === true;
      } catch {
        return false;
      }
    },
    create(callbacks) {
      const decoder = new VideoDecoder({
        output: (frame) => {
          callbacks.onOutput(frame);
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
        decode(payload, timestampUs, isKeyframe) {
          const chunk = new EncodedVideoChunk({
            type: isKeyframe ? "key" : "delta",
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

function safeCloseDecoder(decoder: VideoDecoderAdapter | null): void {
  if (decoder === null) {
    return;
  }
  try {
    if (decoder.state !== "closed") {
      decoder.close();
    }
  } catch {
    // Ignore close errors during error teardown.
  }
}

export class VideoDecoderPipeline {
  private readonly callbacks: VideoDecoderCallbacks;
  private readonly clock: ClientClock;
  private readonly decoderFactory: VideoDecoderFactory;

  private activeEpoch: number = STREAM_EPOCH_INITIAL;
  private decoderGen = 0;
  private resetSequence = 0;
  private decoder: VideoDecoderAdapter | null = null;
  private configured = false;
  // 入力 PTS → key フラグの対応。デコーダ出力の GOP 境界判定にのみ用いる（仕様 04 §2.1）。
  private readonly pendingKeyFlags = new Map<number, boolean>();
  private disposed = false;
  private lastConfigBytes: Uint8Array | null = null;
  private recoveryTimer: ClientTimerHandle | null = null;

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  constructor(callbacks: VideoDecoderCallbacks, options: VideoDecoderPipelineOptions = {}) {
    this.callbacks = callbacks;
    this.clock = options.clock ?? createBrowserClock();
    this.decoderFactory = options.decoderFactory ?? createBrowserVideoDecoderFactory();
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  async configure(avccConfigBytes: Uint8Array, streamEpoch: number): Promise<boolean> {
    if (this.disposed || streamEpoch < this.activeEpoch) {
      return false;
    }

    if (streamEpoch > this.activeEpoch) {
      this.reset(streamEpoch);
    }

    const parsed = parseAvccConfigRecord(avccConfigBytes);
    if (parsed === null) {
      return false;
    }

    if (
      streamEpoch === this.activeEpoch &&
      this.configured &&
      this.decoder !== null &&
      this.decoder.state === "configured" &&
      bytesEqual(this.lastConfigBytes, avccConfigBytes)
    ) {
      return true;
    }

    const configCopy = new Uint8Array(avccConfigBytes);
    this.lastConfigBytes = configCopy;

    const probeGen = ++this.decoderGen;
    const candidates = buildProbeCandidates(parsed);
    let selected: VideoDecoderConfigProbe | null = null;

    for (const candidate of candidates) {
      let supported = false;
      try {
        supported = await this.decoderFactory.isConfigSupported(candidate);
      } catch {
        supported = false;
      }
      if (this.disposed || probeGen !== this.decoderGen || streamEpoch !== this.activeEpoch) {
        return false;
      }
      if (supported) {
        selected = candidate;
        break;
      }
    }

    if (selected === null) {
      return false;
    }

    safeCloseDecoder(this.decoder);
    this.decoder = null;
    this.configured = false;

    const boundEpoch = streamEpoch;

    const adapter = this.decoderFactory.create({
      onOutput: (frame) => {
        if (this.disposed || probeGen !== this.decoderGen || boundEpoch !== this.activeEpoch) {
          try {
            frame.close();
          } catch {
            // Ignore close errors on stale decoder outputs.
          }
          return;
        }
        this.callbacks.onFrame(
          frame,
          boundEpoch,
          // GOP 境界判定のため、入力時に記録した key フラグを PTS で照合する（出力順序は PTS 一致で保証）。
          this.pendingKeyFlags.get(frame.timestamp) === true,
        );
        this.pendingKeyFlags.delete(frame.timestamp);
      },
      onError: (error) => {
        this.handleDecoderError(error, probeGen);
      },
    });

    try {
      adapter.configure(selected);
      this.decoder = adapter;
      this.configured = true;
      return true;
    } catch (err) {
      safeCloseDecoder(adapter);
      this.handleDecoderError(err instanceof Error ? err : new Error(String(err)), probeGen);
      return false;
    }
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  decode(avccPayload: Uint8Array, ptsUs: number, isKeyframe: boolean, streamEpoch: number): void {
    if (
      this.disposed ||
      !this.configured ||
      this.decoder === null ||
      this.decoder.state !== "configured" ||
      streamEpoch !== this.activeEpoch
    ) {
      return;
    }

    const gen = this.decoderGen;
    this.pendingKeyFlags.set(ptsUs, isKeyframe);
    try {
      this.decoder.decode(avccPayload, ptsUs, isKeyframe);
    } catch (err) {
      this.handleDecoderError(err instanceof Error ? err : new Error(String(err)), gen);
    }
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  getDecodeQueueSize(): number {
    return this.decoder?.decodeQueueSize ?? 0;
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  getMaxQueueLimit(targetFps: number): number {
    if (!Number.isFinite(targetFps) || targetFps <= 0) {
      return VIDEO_DECODER_CONSTANTS.minQueueLimit;
    }
    const scaled = Math.round(targetFps / VIDEO_DECODER_CONSTANTS.fpsQueueDivisor);
    return Math.min(
      VIDEO_DECODER_CONSTANTS.maxQueueLimit,
      Math.max(VIDEO_DECODER_CONSTANTS.minQueueLimit, scaled),
    );
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  reset(newStreamEpoch: number): void {
    this.cancelRecoveryTimer();
    this.resetSequence += 1;
    this.decoderGen += 1;
    this.pendingKeyFlags.clear();
    if (newStreamEpoch > this.activeEpoch) {
      this.activeEpoch = newStreamEpoch;
      this.lastConfigBytes = null;
    } else if (newStreamEpoch === this.activeEpoch) {
      this.activeEpoch = newStreamEpoch;
    }
    safeCloseDecoder(this.decoder);
    this.decoder = null;
    this.configured = false;
  }

  // Spec: docs/specs/04-client-playback-avsync.md#3
  dispose(): void {
    this.disposed = true;
    this.cancelRecoveryTimer();
    this.resetSequence += 1;
    this.decoderGen += 1;
    this.pendingKeyFlags.clear();
    safeCloseDecoder(this.decoder);
    this.decoder = null;
    this.configured = false;
    this.lastConfigBytes = null;
  }

  private handleDecoderError(error: Error, errorGen: number): void {
    if (this.disposed || errorGen !== this.decoderGen) {
      return;
    }
    this.decoderGen += 1;
    this.pendingKeyFlags.clear();
    safeCloseDecoder(this.decoder);
    this.decoder = null;
    this.configured = false;
    this.callbacks.onDecoderError(error);
    this.armRecoveryTimer();
  }

  private armRecoveryTimer(): void {
    this.cancelRecoveryTimer();
    const recoveryEpoch = this.activeEpoch;
    const recoveryResetSeq = this.resetSequence;
    this.recoveryTimer = this.clock.setTimeout(() => {
      this.recoveryTimer = null;
      void this.runErrorRecovery(recoveryEpoch, recoveryResetSeq);
    }, VIDEO_DECODER_CONSTANTS.errorRecoveryDelayMs);
  }

  private async runErrorRecovery(recoveryEpoch: number, recoveryResetSeq: number): Promise<void> {
    if (
      this.disposed ||
      this.activeEpoch !== recoveryEpoch ||
      this.resetSequence !== recoveryResetSeq
    ) {
      return;
    }
    if (this.lastConfigBytes !== null) {
      await this.configure(this.lastConfigBytes, recoveryEpoch);
    }
    if (
      this.disposed ||
      this.activeEpoch !== recoveryEpoch ||
      this.resetSequence !== recoveryResetSeq
    ) {
      return;
    }
    this.callbacks.onNeedsReset();
  }

  private cancelRecoveryTimer(): void {
    if (this.recoveryTimer !== null) {
      this.clock.clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }
}

export class Canvas2DRenderer {
  private readonly clock: ClientClock;
  private canvas: CanvasElementLike | null = null;
  private ctx: Canvas2DContextLike | null = null;

  constructor(clock: ClientClock = createBrowserClock()) {
    this.clock = clock;
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  attach(canvas: CanvasElementLike): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  renderFrame(frame: VideoFrameLike): number {
    const startedAtMs = this.clock.nowMs();
    try {
      if (this.canvas !== null && this.ctx !== null) {
        const width = frame.displayWidth > 0 ? frame.displayWidth : frame.codedWidth;
        const height = frame.displayHeight > 0 ? frame.displayHeight : frame.codedHeight;
        if (width > 0 && height > 0) {
          if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
          }
          this.ctx.drawImage(frame, 0, 0, width, height);
        }
      }
    } finally {
      try {
        frame.close();
      } catch {
        // Ignore close errors on already-closed browser frames.
      }
    }
    return Math.max(0, this.clock.nowMs() - startedAtMs);
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  clear(): void {
    if (this.canvas === null || this.ctx === null) {
      return;
    }
    this.ctx.fillStyle = "#000000";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // Spec: docs/specs/04-client-playback-avsync.md#2.1
  dispose(): void {
    this.canvas = null;
    this.ctx = null;
  }
}
