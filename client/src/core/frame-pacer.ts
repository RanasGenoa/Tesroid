import { CanvasRenderer } from './canvas-renderer.js';
import { LatencyMode } from './latency.js';
import { AvSyncController } from './av-sync.js';
import type { TelemetryCollector } from './telemetry.js';

export interface QueuedVideoFrame {
  frame: VideoFrame;
  ptsUs: number;
  scheduledRenderTime: number;
}

export interface FramePacerOptions {
  enableAutoCushion?: boolean;
  stallThresholdMs?: number;
  minCushionMs?: number;
  maxCushionMs?: number;
  maxWaitMs?: number;
  maxQueueSize?: number;
}

export class FramePacer {
  private renderer: CanvasRenderer;
  private avSync?: AvSyncController;
  private mode: LatencyMode = 'PASSIVE_STREAMING';
  private targetFps: number = 30;
  private additionalDelayMs: number = 0;

  // Auto-cushioning & stall recovery state for unstable mobile networks
  private enableAutoCushion: boolean;
  private stallThresholdMs: number;
  private minCushionMs: number;
  private maxCushionMs: number;
  private maxWaitMs: number;
  private maxQueueSize: number;

  private autoCushionMs: number = 0;
  private isBuffering: boolean = false;
  private bufferingStartTimeMs: number = 0;
  private bufferingTimer: any = null;
  private quietFramesCount: number = 0;

  // Timeline tracking for strict 1x PTS-paced playback (prevents fast-forward bursts)
  private frameQueue: QueuedVideoFrame[] = [];
  private pacingTimer: any = null;
  private lastScheduledTimeMs: number = 0;
  private lastScheduledPtsUs: number = -1;
  private lastArrivalTimeMs: number = -1;
  private lastArrivalPtsUs: number = -1;
  private lastRenderedPtsUs: number = 0;
  private hasRenderedAny: boolean = false;
  private telemetry?: TelemetryCollector;
  private lastPllNudgeLogTimeMs: number = -Infinity;
  private pllNudgeSuppressedCount: number = 0;
  private static readonly PLL_NUDGE_LOG_INTERVAL_MS = 500;

  public onFrameDropped?: () => void;
  public onFrameProcessed?: () => void;
  public onBufferingChange?: (isBuffering: boolean) => void;

  constructor(
    renderer: CanvasRenderer,
    targetFps: number = 30,
    avSync?: AvSyncController,
    options: FramePacerOptions = {}
  ) {
    this.renderer = renderer;
    this.avSync = avSync;
    this.setTargetFps(targetFps);

    this.enableAutoCushion = options.enableAutoCushion ?? true;
    this.stallThresholdMs = options.stallThresholdMs ?? 120;
    this.minCushionMs = options.minCushionMs ?? 180;
    this.maxCushionMs = options.maxCushionMs ?? 450;
    this.maxWaitMs = options.maxWaitMs ?? 450;
    this.maxQueueSize = options.maxQueueSize ?? 300; // Up to 10s @ 30fps without dropping
  }

  public setTargetFps(fps: number): void {
    this.targetFps = fps > 0 ? fps : 30;
  }

  public setTelemetryCollector(telemetry?: TelemetryCollector): void {
    this.telemetry = telemetry;
  }

  public getTargetFps(): number {
    return this.targetFps;
  }

  public getFrameIntervalMs(): number {
    return 1000 / this.targetFps;
  }

  public setMode(mode: LatencyMode): void {
    const prevMode = this.mode;
    this.mode = mode;
    if (mode === 'ACTIVE_INTERACTION') {
      this.flushQueue();
    } else if (prevMode === 'ACTIVE_INTERACTION' && mode === 'PASSIVE_STREAMING') {
      // DirectLive から通常再生へ復帰した瞬間:
      // 次のフレームをスピーカー再生中の音声PTSに正しくアンカーさせるため基準をリセット
      this.lastScheduledTimeMs = 0;
      this.lastScheduledPtsUs = -1;
    }
  }

  public getMode(): LatencyMode {
    return this.mode;
  }

  public setAdditionalDelay(delayMs: number): void {
    this.additionalDelayMs = Math.max(0, delayMs);
    if (this.additionalDelayMs === 0 && this.autoCushionMs === 0 && !this.isBuffering && this.frameQueue.length <= 1) {
      this.flushQueue();
    }
  }

