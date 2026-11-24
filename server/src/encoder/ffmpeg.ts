import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import { ALLOWED_X264_PRESETS } from '../config.js';
import {
  DEFAULT_VAAPI_DEVICE,
  type EncoderBackend,
  type EncoderMode,
  normalizeVaapiOverride,
  resolveEncoderMode,
  resolveLibvaDriverName,
} from '../utils/vaapi.js';
import type { EncodeDimensions } from './encode-dimensions.js';

export const VIDEO_FLAGS = {
  KEYFRAME: 0x01,
  CONFIG: 0x02,
  AVCC: 0x04,
} as const;

export const AUDIO_FLAGS = {
  KEYFRAME: 0x01,
  CONFIG: 0x02,
} as const;

const ANNEX_B_START_CODE_4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);

export interface EncoderOptions {
  displayNum?: string; // ':99'
  width?: number; // 1280
  height?: number; // 720
  fps?: number; // 30
  bitrate?: string; // '4M'
  audioBitrate?: string | number; // e.g. '128k', 128000, '320k' (128k - 320k)
  vaapiDevice?: string; // '/dev/dri/renderD128'
  libvaDriverName?: string; // e.g. 'iHD', 'i965', 'radeonsi', 'd3d12'
  encoderMode?: EncoderMode; // 'auto' | 'vaapi' | 'software'
  initialBackend?: EncoderBackend; // 'vaapi' | 'software'
  audioSink?: string; // 'virtual_sink.monitor'
  compressionLevel?: number; // 1 (best quality) - 7 (fastest/lightest)
  lowPower?: boolean; // Enable Intel VDEnc (-low_power 1)
  gpuColorConversion?: boolean; // Offload RGB->NV12 conversion to GPU via scale_vaapi
  x264Preset?: string; // libx264 speed preset (software backend only, Issue #90)
}

export interface EncoderFallbackEvent {
  option: 'lowPower' | 'gpuColorConversion' | 'softwareEncoder';
  timestamp: number;
}

// libx264 の既定 -preset（既存動作を維持する最速値。CPUプリセットで上書き可能, Issue #90）
const DEFAULT_X264_PRESET = 'ultrafast';

function normalizeX264Preset(value?: string): string | undefined {
  return value && ALLOWED_X264_PRESETS.includes(value) ? value : undefined;
}

