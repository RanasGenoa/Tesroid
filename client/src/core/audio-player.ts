import { AUDIO_FLAGS } from '../transport/protocol.js';
import type { AvSyncController } from './av-sync.js';
import type { TelemetryCollector } from './telemetry.js';

export interface AudioStats {
  state: AudioContextState | 'uninitialized';
  isUnlocked: boolean;
  isMuted: boolean;
  packetsReceived: number;
  packetsDecoded: number;
  recentPps: number;
  channels: number;
}

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private volume: number = 0.88; // Safety headroom (~ -1.1dB) prevents digital clipping & OS/Blink limiter ducking
  private avSync: AvSyncController;
  private isUnlocked: boolean = false;
  private isMuted: boolean = false;
  private audioDecoder: any = null;
  private lastConfigData: Uint8Array | null = null;
  private activeChannels: number = 2;

  // Jitter buffer queue & contiguous timeline
  private bufferQueue: { buffer: AudioBuffer; ptsUs: number }[] = [];
  private overflowQueue: { buffer: AudioBuffer; ptsUs: number }[] = [];
  private totalOverflowDurationSec: number = 0;
  private scheduledSources: Set<AudioBufferSourceNode> = new Set();
  private isPlaying: boolean = false;
  private nextPlayTime: number = 0;
  private lastChunkPtsUs: number = 0;

  // Jitter buffer constants:
  // 160ms target initial buffer (~8 Opus packets). Absorbs network jitter and keeps seamless playback.
  private static readonly JITTER_BUFFER_TARGET_SEC = 0.16;
  // Max WebAudio nodes scheduled ahead at once (0.50s) to keep a healthy hardware cushion against main-thread rendering hiccups
  private static readonly MAX_SCHEDULE_AHEAD_SEC = 0.5;
  // Maximum catchup buffer before trimming oldest audio (30s)
  private static readonly MAX_CATCHUP_BUFFER_SEC = 30.0;
  // Hardware lookahead when starting playback from currentTime (25ms)
  private static readonly HARDWARE_LOOKAHEAD_SEC = 0.025;
  private additionalDelaySec: number = 0;

  // Stats
  private packetsReceived = 0;
  private packetsDecoded = 0;
  private lastPpsCalcTime = 0;
  private recentPacketsCount = 0;
  private recentPps = 0;
  private telemetry?: TelemetryCollector;

  public setTelemetryCollector(telemetry?: TelemetryCollector): void {
    this.telemetry = telemetry;
  }

  constructor(avSync: AvSyncController) {
    this.avSync = avSync;
    this.lastPpsCalcTime = performance.now();
    if (typeof this.avSync.setAudioContextTimeProvider === 'function') {
      this.avSync.setAudioContextTimeProvider(() =>
        this.ctx && this.ctx.state === 'running' ? this.ctx.currentTime : null,
      );
    }
  }

  /**
   * Unlock AudioContext inside a user gesture (tap/click)
   */
  public async unlock(): Promise<boolean> {
    try {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        try {
          this.ctx = new AudioCtx({ latencyHint: 'interactive', sampleRate: 48000 });
        } catch {
          this.ctx = new AudioCtx({ latencyHint: 'interactive' });
        }
      }

      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }

      this.ensureMasterGain();

      this.isUnlocked = this.ctx.state === 'running';
      console.log(
        `[AudioPlayer] AudioContext state: ${this.ctx.state}, unlocked: ${this.isUnlocked}`,
      );
      return this.isUnlocked;
    } catch (err) {
      console.warn('[AudioPlayer] Failed to unlock AudioContext:', err);
      return false;
    }
  }

  private ensureMasterGain(): void {
    if (!this.ctx || this.masterGain) return;
    try {
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.isMuted ? 0 : this.volume;
      this.masterGain.connect(this.ctx.destination);
    } catch (err) {
      console.warn('[AudioPlayer] Failed to create MasterGainNode:', err);
    }
  }

  public toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : this.volume, this.ctx.currentTime);
    }
    if (this.isMuted) {
      this.resetJitterBuffer();
    }
    return this.isMuted;
  }

  public setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1.0, vol));
    if (this.masterGain && this.ctx && !this.isMuted) {
      this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    }
  }

  public getVolume(): number {
    return this.volume;
  }

  public getIsMuted(): boolean {
    return this.isMuted;
  }

  public setAdditionalDelay(delayMs: number): void {
    this.additionalDelaySec = Math.max(0, delayMs / 1000);
  }

  public getAdditionalDelay(): number {
    return this.additionalDelaySec * 1000;
  }

  public getStats(): AudioStats {
    const now = performance.now();
    if (now - this.lastPpsCalcTime >= 1000) {
      this.recentPps = Math.round((this.recentPacketsCount * 1000) / (now - this.lastPpsCalcTime));
      this.recentPacketsCount = 0;
      this.lastPpsCalcTime = now;
    }

    return {
      state: this.ctx ? this.ctx.state : 'uninitialized',
      isUnlocked: this.isUnlocked,
      isMuted: this.isMuted,
      packetsReceived: this.packetsReceived,
      packetsDecoded: this.packetsDecoded,
      recentPps: this.recentPps,
      channels: this.activeChannels,
    };
  }

  public handleAudioPacket(flags: number, pts: bigint, data: Uint8Array): void {
    this.packetsReceived++;
    this.recentPacketsCount++;

    // Check if this is an OpusHead / CONFIG packet
    if (flags & AUDIO_FLAGS.CONFIG) {
      console.log(
        `[AudioPlayer] Received audio CONFIG packet (${data.length} bytes). Configuring decoder.`,
      );
      this.lastConfigData = data;
      this.initDecoder(data);
      this.resetJitterBuffer();
      // NEVER pass CONFIG frame to decode() as an audio chunk
      return;
    }

    if (this.isMuted) return;

    // Check if AudioContext needs unlocking
    if (!this.ctx || this.ctx.state !== 'running') {
      this.isUnlocked = false;
      return;
    }
    this.isUnlocked = true;

    if ('AudioDecoder' in window) {
      this.decodeAndPlayChunk(Number(pts), data);
    }
  }

  private descriptionRejected = false;
  private hasReportedNoWebCodecs = false;

  private initDecoder(configData?: Uint8Array): void {
    if (!('AudioDecoder' in window)) {
      if (!this.hasReportedNoWebCodecs) {
        this.hasReportedNoWebCodecs = true;
        console.error('[AudioPlayer] WebCodecs AudioDecoder is NOT supported by this browser.');
      }
      return;
    }

    if (this.audioDecoder && this.audioDecoder.state !== 'closed') {
      try {
        this.audioDecoder.close();
      } catch {}
      this.audioDecoder = null;
    }

    try {
      this.audioDecoder = new (window as any).AudioDecoder({
        output: (audioData: any) => {
          this.playAudioData(audioData);
        },
        error: (err: any) => {
          console.warn('[AudioPlayer] AudioDecoder error:', err);
          // If description was used, reject it on next attempt
          if (!this.descriptionRejected && (configData || this.lastConfigData)) {
            console.warn('[AudioPlayer] Rejecting OpusHead description for future decoders.');
            this.descriptionRejected = true;
          }
          try {
            this.audioDecoder.close();
          } catch {}
          this.audioDecoder = null;
          this.resetJitterBuffer();
        },
      });

      const config: any = {
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
      };

      const desc = !this.descriptionRejected ? configData || this.lastConfigData : null;
      if (desc && desc.length >= 19) {
        config.description = desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength);
      }

      try {
        this.audioDecoder.configure(config);
        console.log(
          `[AudioPlayer] AudioDecoder configured (Stereo 48kHz Opus${config.description ? ' with OpusHead' : ''})`,
        );
      } catch (confErr) {
        console.warn(
          '[AudioPlayer] Failed configure with description, retrying without description:',
          confErr,
        );
        this.descriptionRejected = true;
        delete config.description;
        this.audioDecoder.configure(config);
        console.log(
          '[AudioPlayer] AudioDecoder configured (fallback: Stereo 48kHz Opus without description)',
        );
      }
    } catch (err) {
      console.warn('[AudioPlayer] Failed to create AudioDecoder:', err);
    }
  }

  private decodeAndPlayChunk(ptsUs: number, data: Uint8Array): void {
    if (!this.audioDecoder || this.audioDecoder.state === 'closed') {
      this.initDecoder();
    }

    if (!this.audioDecoder || this.audioDecoder.state !== 'configured') {
      return;
    }

    this.lastChunkPtsUs = ptsUs;

    try {
      const chunk = new (window as any).EncodedAudioChunk({
        type: 'key',
        timestamp: ptsUs,
        data,
      });
      this.audioDecoder.decode(chunk);
      this.packetsDecoded++;
    } catch (decodeErr) {
      console.warn('[AudioPlayer] Audio chunk decode error:', decodeErr);
    }
  }

  private playAudioData(audioData: any): void {
    if (!this.ctx || this.ctx.state !== 'running' || this.isMuted) {
      audioData.close();
      return;
    }

    const numChannels = audioData.numberOfChannels || 2;
    const numFrames = audioData.numberOfFrames;
    const sampleRate = audioData.sampleRate || 48000;
    const ptsUs =
      audioData.timestamp !== undefined && audioData.timestamp !== null
        ? audioData.timestamp
        : this.lastChunkPtsUs;
    this.activeChannels = numChannels;

    const buffer = this.ctx.createBuffer(numChannels, numFrames, sampleRate);

    try {
      const format = audioData.format;
      const isPlanar = !format || format.includes('planar');

      if (isPlanar) {
        for (let ch = 0; ch < numChannels; ch++) {
          const channelData = buffer.getChannelData(ch);
          audioData.copyTo(channelData, { planeIndex: ch, format: 'f32-planar' });
        }
      } else {
        // Interleaved audio (e.g. f32, s16)
        const interleaved = new Float32Array(numFrames * numChannels);
        audioData.copyTo(interleaved, { planeIndex: 0, format: 'f32' });
        for (let ch = 0; ch < numChannels; ch++) {
          const channelData = buffer.getChannelData(ch);
          for (let i = 0; i < numFrames; i++) {
            channelData[i] = interleaved[i * numChannels + ch];
          }
        }
      }
    } catch (copyErr) {
      // Fallback direct copy
      try {
        for (let ch = 0; ch < numChannels; ch++) {
          const channelData = buffer.getChannelData(ch);
          audioData.copyTo(channelData, { planeIndex: ch });
        }
      } catch (err2) {
        console.warn('[AudioPlayer] copyTo error:', err2);
        audioData.close();
        return;
      }
    }
    audioData.close();

    this.enqueueAndSchedule(buffer, ptsUs);
  }

  private pushOverflow(item: { buffer: AudioBuffer; ptsUs: number }): void {
    this.overflowQueue.push(item);
    this.totalOverflowDurationSec += item.buffer.duration;
  }

  private shiftOverflow(): { buffer: AudioBuffer; ptsUs: number } | undefined {
    const item = this.overflowQueue.shift();
    if (item) {
      this.totalOverflowDurationSec = Math.max(
        0,
        this.totalOverflowDurationSec - item.buffer.duration,
      );
    }
    return item;
  }

  public getBufferedAudioMs(): number {
    if (!this.ctx || this.ctx.state !== 'running') return 0;
    const now = this.ctx.currentTime;
    const scheduledAheadSec = this.isPlaying ? Math.max(0, this.nextPlayTime - now) : 0;
    let queuedSec = 0;
    for (const item of this.bufferQueue) queuedSec += item.buffer.duration;
    return Math.round((scheduledAheadSec + queuedSec + this.totalOverflowDurationSec) * 1000);
  }

  /**
   * Enqueue buffer into the jitter/catchup buffer and schedule contiguous zero-gap 1x hardware playback.
   * Never drops chunks during burst catchup so audio stays smoothly synchronized with 1x video catchup.
   */
  private enqueueAndSchedule(buffer: AudioBuffer, ptsUs: number): void {
    if (!this.ctx || this.ctx.state !== 'running') return;

    const now = this.ctx.currentTime;
    const targetBufferSec = AudioPlayer.JITTER_BUFFER_TARGET_SEC + this.additionalDelaySec;
    const isVideoBuffering =
      typeof this.avSync.isVideoBuffering === 'function' ? this.avSync.isVideoBuffering() : false;

    // If video is currently paused waiting for stall cushion, hold incoming audio in overflowQueue
    // so audio NEVER starts playing ahead while video is waiting!
    if (isVideoBuffering) {
      this.pushOverflow({ buffer, ptsUs });
      this.trimOverflowIfNeeded();
      return;
    }

    // 1. Initial buffering or recovering from a major dropout (> 500ms)
    if (!this.isPlaying) {
      this.bufferQueue.push({ buffer, ptsUs });
      let queuedSec = 0;
      for (const item of this.bufferQueue) {
        queuedSec += item.buffer.duration;
      }

      if (queuedSec >= targetBufferSec) {
        this.isPlaying = true;
        this.nextPlayTime = now + AudioPlayer.HARDWARE_LOOKAHEAD_SEC;

        for (const item of this.bufferQueue) {
          this.scheduleOrHold(item.buffer, item.ptsUs, now);
        }
        this.bufferQueue = [];
        this.pumpOverflowQueue(now);
      }
      return;
    }

    // 2. PLAYING state:
    // Drain any overflow queue items that can now fit in the hardware schedule window
    this.pumpOverflowQueue(now);

    // If underrun is large (> 500ms, e.g. prolonged network interruption) and overflowQueue is empty, rebuild cushion
    if (now - this.nextPlayTime > 0.5 && this.overflowQueue.length === 0) {
      const gapMs = Math.round((now - this.nextPlayTime) * 1000);
      console.log(`[AudioPlayer] Major audio underrun (${gapMs}ms). Rebuilding cushion...`);
      if (this.telemetry?.isEnabled()) {
        this.telemetry.recordAudio('major_underrun', {
          gapMs,
          nextPlayTime: this.nextPlayTime,
          currentTime: now,
        });
      }
      this.isPlaying = false;
      this.stopAllScheduledSources();
      this.avSync.clearAudioAnchor();
      this.bufferQueue = [{ buffer, ptsUs }];
      return;
    }

    this.scheduleOrHold(buffer, ptsUs, now);
  }

  private isAudioAheadOfVideo(ptsUs: number): boolean {
    const lastVideoPts = this.avSync.getLastVideoPts();
    if (lastVideoPts <= 0 || ptsUs <= 0) return false;
    const audioLeadMs = (ptsUs - lastVideoPts) / 1000;
    // Allow audio to schedule comfortably ahead (up to 8000ms / 8s prefetch buffer window) without stalling,
    // while preventing audio from running wildly ahead (> 35s) during genuine video stalls.
    return audioLeadMs > 8000 && audioLeadMs < 35000;
  }

  private scheduleOrHold(buffer: AudioBuffer, ptsUs: number, now: number): void {
    const isVideoBuffering =
      typeof this.avSync.isVideoBuffering === 'function' ? this.avSync.isVideoBuffering() : false;
    if (this.overflowQueue.length > 0 || isVideoBuffering || this.isAudioAheadOfVideo(ptsUs)) {
      this.pushOverflow({ buffer, ptsUs });
      this.trimOverflowIfNeeded();
      return;
    }

    let startAt = this.nextPlayTime;
    // If nextPlayTime has been overtaken by hardware currentTime (underrun or initial frame),
    // clamp safely to a healthy 80ms lookahead cushion so playback does not repeatedly underrun on minor jitter!
    if (startAt < now + 0.005) {
      startAt = now + 0.08;
    }

    const bufferedAhead = startAt - now;
    const maxScheduleWindow = AudioPlayer.MAX_SCHEDULE_AHEAD_SEC + this.additionalDelaySec;

    if (bufferedAhead > maxScheduleWindow) {
      this.pushOverflow({ buffer, ptsUs });
      this.trimOverflowIfNeeded();
      return;
    }

    this.scheduleSourceNode(buffer, ptsUs, startAt);
    this.nextPlayTime = startAt + buffer.duration;
  }

  public syncWithVideo(): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const isVideoBuffering =
      typeof this.avSync.isVideoBuffering === 'function' ? this.avSync.isVideoBuffering() : false;
    if (isVideoBuffering) return;

    const now = this.ctx.currentTime;

    // バッファリング明け等で停止していた場合、overflowQueue があれば即座に再生再開
    if (!this.isPlaying && this.overflowQueue.length > 0) {
      this.isPlaying = true;
      this.nextPlayTime = now + AudioPlayer.HARDWARE_LOOKAHEAD_SEC;
    }

    const lastVideoPts = this.avSync.getLastVideoPts();
    const scheduledAheadUs = this.isPlaying
      ? Math.round(Math.max(0, this.nextPlayTime - now) * 1_000_000)
      : 0;
    const targetAudioPtsUs = lastVideoPts > 0 ? lastVideoPts + scheduledAheadUs : 0;
    const headPtsAtCheck = this.overflowQueue.length > 1 ? this.overflowQueue[0].ptsUs : 0;
    const staleLagMs =
      headPtsAtCheck > 0 && targetAudioPtsUs > 0 ? (targetAudioPtsUs - headPtsAtCheck) / 1000 : 0;

    // Only drop truly stale audio on major timeline discontinuity (> 1500ms behind).
    // Never drop frames on minor jitter (<= 1.5s) to guarantee zero crackling/clipping clicks!
    // Once triggered (> 1500ms), drop stale overflow chunks down to near targetAudioPtsUs (> 60ms)
    // in a single clean resync instead of leaving 1500ms of residual lag behind.
    let droppedStaleCount = 0;
    let firstDroppedPtsUs = 0;
    let lastDroppedPtsUs = 0;
    if (staleLagMs > 1500) {
      while (this.overflowQueue.length > 1) {
        const headPts = this.overflowQueue[0].ptsUs;
        if (headPts > 0 && (targetAudioPtsUs - headPts) / 1000 > 60) {
          if (droppedStaleCount === 0) firstDroppedPtsUs = headPts;
          lastDroppedPtsUs = headPts;
          this.shiftOverflow();
          droppedStaleCount++;
        } else {
          break;
        }
      }
    }
    if (droppedStaleCount > 0 && this.telemetry?.isEnabled()) {
      this.telemetry.recordAudio('drop_stale_audio', {
        droppedCount: droppedStaleCount,
        firstDroppedPtsUs,
        lastDroppedPtsUs,
        lastVideoPts,
        targetAudioPtsUs,
        remainingOverflowLength: this.overflowQueue.length,
      });
    }

    this.pumpOverflowQueue(now);
  }

  private pumpOverflowQueue(now: number): void {
    const isVideoBuffering =
      typeof this.avSync.isVideoBuffering === 'function' ? this.avSync.isVideoBuffering() : false;
    if (isVideoBuffering) return;

    const maxScheduleWindow = AudioPlayer.MAX_SCHEDULE_AHEAD_SEC + this.additionalDelaySec;
    while (this.overflowQueue.length > 0) {
      const peek = this.overflowQueue[0];
      if (this.isAudioAheadOfVideo(peek.ptsUs)) {
        break;
      }

      let startAt = this.nextPlayTime;
      if (startAt < now + 0.005) {
        startAt = now + 0.08;
      }
      if (startAt - now > maxScheduleWindow) {
        break;
      }
      const next = this.shiftOverflow()!;
      this.scheduleSourceNode(next.buffer, next.ptsUs, startAt);
      this.nextPlayTime = startAt + next.buffer.duration;
    }
  }

  private trimOverflowIfNeeded(): void {
    while (
      this.totalOverflowDurationSec > AudioPlayer.MAX_CATCHUP_BUFFER_SEC &&
      this.overflowQueue.length > 1
    ) {
      const removed = this.shiftOverflow();
      if (removed && this.telemetry?.isEnabled()) {
        this.telemetry.recordAudio('trim_overflow', {
          droppedPtsUs: removed.ptsUs,
          droppedDurationSec: removed.buffer.duration,
          remainingOverflowSec: Math.round(this.totalOverflowDurationSec * 10) / 10,
        });
      }
    }
  }

  private scheduleSourceNode(buffer: AudioBuffer, ptsUs: number, startAt: number): void {
    if (!this.ctx || this.ctx.state !== 'running') return;

    try {
      this.ensureMasterGain();

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      // Audio is master clock: playbackRate is always 1.0 (no pitch warping)
      source.playbackRate.value = 1.0;
      if (this.masterGain) {
        source.connect(this.masterGain);
      } else {
        source.connect(this.ctx.destination);
      }
      source.start(startAt);

      this.scheduledSources.add(source);
      source.onended = () => {
        this.scheduledSources.delete(source);
        try {
          source.disconnect();
        } catch {}
        if (this.ctx && this.ctx.state === 'running' && this.overflowQueue.length > 0) {
          this.pumpOverflowQueue(this.ctx.currentTime);
        }
      };

      this.avSync.updateAudioPts(ptsUs, startAt);
    } catch (err) {
      console.warn('[AudioPlayer] Source start error:', err);
    }
  }

  public stopAllScheduledSources(): void {
    for (const source of this.scheduledSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {}
    }
    this.scheduledSources.clear();
  }

  public resetJitterBuffer(): void {
    this.isPlaying = false;
    this.bufferQueue = [];
    this.overflowQueue = [];
    this.totalOverflowDurationSec = 0;
    this.nextPlayTime = 0;
    this.stopAllScheduledSources();
    this.avSync.clearAudioAnchor();
  }

  public jumpToLive(): void {
    this.resetJitterBuffer();
  }

  public close(): void {
    this.resetJitterBuffer();
    if (this.masterGain) {
      try {
        this.masterGain.disconnect();
      } catch {}
      this.masterGain = null;
    }
    if (this.audioDecoder) {
      try {
        this.audioDecoder.close();
      } catch {}
      this.audioDecoder = null;
    }
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch {}
      this.ctx = null;
    }
  }
}