  public getAdditionalDelay(): number {
    return this.additionalDelayMs;
  }

  public getAutoCushionMs(): number {
    return Math.round(this.autoCushionMs);
  }

  public getEffectiveDelayMs(): number {
    return Math.max(this.additionalDelayMs, Math.round(this.autoCushionMs));
  }

  public getIsBuffering(): boolean {
    return this.isBuffering;
  }

  public getQueueLength(): number {
    return this.frameQueue.length;
  }

  public getLastRenderedPtsUs(): number {
    return this.lastRenderedPtsUs;
  }

  /**
   * Returns total buffered video duration in milliseconds currently held in FramePacer queue.
   */
  public getBufferedDurationMs(): number {
    if (this.frameQueue.length === 0) return 0;
    if (this.frameQueue.length === 1) {
      const now = performance.now();
      return Math.max(0, Math.round(this.frameQueue[0].scheduledRenderTime - now));
    }
    const first = this.frameQueue[0];
    const last = this.frameQueue[this.frameQueue.length - 1];
    const ptsSpanMs = (last.ptsUs - first.ptsUs) / 1000;
    const scheduleSpanMs = last.scheduledRenderTime - first.scheduledRenderTime;
    const span = ptsSpanMs > 0 ? ptsSpanMs : scheduleSpanMs;
    return Math.max(0, Math.round(span + this.getFrameIntervalMs()));
  }

  /**
   * Returns only the PTS span of unread frames currently in the queue (used for buffering readiness).
   */
  private getQueuedPtsSpanMs(): number {
    if (this.frameQueue.length === 0) return 0;
    const intervalMs = this.getFrameIntervalMs();
    if (this.frameQueue.length === 1) return Math.round(intervalMs);
    const first = this.frameQueue[0];
    const last = this.frameQueue[this.frameQueue.length - 1];
    const ptsSpanMs = (last.ptsUs - first.ptsUs) / 1000;
    if (ptsSpanMs > 0 && ptsSpanMs < 60000) {
      return Math.round(ptsSpanMs + intervalMs);
    }
    return Math.round(this.frameQueue.length * intervalMs);
  }

  /**
   * Computes frame interval in ms between two consecutive frames using their PTS.
   * Falls back to target frame interval if PTS is synthetic or out of normal bounds.
   */
  private computeDeltaPtsMs(currentPtsUs: number, prevPtsUs: number): number {
    const nominalMs = this.getFrameIntervalMs();
    if (prevPtsUs < 0 || currentPtsUs <= prevPtsUs) {
      return nominalMs;
    }
    const diffUs = currentPtsUs - prevPtsUs;
    // Standard microsecond PTS difference (between 5ms and 250ms)
    if (diffUs >= 5000 && diffUs <= 250000) {
      return diffUs / 1000;
    }
    // Millisecond-scale test mock timestamps (between 8 and 250)
    if (diffUs >= 8 && diffUs <= 250) {
      return diffUs;
    }
    return nominalMs;
  }