export class VaapiEncoder extends EventEmitter {
  private static readonly VIDEO_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 10000] as const;

  private displayNum: string;
  private width: number;
  private height: number;
  // Issue #11: レイアウト(キャプチャ)寸法と独立したエンコード出力寸法。
  // encodeWidth/Height == width/height のときは現行と完全に同一の FFmpeg 引数になる。
  private encodeWidth: number;
  private encodeHeight: number;
  private fps: number;
  private bitrate: string;
  private audioBitrate: string;
  private vaapiDevice: string;
  private libvaDriverName?: string;
  private encoderMode: EncoderMode;
  private activeBackend: EncoderBackend;
  private audioSink: string;
  private compressionLevel: number;
  private lowPower: boolean;
  private gpuColorConversion: boolean;
  private x264Preset: string;
  private videoStartTimeMs = 0;
  private framesInCurrentProcess = 0;
  private lastFallback: EncoderFallbackEvent | null = null;
  private videoRetryTimer: NodeJS.Timeout | null = null;
  private videoRetryAttempt = 0;

  private videoProcess: ChildProcess | null = null;
  private audioProcess: ChildProcess | null = null;
  private isVideoRunning = false;
  private isAudioRunning = false;
  private isIntentionalVideoStop = false;
  private isIntentionalAudioStop = false;

  // Stream timing baseline
  private streamStartTimeUs: bigint = 0n;

  // Video state
  private videoPts: bigint = 0n;
  private videoFrameDurationUs: bigint;

  // Audio state
  private audioPts: bigint = 0n;
  private readonly audioFrameDurationUs: bigint = 20000n; // 20ms per opus packet

  // Stream buffers for Access Unit (frame) assembly
  private h264Remainder: Buffer = Buffer.alloc(0);
  private currentAuConfigNals: Buffer[] = [];
  private currentAuSlices: Buffer[] = [];
  private currentAuHasKeyframe = false;
  private currentAuHasConfig = false;
  private currentAuHasSlice = false;
  private currentAuHasExplicitAud = false;

  private oggRemainder: Buffer = Buffer.alloc(0);
  private oggHeaderParsed = false;
  private cachedSpsPps: Buffer | null = null;
  private cachedKeyframe: { data: Buffer; pts: bigint } | null = null;
  private cachedOpusHead: Buffer | null = null;

  // Video watchdog
  private lastVideoEmitTime = 0;
  private videoWatchdogTimer: NodeJS.Timeout | null = null;
  private readonly watchdogTimeoutMs = 3000;

  constructor(options: EncoderOptions = {}) {
    super();
    this.displayNum = options.displayNum || process.env.DISPLAY_NUM || ':99';
    this.width = options.width || Number(process.env.DISPLAY_WIDTH) || 1280;
    this.height = options.height || Number(process.env.DISPLAY_HEIGHT) || 720;
    this.encodeWidth = this.width;
    this.encodeHeight = this.height;
    this.fps = options.fps || Number(process.env.FPS) || 30;
    this.bitrate = options.bitrate || process.env.VIDEO_BITRATE || '1000k';
    this.audioBitrate = this.formatAudioBitrate(
      options.audioBitrate || process.env.AUDIO_BITRATE || '128k',
    );
    this.vaapiDevice =
      normalizeVaapiOverride(options.vaapiDevice) ||
      normalizeVaapiOverride(process.env.VAAPI_DEVICE) ||
      DEFAULT_VAAPI_DEVICE;
    this.libvaDriverName = options.libvaDriverName;
    this.encoderMode = resolveEncoderMode(options.encoderMode);
    this.activeBackend =
      this.encoderMode === 'software'
        ? 'software'
        : this.encoderMode === 'vaapi'
          ? 'vaapi'
          : (options.initialBackend ?? 'vaapi');
    this.audioSink = options.audioSink || 'virtual_sink.monitor';
    const rawComp = options.compressionLevel ?? (Number(process.env.VAAPI_COMPRESSION_LEVEL) || 7);
    this.compressionLevel = Math.max(1, Math.min(7, Math.round(rawComp)));
    this.lowPower =
      options.lowPower ??
      (process.env.VAAPI_LOW_POWER === 'true' || process.env.VAAPI_LOW_POWER === '1');
    this.gpuColorConversion =
      options.gpuColorConversion ??
      (process.env.VAAPI_GPU_CSC !== 'false' && process.env.VAAPI_GPU_CSC !== '0');
    this.x264Preset = normalizeX264Preset(options.x264Preset) ?? DEFAULT_X264_PRESET;

    this.videoFrameDurationUs = BigInt(Math.round(1000000 / this.fps));
    this.streamStartTimeUs = BigInt(Math.round(performance.now() * 1000));
  }

  private parseBitrateBps(bitrate: string | number): number {
    if (typeof bitrate === 'number') return bitrate;
    const str = String(bitrate).toLowerCase().trim();
    if (str.endsWith('m')) {
      return parseFloat(str) * 1000 * 1000;
    }
    if (str.endsWith('k')) {
      return parseFloat(str) * 1000;
    }
    const num = Number(str);
    return isNaN(num) ? 1000000 : num;
  }

  public parseAudioBitrateBps(bitrate: string | number): number {
    let bps = 128000;
    if (typeof bitrate === 'number') {
      bps = bitrate < 1000 ? bitrate * 1000 : bitrate;
    } else {
      const str = String(bitrate).toLowerCase().trim();
      if (str.endsWith('k')) {
        bps = parseFloat(str) * 1000;
      } else if (str.endsWith('m')) {
        bps = parseFloat(str) * 1000 * 1000;
      } else {
        const num = Number(str);
        if (!isNaN(num)) {
          bps = num < 1000 ? num * 1000 : num;
        }
      }
    }
    // Clamp between 128k (128000) and 320k (320000)
    return Math.max(128000, Math.min(320000, Math.round(bps)));
  }

  public formatAudioBitrate(bitrate: string | number): string {
    const bps = this.parseAudioBitrateBps(bitrate);
    return `${Math.round(bps / 1000)}k`;
  }

  public getAudioBitrate(): string {
    return this.audioBitrate;
  }

  public getAudioBitrateBps(): number {
    return this.parseAudioBitrateBps(this.audioBitrate);
  }

  public getCompressionLevel(): number {
    return this.compressionLevel;
  }

  public isLowPower(): boolean {
    return this.lowPower;
  }

  public isGpuColorConversion(): boolean {
    return this.gpuColorConversion;
  }

  public getX264Preset(): string {
    return this.x264Preset;
  }

  public getEncoderMode(): EncoderMode {
    return this.encoderMode;
  }

  public getActiveBackend(): EncoderBackend {
    return this.activeBackend;
  }

  public getEncoderStatus(): {
    running: boolean;
    backend: EncoderBackend;
    encoderMode: EncoderMode;
    compressionLevel: number;
    lowPower: boolean;
    gpuColorConversion: boolean;
    x264Preset: string;
    libvaDriverName: string | null;
    lastFallback: EncoderFallbackEvent | null;
    captureWidth: number;
    captureHeight: number;
    encodeWidth: number;
    encodeHeight: number;
  } {
    return {
      running: this.isVideoRunning,
      backend: this.activeBackend,
      encoderMode: this.encoderMode,
      compressionLevel: this.compressionLevel,
      lowPower: this.lowPower,
      gpuColorConversion: this.gpuColorConversion,
      x264Preset: this.x264Preset,
      libvaDriverName: this.libvaDriverName ?? null,
      lastFallback: this.lastFallback ? { ...this.lastFallback } : null,
      captureWidth: this.width,
      captureHeight: this.height,
      encodeWidth: this.encodeWidth,
      encodeHeight: this.encodeHeight,
    };
  }

  public buildVideoArgs(): string[] {
    const bps = this.parseBitrateBps(this.bitrate);
    const gop = Math.max(1, Math.round(this.fps * 2.0)); // 2.0s GOP for high efficiency at 1Mbps

    const inputArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-thread_queue_size',
      '64',
      '-f',
      'x11grab',
      '-draw_mouse',
      '0',
      '-framerate',
      `${this.fps}`,
      '-video_size',
      `${this.width}x${this.height}`,
      '-i',
      `${this.displayNum}.0`,
    ];

    const codecArgs: string[] = [];
    // Issue #11: クライアント負荷プロファイルによるエンコード寸法縮小 (レイアウトは変更しない)。
    // 標準 (scale=1.0) では encode* == capture* となり、生成フィルタは従来と完全に一致する。
    const encodeScaled = this.encodeWidth !== this.width || this.encodeHeight !== this.height;
    const encW = Math.max(320, this.encodeWidth & ~7);
    const encH = Math.max(240, this.encodeHeight & ~1);
    if (this.activeBackend === 'software') {
      codecArgs.push(
        '-vf',
        encodeScaled ? `scale=${encW}:${encH},format=yuv420p` : 'format=yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        this.x264Preset,
        '-tune',
        'zerolatency',
      );
    } else {
      const vfFilter = this.gpuColorConversion
        ? encodeScaled
          ? `hwupload,scale_vaapi=w=${encW}:h=${encH}:format=nv12`
          : 'hwupload,scale_vaapi=format=nv12'
        : encodeScaled
          ? `scale=${encW}:${encH},format=nv12,hwupload`
          : 'format=nv12,hwupload';
      codecArgs.push(
        '-vaapi_device',
        this.vaapiDevice,
        '-vf',
        vfFilter,
        '-c:v',
        'h264_vaapi',
        '-compression_level',
        `${this.compressionLevel}`,
      );
      if (this.lowPower) {
        codecArgs.push('-low_power', '1');
      }
    }

    const outputArgs = [
      '-b:v',
      `${Math.round(bps / 1000)}k`,
      '-maxrate',
      `${Math.round((bps * 1.3) / 1000)}k`,
      '-bufsize',
      `${Math.round((bps * 0.6) / 1000)}k`,
      '-g',
      `${gop}`,
      '-bf',
      '0',
      '-bsf:v',
      'h264_metadata=aud=insert',
      '-flush_packets',
      '1',
      '-f',
      'h264',
      'pipe:1',
    ];

    return [...inputArgs, ...codecArgs, ...outputArgs];
  }

  /**
   * Builds the environment variables passed to the Video FFmpeg child process.
   */
  public buildVideoEnv(): NodeJS.ProcessEnv {
    const libvaDriverName = resolveLibvaDriverName(this.libvaDriverName);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DISPLAY: this.displayNum,
      LIBVA_DRIVER_NAME: libvaDriverName,
    };
    if (libvaDriverName === 'd3d12' && !process.env.GALLIUM_DRIVER) {
      env.GALLIUM_DRIVER = 'd3d12';
    }
    return env;
  }

  public getCachedSpsPps(): Buffer | null {
    return this.cachedSpsPps;
  }

  public getCachedKeyframe(): { data: Buffer; pts: bigint } | null {
    return this.cachedKeyframe;
  }

  public getCachedOpusHead(): Buffer | null {
    return this.cachedOpusHead;
  }

  public getCurrentPts(): bigint {
    const nowUs = BigInt(Math.round(performance.now() * 1000));
    return this.streamStartTimeUs > 0n && nowUs >= this.streamStartTimeUs
      ? nowUs - this.streamStartTimeUs
      : this.videoPts;
  }

  public isKeyframeStale(thresholdUs: bigint = 2000000n): boolean {
    if (!this.cachedKeyframe) return true;
    const currentPts = this.getCurrentPts();
    return currentPts - this.cachedKeyframe.pts >= thresholdUs;
  }

  public isRunning(): boolean {
    return this.isVideoRunning || this.isAudioRunning;
  }

  public start(): void {
    console.log('[VaapiEncoder] Starting Video and Audio FFmpeg encoders...');
    this.startVideo();
    this.startAudio();
  }

  private switchToSoftwareFallback(): void {
    this.activeBackend = 'software';
    this.lastFallback = { option: 'softwareEncoder', timestamp: Date.now() };
    this.emit('fallback', { ...this.lastFallback });
  }

  private getNextVideoRetryDelayMs(): number {
    const idx = Math.min(this.videoRetryAttempt, VaapiEncoder.VIDEO_RETRY_DELAYS_MS.length - 1);
    this.videoRetryAttempt++;
    return VaapiEncoder.VIDEO_RETRY_DELAYS_MS[idx];
  }

  public startVideo(): void {
    if (this.isVideoRunning) return;
    if (this.videoRetryTimer) {
      clearTimeout(this.videoRetryTimer);
      this.videoRetryTimer = null;
    }

    if (
      this.activeBackend === 'vaapi' &&
      this.encoderMode === 'auto' &&
      !fs.existsSync(this.vaapiDevice)
    ) {
      console.warn(
        `[VaapiEncoder] VAAPI render node not found at ${this.vaapiDevice}; switching to software (libx264) encoder.`,
      );
      this.switchToSoftwareFallback();
    } else if (this.activeBackend === 'vaapi' && !fs.existsSync(this.vaapiDevice)) {
      console.warn(
        `[VaapiEncoder] VAAPI render node not found at ${this.vaapiDevice} (encoderMode=${this.encoderMode}); attempting VAAPI spawn anyway.`,
      );
    }

    this.isVideoRunning = true;
    this.isIntentionalVideoStop = false;
    this.framesInCurrentProcess = 0;
    this.h264Remainder = Buffer.alloc(0);
    this.currentAuConfigNals = [];
    this.currentAuSlices = [];
    this.currentAuHasKeyframe = false;
    this.currentAuHasConfig = false;
    this.currentAuHasSlice = false;
    this.currentAuHasExplicitAud = false;
    this.videoPts = 0n;
    if (this.streamStartTimeUs === 0n) {
      this.streamStartTimeUs = BigInt(Math.round(performance.now() * 1000));
    }
    this.videoStartTimeMs = performance.now();

    const videoArgs = this.buildVideoArgs();

    console.log(
      `[VaapiEncoder] Spawning dedicated Video FFmpeg encoder (${this.activeBackend}): ffmpeg ${videoArgs.join(' ')}`,
    );

    const proc = spawn('ffmpeg', videoArgs, {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: this.buildVideoEnv(),
    });
    this.videoProcess = proc;

    proc.stdout?.on('data', (chunk: Buffer) => this.handleVideoChunk(chunk));

    proc.on('exit', (code, signal) => {
      if (this.videoProcess !== proc) {
        console.log(
          `[VaapiEncoder] Superseded Video FFmpeg process exited cleanly (code=${code}, signal=${signal}).`,
        );
        return;
      }
      console.warn(`[VaapiEncoder] Video FFmpeg exited (code=${code}, signal=${signal})`);
      this.videoProcess = null;
      const intentional = this.isIntentionalVideoStop;
      this.isIntentionalVideoStop = false;
      this.isVideoRunning = false;
      this.stopVideoWatchdog();
      this.emit('stop');

      const failedAbnormally = !intentional && ((code !== 0 && code !== null) || signal !== null);
      if (failedAbnormally) {
        const elapsedMs = performance.now() - this.videoStartTimeMs;
        // Allow up to 5s for cold-boot driver/FFmpeg init on low-spec CPUs (e.g. Celeron N4000) before triggering fallback
        const failedImmediately = this.framesInCurrentProcess === 0 && elapsedMs < 5000;
        if (this.activeBackend === 'vaapi' && failedImmediately) {
          if (this.lowPower) {
            console.warn(
              '[VaapiEncoder] Video FFmpeg exited immediately with -low_power 1; falling back to standard VAAPI mode (lowPower=false).',
            );
            this.lowPower = false;
            this.lastFallback = { option: 'lowPower', timestamp: Date.now() };
            this.emit('fallback', { ...this.lastFallback });
          } else if (this.gpuColorConversion) {
            console.warn(
              '[VaapiEncoder] Video FFmpeg exited immediately with GPU scale_vaapi color conversion; falling back to CPU format=nv12 (gpuColorConversion=false).',
            );
            this.gpuColorConversion = false;
            this.lastFallback = { option: 'gpuColorConversion', timestamp: Date.now() };
            this.emit('fallback', { ...this.lastFallback });
          } else if (this.encoderMode === 'auto') {
            console.warn(
              '[VaapiEncoder] VAAPI h264_vaapi encoder exited immediately after exhausting VAAPI fallbacks; falling back to software (libx264) encoder.',
            );
            this.switchToSoftwareFallback();
          }
        }

        const retryDelayMs = this.getNextVideoRetryDelayMs();
        console.log(`[VaapiEncoder] Auto-recovering Video FFmpeg process in ${retryDelayMs}ms...`);
        this.videoRetryTimer = setTimeout(() => {
          this.videoRetryTimer = null;
          if (!this.isVideoRunning && !this.isIntentionalVideoStop) {
            this.startVideo();
          }
        }, retryDelayMs);
        if (typeof this.videoRetryTimer.unref === 'function') {
          this.videoRetryTimer.unref();
        }
      }
    });

    proc.on('error', (err) => {
      console.error('[VaapiEncoder] Video FFmpeg process error:', err);
      this.emit('error', err);
    });

    this.lastVideoEmitTime = performance.now();
    this.startVideoWatchdog();
  }

  public startAudio(): void {
    if (this.isAudioRunning) return;
    this.isAudioRunning = true;
    this.isIntentionalAudioStop = false;
    this.oggRemainder = Buffer.alloc(0);
    this.oggHeaderParsed = false;
    this.audioPts = 0n;
    if (this.streamStartTimeUs === 0n) {
      this.streamStartTimeUs = BigInt(Math.round(performance.now() * 1000));
    }

    const audioArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'pulse',
      '-server',
      'unix:/tmp/pulse-socket',
      '-fragment_size',
      '1920',
      '-frame_size',
      '1920',
      '-i',
      this.audioSink,
      '-c:a',
      'libopus',
      '-b:a',
      this.audioBitrate,
      '-vbr',
      'on',
      '-application',
      'lowdelay',
      '-frame_duration',
      '20',
      '-page_duration',
      '20000',
      '-flush_packets',
      '1',
      '-f',
      'opus',
      'pipe:1',
    ];

    console.log(
      `[VaapiEncoder] Spawning dedicated Audio FFmpeg encoder: ffmpeg ${audioArgs.join(' ')}`,
    );

    const proc = spawn('ffmpeg', audioArgs, {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: {
        ...process.env,
        PULSE_SERVER: 'unix:/tmp/pulse-socket',
        PULSE_LATENCY_MSEC: '20',
        PULSE_SINK: 'virtual_sink',
      },
    });
    this.audioProcess = proc;

    proc.stdout?.on('data', (chunk: Buffer) => this.handleAudioChunk(chunk));

    proc.on('exit', (code, signal) => {
      if (this.audioProcess !== proc) {
        console.log(
          `[VaapiEncoder] Superseded Audio FFmpeg process exited cleanly (code=${code}, signal=${signal}).`,
        );
        return;
      }
      console.warn(`[VaapiEncoder] Audio FFmpeg exited (code=${code}, signal=${signal})`);
      const intentional = this.isIntentionalAudioStop;
      this.isIntentionalAudioStop = false;
      this.isAudioRunning = false;

      if (!intentional && code !== 0 && code !== null) {
        console.log('[VaapiEncoder] Auto-recovering Audio FFmpeg process in 1s...');
        setTimeout(() => {
          if (!this.isAudioRunning) {
            this.startAudio();
          }
        }, 1000);
      }
    });

    proc.on('error', (err) => {
      console.error('[VaapiEncoder] Audio FFmpeg process error:', err);
    });
  }

  public stopVideo(): void {
    this.stopVideoWatchdog();
    if (this.videoRetryTimer) {
      clearTimeout(this.videoRetryTimer);
      this.videoRetryTimer = null;
    }
    this.videoRetryAttempt = 0;
    this.cachedSpsPps = null;
    this.cachedKeyframe = null;
    if (!this.isVideoRunning && !this.videoProcess) return;
    this.isIntentionalVideoStop = true;
    this.isVideoRunning = false;
    if (this.videoProcess) {
      const oldProc = this.videoProcess;
      this.videoProcess = null;
      try {
        oldProc.stdout?.removeAllListeners('data');
        oldProc.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (oldProc.exitCode === null) oldProc.kill('SIGKILL');
          } catch {}
        }, 80).unref();
      } catch {}
    }
  }

  private startVideoWatchdog(): void {
    if (this.videoWatchdogTimer) return;
    this.videoWatchdogTimer = setInterval(() => {
      this.checkVideoWatchdog();
    }, 1000).unref();
  }

  private stopVideoWatchdog(): void {
    if (this.videoWatchdogTimer) {
      clearInterval(this.videoWatchdogTimer);
      this.videoWatchdogTimer = null;
    }
  }

  public checkVideoWatchdog(): void {
    if (!this.isVideoRunning || this.isIntentionalVideoStop) {
      return;
    }
    const elapsedMs = performance.now() - this.lastVideoEmitTime;
    if (elapsedMs >= this.watchdogTimeoutMs) {
      console.warn(
        `[VaapiEncoder] watchdog: No video frame emitted for ${Math.round(elapsedMs)}ms (>= ${this.watchdogTimeoutMs}ms). Restarting video encoder...`,
      );
      this.lastVideoEmitTime = performance.now();
      this.restart().catch((err) => {
        console.error('[VaapiEncoder] watchdog: Restart error:', err);
      });
    }
  }

  public stopAudio(): void {
    if (!this.isAudioRunning && !this.audioProcess) return;
    this.isIntentionalAudioStop = true;
    this.isAudioRunning = false;
    if (this.audioProcess) {
      const oldProc = this.audioProcess;
      this.audioProcess = null;
      try {
        oldProc.stdout?.removeAllListeners('data');
        oldProc.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (oldProc.exitCode === null) oldProc.kill('SIGKILL');
          } catch {}
        }, 80).unref();
      } catch {}
    }
  }

  public stop(): void {
    console.log('[VaapiEncoder] Stopping Video and Audio FFmpeg encoders...');
    this.stopVideo();
    this.stopAudio();
  }

  /**
   * Restart FFmpeg video encoder, optionally with new resolution, fps, or bitrate.
   * If audioBitrate is provided, audio encoder is also cleanly reconfigured without race conditions.
   * Otherwise, audio encoder is completely undisturbed to guarantee zero audio dropout during resize or video settings change.
   */
  public async restart(
    width?: number,
    height?: number,
    fps?: number,
    bitrate?: string | number,
    audioBitrate?: string | number,
    compressionLevel?: number,
    lowPower?: boolean,
    gpuColorConversion?: boolean,
    encodeDimensions?: EncodeDimensions | null,
  ): Promise<void> {
    console.log(
      `[VaapiEncoder] Restarting Video FFmpeg encoder (` +
        `resolution=${width && height ? `${width}x${height}` : `${this.width}x${this.height}`}, ` +
        `encode=${
          encodeDimensions
            ? `${encodeDimensions.width}x${encodeDimensions.height}`
            : width || height
              ? 'same'
              : `${this.encodeWidth}x${this.encodeHeight}`
        }, ` +
        `fps=${fps || this.fps}, ` +
        `bitrate=${bitrate || this.bitrate}, ` +
        `compressionLevel=${compressionLevel ?? this.compressionLevel}, ` +
        `lowPower=${lowPower ?? this.lowPower}, ` +
        `gpuCsc=${gpuColorConversion ?? this.gpuColorConversion}` +
        `${audioBitrate ? `, audioBitrate=${audioBitrate}` : ''})...`,
    );
    this.stopVideo();

    if (width && height) {
      this.width = width & ~1;
      this.height = height & ~1;
    }
    // Issue #11: エンコード出力寸法 (レイアウト=キャプチャ寸法とは独立)。
    // 明示指定が無く解像度変更があればエンコード寸法も追随 (標準動作=従来と同一)。
    if (encodeDimensions !== undefined) {
      if (encodeDimensions) {
        this.encodeWidth = encodeDimensions.width & ~7;
        this.encodeHeight = encodeDimensions.height & ~1;
      } else {
        this.encodeWidth = this.width;
        this.encodeHeight = this.height;
      }
    } else if (width && height) {
      this.encodeWidth = this.width;
      this.encodeHeight = this.height;
    }
    if (fps && fps > 0) {
      this.fps = fps;
      this.videoFrameDurationUs = BigInt(Math.round(1000000 / this.fps));
    }
    if (bitrate) {
      const bps = this.parseBitrateBps(bitrate);
      this.bitrate = `${Math.round(bps / 1000)}k`;
    }
    if (compressionLevel !== undefined && Number.isFinite(compressionLevel)) {
      this.compressionLevel = Math.max(1, Math.min(7, Math.round(compressionLevel)));
    }
    if (lowPower !== undefined) {
      this.lowPower = lowPower;
      if (this.lastFallback?.option !== 'softwareEncoder') {
        this.lastFallback = null;
      }
    }
    if (gpuColorConversion !== undefined) {
      this.gpuColorConversion = gpuColorConversion;
      if (this.lastFallback?.option !== 'softwareEncoder') {
        this.lastFallback = null;
      }
    }

    // Reset caches and buffers so new resolution SPS/PPS and IDR keyframe are cleanly broadcast
    this.cachedSpsPps = null;
    this.cachedKeyframe = null;
    this.h264Remainder = Buffer.alloc(0);
    this.currentAuConfigNals = [];
    this.currentAuSlices = [];
    this.currentAuHasKeyframe = false;
    this.currentAuHasConfig = false;
    this.currentAuHasSlice = false;
    this.currentAuHasExplicitAud = false;

    const audioRestartPromise = audioBitrate ? this.restartAudio(audioBitrate) : Promise.resolve();

    // Allow old process to fully exit
    await new Promise((r) => setTimeout(r, 100));
    this.startVideo();
    await audioRestartPromise;
  }

  /**
   * Restart FFmpeg audio encoder, optionally with a new audio bitrate (128k - 320k).
   * Video encoder is completely undisturbed to guarantee zero video dropouts or black screens.
   * Stream start baseline (streamStartTimeUs) is preserved to ensure A/V synchronization stays locked.
   */
  public async restartAudio(audioBitrate?: string | number): Promise<void> {
    if (audioBitrate) {
      this.audioBitrate = this.formatAudioBitrate(audioBitrate);
    }
    console.log(`[VaapiEncoder] Restarting Audio FFmpeg encoder (bitrate=${this.audioBitrate})...`);
    this.stopAudio();
    this.cachedOpusHead = null;
    this.oggRemainder = Buffer.alloc(0);
    this.oggHeaderParsed = false;

    // Allow old process to fully exit
    await new Promise((r) => setTimeout(r, 100));
    this.startAudio();
  }

  /**
   * Completely restart both Video and Audio FFmpeg streaming processes from scratch.
   * Clears all stream caches, remainder buffers, and resets the PTS timeline baseline.
   */
  public async restartAll(
    width?: number,
    height?: number,
    fps?: number,
    bitrate?: string | number,
    audioBitrate?: string | number,
  ): Promise<void> {
    console.log(
      '[VaapiEncoder] Performing full clean restart of Video and Audio streaming processes...',
    );
    this.stopAudio();
    if (audioBitrate) {
      this.audioBitrate = this.formatAudioBitrate(audioBitrate);
    }
    this.cachedOpusHead = null;
    this.oggRemainder = Buffer.alloc(0);
    this.oggHeaderParsed = false;
    this.streamStartTimeUs = BigInt(Math.round(performance.now() * 1000));
    this.videoPts = 0n;
    this.audioPts = 0n;

    await this.restart(width, height, fps, bitrate);
    this.startAudio();
  }

  /**
   * Dynamically update streaming settings (FPS / Bitrate / AudioBitrate) and restart encoders.
   * If only audioBitrate changes, video is completely undisturbed.
   * If only video settings change, audio is completely undisturbed.
   * If both change, video and audio are coordinated without race conditions.
   */
  public async updateConfig(config: {
    fps?: number;
    bitrate?: string | number;
    audioBitrate?: string | number;
    width?: number;
    height?: number;
    compressionLevel?: number;
    lowPower?: boolean;
    gpuColorConversion?: boolean;
    x264Preset?: string;
    // PR #94 レビュー (Medium): プロファイル切替時の連動変更を 1 回の再起動でまとめるため、
    // エンコード出力寸法を同時指定できる。未指定時は従来と完全に同一の restart 呼び出し形。
    encodeDimensions?: EncodeDimensions | null;
  }): Promise<void> {
    // libx264 speed preset: only restart when the validated value actually changes,
    // and only while the software backend is active (x264 args are unused under VAAPI),
    // avoiding needless stream interruptions (Issue #90 review).
    const nextX264Preset = normalizeX264Preset(config.x264Preset);
    const x264PresetChanged = nextX264Preset !== undefined && nextX264Preset !== this.x264Preset;
    if (x264PresetChanged) {
      this.x264Preset = nextX264Preset;
    }
    const x264PresetNeedsRestart = x264PresetChanged && this.activeBackend === 'software';

    const videoNeedsRestart =
      config.width !== undefined ||
      config.height !== undefined ||
      config.fps !== undefined ||
      config.bitrate !== undefined ||
      config.compressionLevel !== undefined ||
      config.lowPower !== undefined ||
      config.gpuColorConversion !== undefined ||
      config.encodeDimensions !== undefined ||
      x264PresetNeedsRestart;

    if (videoNeedsRestart) {
      const hasTuningUpdates =
        config.compressionLevel !== undefined ||
        config.lowPower !== undefined ||
        config.gpuColorConversion !== undefined;
      if (config.encodeDimensions !== undefined) {
        // 寸法同時指定 (プロファイル切替): fps / bitrate / tuning / 寸法を 1 回の restart で適用する
        if (hasTuningUpdates) {
          await this.restart(
            config.width,
            config.height,
            config.fps,
            config.bitrate,
            config.audioBitrate,
            config.compressionLevel,
            config.lowPower,
            config.gpuColorConversion,
            config.encodeDimensions,
          );
        } else {
          await this.restart(
            config.width,
            config.height,
            config.fps,
            config.bitrate,
            config.audioBitrate,
            undefined,
            undefined,
            undefined,
            config.encodeDimensions,
          );
        }
      } else if (hasTuningUpdates) {
        await this.restart(
          config.width,
          config.height,
          config.fps,
          config.bitrate,
          config.audioBitrate,
          config.compressionLevel,
          config.lowPower,
          config.gpuColorConversion,
        );
      } else {
        await this.restart(
          config.width,
          config.height,
          config.fps,
          config.bitrate,
          config.audioBitrate,
        );
      }
    } else if (config.audioBitrate !== undefined) {
      await this.restartAudio(config.audioBitrate);
    }
  }

  /**
   * Issue #11: クライアント負荷プロファイル変更時のみ呼ぶ。キャプチャ(レイアウト)寸法・fps・
   * ビットレートは変更せず、エンコード出力寸法だけを更新して映像エンコーダを再構成する。
   * null で従来動作 (エンコード=キャプチャ寸法) へ復帰する。
   */
  public async setEncodeDimensions(encodeDimensions: EncodeDimensions | null): Promise<void> {
    await this.restart(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      encodeDimensions,
    );
  }

  /**
   * Parse H.264 byte stream into complete Access Units (frames)
   * An Access Unit boundary is marked by an AUD (NAL type 9) or next parameter set
   */
  private handleVideoChunk(chunk: Buffer): void {
    this.h264Remainder = Buffer.concat([this.h264Remainder, chunk]);

    let startIndex = -1;
    let i = 0;

    while (i < this.h264Remainder.length - 4) {
      const isStart4 =
        this.h264Remainder[i] === 0 &&
        this.h264Remainder[i + 1] === 0 &&
        this.h264Remainder[i + 2] === 0 &&
        this.h264Remainder[i + 3] === 1;

      const isStart3 =
        !isStart4 &&
        this.h264Remainder[i] === 0 &&
        this.h264Remainder[i + 1] === 0 &&
        this.h264Remainder[i + 2] === 1;

      if (isStart4 || isStart3) {
        if (startIndex !== -1) {
          const nalData = this.h264Remainder.subarray(startIndex, i);
          this.processNalUnit(nalData);
        }
        startIndex = i;
        i += isStart4 ? 4 : 3;
      } else {
        i++;
      }
    }

    if (startIndex !== -1) {
      this.h264Remainder = this.h264Remainder.subarray(startIndex);
    }
  }

  private processNalUnit(nalWithPrefix: Buffer): void {
    if (nalWithPrefix.length < 4) return;

    let offset = 3;
    if (
      nalWithPrefix[0] === 0 &&
      nalWithPrefix[1] === 0 &&
      nalWithPrefix[2] === 0 &&
      nalWithPrefix[3] === 1
    ) {
      offset = 4;
    }

    if (nalWithPrefix.length <= offset) return;

    const nalType = nalWithPrefix[offset] & 0x1f;

    // Frame boundary detection:
    // 1. Explicit AUD (Type 9): triggers AU flush immediately; marks currentAuHasExplicitAud = true for incoming AU.
    // 2. Fallback without AUD: a new slice (Type 1 or 5) or SPS (Type 7) flushes previous AU once a slice exists.
    // 3. Fallback with AUD: if SPS (Type 7) appears after a slice without preceding AUD, flush previous AU safely.
    const hasExistingSlice = this.currentAuHasSlice;

    if (
      nalType === 9 ||
      (!this.currentAuHasExplicitAud &&
        hasExistingSlice &&
        (nalType === 1 || nalType === 5 || nalType === 7)) ||
      (this.currentAuHasExplicitAud && nalType === 7 && hasExistingSlice)
    ) {
      this.flushCurrentAccessUnit();
    }

    if (nalType === 9) {
      this.currentAuHasExplicitAud = true;
    }

    // AUD (Access Unit Delimiter) and SEI (Supplemental Enhancement Information) are discarded from AVCC stream.
    // デスクトップ低遅延ストリーム配信において SEI は不要（帯域・クライアントパース負荷低減のため破棄）。
    if (nalType === 9 || nalType === 6) {
      return;
    }

    if (nalType === 7 || nalType === 8) {
      // SPS or PPS parameter sets: preserved with Annex-B 4-byte start codes for VIDEO_FLAGS.CONFIG
      this.currentAuHasConfig = true;
      if (offset === 4) {
        this.currentAuConfigNals.push(nalWithPrefix);
      } else {
        // Normalize 3-byte start code (0x000001) to canonical 4-byte start code (0x00000001)
        this.currentAuConfigNals.push(
          Buffer.concat([ANNEX_B_START_CODE_4, nalWithPrefix.subarray(offset)]),
        );
      }
      return;
    }

    const slicePayload = nalWithPrefix.subarray(offset);
    if (slicePayload.length === 0) return;

    // Accumulate slice payload (deferred length-prefix packing prevents creating many small Buffer objects)
    this.currentAuSlices.push(slicePayload);

    if (nalType === 5) {
      // IDR slice
      this.currentAuHasKeyframe = true;
      this.currentAuHasSlice = true;
    } else if (nalType === 1) {
      // Non-IDR slice
      this.currentAuHasSlice = true;
    }
  }

  private flushCurrentAccessUnit(): void {
    if (this.currentAuSlices.length === 0 && this.currentAuConfigNals.length === 0) {
      return;
    }

    const nowUs = BigInt(Math.round(performance.now() * 1000));
    const candidatePts =
      this.streamStartTimeUs > 0n && nowUs >= this.streamStartTimeUs
        ? nowUs - this.streamStartTimeUs
        : this.videoPts + this.videoFrameDurationUs;
    // Keep PTS strictly monotonic when multiple AUs are parsed within the same microsecond
    this.videoPts =
      this.framesInCurrentProcess > 0 && candidatePts <= this.videoPts
        ? this.videoPts + 1n
        : candidatePts;

    // 1. Emit/update parameter sets (SPS / PPS)
    if (this.currentAuHasConfig && this.currentAuConfigNals.length > 0) {
      const spsPpsData = Buffer.concat(this.currentAuConfigNals);
      this.currentAuConfigNals = [];
      this.cachedSpsPps = spsPpsData;

      this.emit('video', {
        flags: VIDEO_FLAGS.CONFIG,
        pts: 0n,
        data: spsPpsData,
      });
    }

    // 2. Emit AVCC video frame (IDR keyframe or P-frame)
    if (this.currentAuSlices.length > 0) {
      // Pre-calculate exact total size: (4-byte length prefix per slice) + sum of slice lengths
      let totalLength = 0;
      for (let i = 0; i < this.currentAuSlices.length; i++) {
        totalLength += 4 + this.currentAuSlices[i].length;
      }

      // Single contiguous buffer allocation; 0 から totalLength までの全領域が
      // 直後のループで writeUInt32BE（4バイト）および slice.copy（slice.length バイト）により
      // 隙間なく完全に上書きされるため、Buffer.allocUnsafe(totalLength) でも未初期化メモリ漏洩リスクはなく最速。
      // 将来の変更時にも未初期化バイトが漏洩しないよう、writeOffset === totalLength の不変条件（Invariant）を検証。
      const frameData = Buffer.allocUnsafe(totalLength);
      let writeOffset = 0;
      for (let i = 0; i < this.currentAuSlices.length; i++) {
        const slice = this.currentAuSlices[i];
        frameData.writeUInt32BE(slice.length, writeOffset);
        writeOffset += 4;
        slice.copy(frameData, writeOffset);
        writeOffset += slice.length;
      }
      this.currentAuSlices = [];

      if (writeOffset !== totalLength) {
        throw new Error(
          `AVCC frame assembly invariant violation: expected ${totalLength} bytes, wrote ${writeOffset} bytes`,
        );
      }

      let flags: number = VIDEO_FLAGS.AVCC;
      if (this.currentAuHasKeyframe) {
        flags |= VIDEO_FLAGS.KEYFRAME;
        this.cachedKeyframe = { data: frameData, pts: this.videoPts };
      }

      this.lastVideoEmitTime = performance.now();
      this.framesInCurrentProcess++;
      this.videoRetryAttempt = 0;

      this.emit('video', {
        flags,
        pts: this.videoPts,
        data: frameData,
      });
    }

    this.currentAuHasKeyframe = false;
    this.currentAuHasConfig = false;
    this.currentAuHasSlice = false;
    this.currentAuHasExplicitAud = false;
  }

  /**
   * Parse OggOpus stream into raw Opus packets and emit 'audio' events
   */
  private handleAudioChunk(chunk: Buffer): void {
    this.oggRemainder = Buffer.concat([this.oggRemainder, chunk]);

    while (this.oggRemainder.length >= 27) {
      if (
        this.oggRemainder[0] !== 0x4f || // 'O'
        this.oggRemainder[1] !== 0x67 || // 'g'
        this.oggRemainder[2] !== 0x67 || // 'g'
        this.oggRemainder[3] !== 0x53 // 'S'
      ) {
        const nextSync = this.oggRemainder.indexOf('OggS', 1);
        if (nextSync === -1) {
          this.oggRemainder = Buffer.alloc(0);
          return;
        }
        this.oggRemainder = this.oggRemainder.subarray(nextSync);
        if (this.oggRemainder.length < 27) return;
      }

      const numSegments = this.oggRemainder[26];
      const headerLength = 27 + numSegments;

      if (this.oggRemainder.length < headerLength) {
        return;
      }

      let payloadLength = 0;
      for (let s = 0; s < numSegments; s++) {
        payloadLength += this.oggRemainder[27 + s];
      }

      const totalPageLength = headerLength + payloadLength;
      if (this.oggRemainder.length < totalPageLength) {
        return;
      }

      const pagePayload = this.oggRemainder.subarray(headerLength, totalPageLength);
      let curOffset = 0;
      let curPacket: Buffer[] = [];

      for (let s = 0; s < numSegments; s++) {
        const segLen = this.oggRemainder[27 + s];
        curPacket.push(pagePayload.subarray(curOffset, curOffset + segLen));
        curOffset += segLen;

        if (segLen < 255) {
          const packetData = Buffer.concat(curPacket);
          curPacket = [];
          this.processOpusPacket(packetData);
        }
      }

      this.oggRemainder = this.oggRemainder.subarray(totalPageLength);
    }
  }

  private processOpusPacket(packet: Buffer): void {
    if (packet.length === 0) return;

    if (packet.length >= 19 && packet.subarray(0, 8).toString('ascii') === 'OpusHead') {
      this.cachedOpusHead = packet;
      this.oggHeaderParsed = true;
      this.emit('audio', {
        flags: AUDIO_FLAGS.CONFIG,
        pts: 0n,
        data: packet,
      });
      return;
    }

    if (packet.length >= 8 && packet.subarray(0, 8).toString('ascii') === 'OpusTags') {
      return;
    }

    const nowUs = BigInt(Math.round(performance.now() * 1000));
    this.audioPts =
      this.streamStartTimeUs > 0n && nowUs >= this.streamStartTimeUs
        ? nowUs - this.streamStartTimeUs
        : this.audioPts + this.audioFrameDurationUs;
    this.emit('audio', {
      flags: AUDIO_FLAGS.KEYFRAME,
      pts: this.audioPts,
      data: packet,
    });
  }
}