  public queueFrame(frame: VideoFrame): void {
    const now = performance.now();
    const nominalMs = this.getFrameIntervalMs();
    const rawTimestamp = typeof frame.timestamp === 'number' ? frame.timestamp : -1;
    const ptsUs =
      rawTimestamp >= 0
        ? rawTimestamp
        : this.lastScheduledPtsUs >= 0
          ? this.lastScheduledPtsUs + Math.round(nominalMs * 1000)
          : Math.round(now * 1000);

    // Immediate render in explicit ACTIVE_INTERACTION mode
    if (this.mode === 'ACTIVE_INTERACTION') {
      this.flushQueue();
      this.renderFrameInternal(frame, ptsUs, now);
      this.lastScheduledTimeMs = now;
      this.lastScheduledPtsUs = ptsUs;
      this.lastArrivalTimeMs = now;
      this.lastArrivalPtsUs = ptsUs;
      return;
    }

    // Detect network stall (packet clogging followed by delayed arrival):
    // If wall-clock arrival gap is large (> stallThresholdMs), AND the stream PTS gap is significantly smaller
    // than the wall-clock arrival gap (meaning the frame was generated earlier on the server and got stuck in transit,
    // NOT a static screen or slow browser render where PTS also advances by arrivalGapMs!),
    // then packets were genuinely clogged in transit.
    if (this.enableAutoCushion && this.hasRenderedAny && this.lastArrivalTimeMs >= 0) {
      const arrivalGapMs = now - this.lastArrivalTimeMs;
      const ptsGapUs = this.lastArrivalPtsUs >= 0 ? ptsUs - this.lastArrivalPtsUs : -1;
      const ptsGapMs =
        ptsGapUs >= 5000 && ptsGapUs <= 60_000_000
          ? ptsGapUs / 1000
          : ptsGapUs >= 8 && ptsGapUs < 5000
            ? ptsGapUs
            : nominalMs;

      // Transit delay accumulated during this gap = how much longer it took to arrive than the PTS time between frames
      const transitDelayIncreaseMs = arrivalGapMs - ptsGapMs;

      const isNetworkStall =
        arrivalGapMs >= this.stallThresholdMs &&
        ptsGapMs > 0 &&
        transitDelayIncreaseMs >= Math.max(90, this.stallThresholdMs * 0.65) &&
        ptsGapMs <= arrivalGapMs * 0.65;

      if (isNetworkStall) {
        this.quietFramesCount = 0;
        if (this.telemetry?.isEnabled()) {
          this.telemetry.recordBuffering('network_stall', {
            arrivalGapMs,
            ptsGapMs,
            transitDelayIncreaseMs,
            autoCushionMs: this.autoCushionMs,
            queueLength: this.frameQueue.length,
          });
        }
        // Raise adaptive client cushion to absorb ongoing instability
        this.autoCushionMs = Math.min(
          this.maxCushionMs,
          Math.max(this.minCushionMs, this.autoCushionMs + 90)
        );

        // If playback queue ran dry (underrun), pause playback briefly until unread frames accumulate
        if (this.frameQueue.length <= 1 && !this.isBuffering) {
          this.enterBufferingState(now);
        }
      } else if (transitDelayIncreaseMs <= 35) {
        this.quietFramesCount++;
        // Faster decay of autoCushionMs after ~3 seconds (90 frames) of smooth delivery so latency returns to real-time
        if (this.quietFramesCount > 90 && this.autoCushionMs > 0 && this.frameQueue.length <= 2) {
          this.autoCushionMs = Math.max(0, this.autoCushionMs - 3.0);
        }
      }
    }

    this.lastArrivalTimeMs = now;
    this.lastArrivalPtsUs = ptsUs;

    const effectiveDelayMs = Math.max(this.additionalDelayMs, Math.round(this.autoCushionMs));

    // Calculate strict 1x PTS-based scheduled render time
    let scheduledRenderTime: number;
    const deltaMs = this.computeDeltaPtsMs(ptsUs, this.lastScheduledPtsUs);

    const playingAudioPts = typeof this.avSync?.getCurrentPlayingAudioPtsUs === 'function'
      ? this.avSync.getCurrentPlayingAudioPtsUs()
      : null;

    if (this.frameQueue.length === 0 && !this.isBuffering) {
      // Queue is empty: pace smoothly by deltaMs after previous rendered frame
      let earliestNextSlot = this.hasRenderedAny ? this.lastScheduledTimeMs + deltaMs : now;

      // 音声が再生中の場合、音声クロックとの誤差を毎フレーム最大±2.0msだけ微小補正（PLLスムーズ吸着）
      // 画面をガクッと止めることなく、滑らかな30fpsのまま完全に音声へ収束させる
      if (playingAudioPts !== null && playingAudioPts > 0) {
        const audioTargetTime = now + (ptsUs - playingAudioPts) / 1000;
        const errorMs = audioTargetTime - earliestNextSlot;
        if (Math.abs(errorMs) >= 15) {
          const nudge = Math.sign(errorMs) * Math.min(2.0, Math.abs(errorMs) * 0.15);
          earliestNextSlot += nudge;
        }
      }

      const targetRealtimeSlot =
        this.additionalDelayMs > 0 ? Math.max(now + this.additionalDelayMs, earliestNextSlot) : earliestNextSlot;
      scheduledRenderTime = Math.max(now, targetRealtimeSlot);

      // If the frame slot is due right now (or within 2ms), render immediately without timer/queue overhead!
      if (scheduledRenderTime <= now + 2) {
        this.renderFrameInternal(frame, ptsUs, now);
        this.lastScheduledTimeMs = now;
        this.lastScheduledPtsUs = ptsUs;
        return;
      }
    } else {
      // Queue already has frames or we are buffering: pace by deltaMs after previous scheduled frame!
      // Strict 1.0x PTS pacing: never fast-forward (drainFactor = 1.0) to prevent video speed-up and audio crackling!
      const minBase = this.isBuffering ? now + effectiveDelayMs : now;
      scheduledRenderTime = Math.max(minBase, this.lastScheduledTimeMs + deltaMs);
    }

    this.lastScheduledTimeMs = scheduledRenderTime;
    this.lastScheduledPtsUs = ptsUs;
    this.frameQueue.push({ frame, ptsUs, scheduledRenderTime });

    // Protect against unbounded memory only if queue exceeds maxQueueSize (default 300 frames = ~10s)
    while (this.frameQueue.length > this.maxQueueSize) {
      const dropped = this.frameQueue.shift();
      if (dropped) {
        try {
          dropped.frame.close();
        } catch {}
        if (this.telemetry?.isEnabled()) {
          this.telemetry.recordPacer('frame_dropped', {
            ptsUs: dropped.ptsUs,
            queueLength: this.frameQueue.length,
            maxQueueSize: this.maxQueueSize,
          });
        }
        this.onFrameDropped?.();
        this.onFrameProcessed?.();
      }
    }

    // If waiting for cushion accumulation, check if enough unread frames have arrived
    if (this.isBuffering) {
      this.checkBufferingReady(now);
      return;
    }

    this.scheduleNextFlush();
  }

  private enterBufferingState(now: number): void {
    this.isBuffering = true;
    this.bufferingStartTimeMs = now;
    if (this.telemetry?.isEnabled()) {
      this.telemetry.recordBuffering('enter', {
        autoCushionMs: this.autoCushionMs,
        effectiveDelayMs: this.getEffectiveDelayMs(),
        queueLength: this.frameQueue.length,
        queuedPtsMs: this.getQueuedPtsSpanMs(),
      });
    }
    if (this.pacingTimer !== null) {
      clearTimeout(this.pacingTimer);
      this.pacingTimer = null;
    }
    if (typeof this.avSync?.setVideoBuffering === 'function') {
      this.avSync.setVideoBuffering(true);
    }
    this.onBufferingChange?.(true);

    if (this.bufferingTimer) clearTimeout(this.bufferingTimer);
    this.bufferingTimer = setTimeout(() => {
      this.bufferingTimer = null;
      if (this.isBuffering) {
        this.exitBufferingAndResume(performance.now());
      }
    }, this.maxWaitMs);
  }

  private checkBufferingReady(now: number): void {
    if (!this.isBuffering) return;
    const targetCushion = Math.max(this.minCushionMs, this.getEffectiveDelayMs());
    const queuedPtsMs = this.getQueuedPtsSpanMs();
    const minFrames = Math.max(4, Math.ceil(targetCushion / this.getFrameIntervalMs()));

    if (
      queuedPtsMs >= targetCushion ||
      this.frameQueue.length >= minFrames ||
      now - this.bufferingStartTimeMs >= this.maxWaitMs
    ) {
      this.exitBufferingAndResume(now);
    }
  }

  private exitBufferingAndResume(now: number): void {
    if (!this.isBuffering) return;
    this.isBuffering = false;
    if (this.telemetry?.isEnabled()) {
      const durationMs = Math.round(now - this.bufferingStartTimeMs);
      this.telemetry.recordBuffering('exit', {
        durationMs,
        queueLength: this.frameQueue.length,
        queuedPtsMs: this.getQueuedPtsSpanMs(),
        autoCushionMs: this.autoCushionMs,
      });
    }
    if (this.bufferingTimer) {
      clearTimeout(this.bufferingTimer);
      this.bufferingTimer = null;
    }
    if (typeof this.avSync?.setVideoBuffering === 'function') {
      this.avSync.setVideoBuffering(false);
    }
    this.onBufferingChange?.(false);

    // Re-anchor queued frames starting from `now` at strict 1x PTS intervals so they play smoothly without fast-forward
    if (this.frameQueue.length > 0) {
      let cursorTime = now;
      const playingAudioPts = typeof this.avSync?.getCurrentPlayingAudioPtsUs === 'function'
        ? this.avSync.getCurrentPlayingAudioPtsUs()
        : null;

      if (playingAudioPts !== null && playingAudioPts > 0) {
        const audioAlignedStart = now + (this.frameQueue[0].ptsUs - playingAudioPts) / 1000;
        cursorTime = Math.max(now, audioAlignedStart);
      }

      for (let i = 0; i < this.frameQueue.length; i++) {
        if (i > 0) {
          const dMs = this.computeDeltaPtsMs(this.frameQueue[i].ptsUs, this.frameQueue[i - 1].ptsUs);
          cursorTime += dMs;
        }
        this.frameQueue[i].scheduledRenderTime = cursorTime;
      }
      this.lastScheduledTimeMs = cursorTime;
      this.lastScheduledPtsUs = this.frameQueue[this.frameQueue.length - 1].ptsUs;
    }

    this.processQueue();
  }

  private scheduleNextFlush(): void {
    if (this.isBuffering || this.pacingTimer !== null || this.frameQueue.length === 0) return;

    const now = performance.now();
    const nextItem = this.frameQueue[0];
    const delay = Math.max(0, Math.round(nextItem.scheduledRenderTime - now));

    this.pacingTimer = setTimeout(() => {
      this.pacingTimer = null;
      this.processQueue();
    }, delay);
  }

  private processQueue(): void {
    if (this.isBuffering || this.frameQueue.length === 0) return;

    const now = performance.now();
    const nextItem = this.frameQueue[0];

    if (nextItem.scheduledRenderTime <= now + 2) {
      this.frameQueue.shift();
      this.renderFrameInternal(nextItem.frame, nextItem.ptsUs, now);

      // CRITICAL: Never render multiple queued frames in a tight while-loop (prevents fast-forward burst!).
      // If subsequent frames are behind `now` due to timer lag, smoothly shift their schedule forward from `now`
      // preserving their exact 1x PTS spacing!
      if (this.frameQueue.length > 0) {
        const dMs = this.computeDeltaPtsMs(this.frameQueue[0].ptsUs, nextItem.ptsUs);
        const minNextTime = now + Math.max(8, dMs);
        if (this.frameQueue[0].scheduledRenderTime < minNextTime) {
          const shift = minNextTime - this.frameQueue[0].scheduledRenderTime;
          for (const item of this.frameQueue) {
            item.scheduledRenderTime += shift;
          }
          this.lastScheduledTimeMs += shift;
        }

        // A/V Sync Phase-Locked Loop (リップシンク自動補正):
        // スピーカー出力中の音声PTSに合わせ、映像スケジュールを微小シフトして完全に一致させる
        if (typeof this.avSync?.getCurrentPlayingAudioPtsUs === 'function') {
          const playingAudioPts = this.avSync.getCurrentPlayingAudioPtsUs();
          if (playingAudioPts !== null && playingAudioPts > 0) {
            const nextVideoPts = this.frameQueue[0].ptsUs;
            const targetRenderTime = now + (nextVideoPts - playingAudioPts) / 1000;
            const syncErrorMs = targetRenderTime - this.frameQueue[0].scheduledRenderTime;

            if (Math.abs(syncErrorMs) > 150) {
              // 150ms以上の顕著なズレは、全フレームを一括で瞬時に音声へ吸着再同期！
              const shift = targetRenderTime - this.frameQueue[0].scheduledRenderTime;
              if (this.telemetry?.isEnabled()) {
                this.telemetry.recordAvSync('large_shift', {
                  syncErrorMs: Math.round(syncErrorMs),
                  shift: Math.round(shift),
                  nextVideoPts,
                  playingAudioPts,
                  queueLength: this.frameQueue.length,
                });
              }
              for (const item of this.frameQueue) {
                item.scheduledRenderTime += shift;
              }
              this.lastScheduledTimeMs += shift;
            } else if (Math.abs(syncErrorMs) >= 15) {
              // 15ms〜150msの微小ズレは、毎フレーム最大±2.5msずつ全フレームをスムーズに吸着
              const nudge = Math.sign(syncErrorMs) * Math.min(2.5, Math.abs(syncErrorMs) * 0.2);
              if (this.telemetry?.isEnabled()) {
                if (now - this.lastPllNudgeLogTimeMs >= FramePacer.PLL_NUDGE_LOG_INTERVAL_MS) {
                  this.telemetry.recordAvSync('pll_nudge', {
                    syncErrorMs: Math.round(syncErrorMs),
                    nudge: Math.round(nudge * 10) / 10,
                    nextVideoPts,
                    playingAudioPts,
                    suppressedCount: this.pllNudgeSuppressedCount,
                  });
                  this.lastPllNudgeLogTimeMs = now;
                  this.pllNudgeSuppressedCount = 0;
                } else {
                  this.pllNudgeSuppressedCount++;
                }
              }
              for (const item of this.frameQueue) {
                item.scheduledRenderTime += nudge;
              }
              this.lastScheduledTimeMs += nudge;
            }
          }
        }
      }
    }

    if (this.frameQueue.length > 0) {
      this.scheduleNextFlush();
    }
  }

  private renderFrameInternal(frame: VideoFrame, ptsUs: number, _nowMs: number): void {
    this.hasRenderedAny = true;
    this.lastRenderedPtsUs = ptsUs;
    this.avSync?.updateVideoPts(ptsUs);
    this.renderer.render(frame);
    this.onFrameProcessed?.();
  }

  /**
   * Flush all queued frames and render the latest frame immediately (used when jumping to LIVE).
   */
  public flushQueue(): void {
    if (this.pacingTimer !== null) {
      clearTimeout(this.pacingTimer);
      this.pacingTimer = null;
    }
    if (this.bufferingTimer !== null) {
      clearTimeout(this.bufferingTimer);
      this.bufferingTimer = null;
    }
    if (this.isBuffering) {
      this.isBuffering = false;
      if (typeof this.avSync?.setVideoBuffering === 'function') {
        this.avSync.setVideoBuffering(false);
      }
      this.onBufferingChange?.(false);
    }

    if (this.frameQueue.length === 0) return;

    while (this.frameQueue.length > 1) {
      const item = this.frameQueue.shift();
      if (item) {
        try {
          item.frame.close();
        } catch {}
        this.onFrameProcessed?.();
      }
    }

    const last = this.frameQueue.shift();
    if (last) {
      const now = performance.now();
      this.renderFrameInternal(last.frame, last.ptsUs, now);
      this.lastScheduledTimeMs = now;
      this.lastScheduledPtsUs = last.ptsUs;
    }
  }

  /**
   * Explicitly discard catchup buffer and jump to real-time live stream.
   */
  public jumpToLive(): void {
    this.autoCushionMs = 0;
    this.quietFramesCount = 0;
    this.flushQueue();
  }

  /**
   * Complete reset for stream restart or disconnect.
   */
  public reset(): void {
    if (this.pacingTimer !== null) {
      clearTimeout(this.pacingTimer);
      this.pacingTimer = null;
    }
    if (this.bufferingTimer !== null) {
      clearTimeout(this.bufferingTimer);
      this.bufferingTimer = null;
    }
    if (this.isBuffering) {
      this.isBuffering = false;
      if (typeof this.avSync?.setVideoBuffering === 'function') {
        this.avSync.setVideoBuffering(false);
      }
      this.onBufferingChange?.(false);
    }
    for (const item of this.frameQueue) {
      try {
        item.frame.close();
      } catch {}
    }
    this.frameQueue = [];
    this.autoCushionMs = 0;
    this.quietFramesCount = 0;
    this.lastScheduledTimeMs = 0;
    this.lastScheduledPtsUs = -1;
    this.lastArrivalTimeMs = -1;
    this.lastArrivalPtsUs = -1;
    this.lastRenderedPtsUs = 0;
    this.hasRenderedAny = false;
    this.lastPllNudgeLogTimeMs = -Infinity;
    this.pllNudgeSuppressedCount = 0;
  }

  public resetFirstFrame(): void {
    this.reset();
  }

  public destroy(): void {
    this.reset();
  }
}
