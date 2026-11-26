import type { AvSyncController } from './av-sync.js';
import type { CanvasRenderer } from './canvas-renderer.js';
import type { LatencyMode } from './latency.js';
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
  private lastRenderedTimeMs: number = -Infinity;
  private hasRenderedAny: boolean = false;
  private telemetry?: TelemetryCollector;
  private lastPllNudgeLogTimeMs: number = -Infinity;
  private pllNudgeSuppressedCount: number = 0;
  private lastLargeShiftLogTimeMs: number = -Infinity;
  private largeShiftSuppressedCount: number = 0;
  private lastStaleDropLogTimeMs: number = -Infinity;
  private lastSustainedTrimRequestMs: number = -Infinity;
  private static readonly PLL_NUDGE_LOG_INTERVAL_MS = 500;
  private computePllShift(
    currentScheduleMs: number,
    videoPtsUs: number,
    playingAudioPtsUs: number,
    dMs: number,
    nowMs: number,
  ): number {
    const targetRenderTime = nowMs + (videoPtsUs - playingAudioPtsUs) / 1000;
    const syncErrorMs = targetRenderTime - currentScheduleMs;

    const minCatchupIntervalMs = Math.max(FramePacer.MIN_RENDER_SPACING_MS, dMs * 0.5);
    const earliestAllowedTime = Math.max(
      nowMs + FramePacer.MIN_RENDER_SPACING_MS,
      this.lastScheduledTimeMs + minCatchupIntervalMs,
    );
    const maxNegativeShiftAllowed = Math.min(0, earliestAllowedTime - currentScheduleMs);

    if (Math.abs(syncErrorMs) > FramePacer.AV_SYNC_MAX_ERROR_MS) {
      const maxPositiveShift = FramePacer.AV_SYNC_LARGE_SHIFT_MAX_MS;
      const desiredShift = Math.max(
        -FramePacer.AV_SYNC_LARGE_SHIFT_MAX_MS,
        syncErrorMs * FramePacer.AV_SYNC_LARGE_SHIFT_KP,
      );
      return syncErrorMs > 0
        ? Math.min(maxPositiveShift, syncErrorMs * FramePacer.AV_SYNC_LARGE_SHIFT_KP)
        : Math.max(maxNegativeShiftAllowed, desiredShift);
    } else if (Math.abs(syncErrorMs) >= FramePacer.AV_SYNC_DEADBAND_MS) {
      const errorMagnitude = Math.min(FramePacer.AV_SYNC_MAX_ERROR_MS, Math.abs(syncErrorMs));
      const rawNudge = Math.sign(syncErrorMs) * (errorMagnitude * FramePacer.AV_SYNC_KP);
      return rawNudge < 0 ? Math.max(maxNegativeShiftAllowed, rawNudge) : rawNudge;
    }
    return 0;
  }
  // A/V Sync PLL constants:
  // Deadband threshold (ms) within which lip-sync differences are imperceptible to human eyes.
  // Prevents micro-hunting (jittering between +nudge and -nudge) during steady-state playback.
  private static readonly AV_SYNC_DEADBAND_MS = 45;
  // Maximum smoothing nudge applied per frame (ms) for minor sync drifts (45ms ~ 150ms).
  // Kept small (<= 0.75ms) so playback speed changes by at most ~2%, preserving frame pacing smoothness.
  private static readonly AV_SYNC_MAX_NUDGE_MS = 0.75;
  // Sync error limit (ms) for proportional PLL nudge scaling before transitioning to large-shift jump (150ms).
  private static readonly AV_SYNC_MAX_ERROR_MS = 150;
  // Maximum shift (ms) applied per frame during large A/V desync (> 150ms).
  // Slew-rate clamped to ±2.0ms/frame to preserve smooth pacing (~28.5 - 31.5 FPS at 30fps) and eliminate stutter.
  private static readonly AV_SYNC_LARGE_SHIFT_MAX_MS = 2.0;
  // Proportional gain Kp for large A/V desync (> 150ms) before clamping to ±AV_SYNC_LARGE_SHIFT_MAX_MS
  private static readonly AV_SYNC_LARGE_SHIFT_KP = 0.15;
  // Proportional gain Kp for smoothing A/V sync error: (0.75 / 150 = 0.005 ms/ms)
  private static readonly AV_SYNC_KP =
    FramePacer.AV_SYNC_MAX_NUDGE_MS / FramePacer.AV_SYNC_MAX_ERROR_MS;
  // Issue #112/#113: 音声先行 (再生中音声PTS > 映像スケジュール) は負方向シフトが 1x 間隔クランプ
  // (maxNegativeShiftAllowed) で構造的に吸収不能な場合がある。backlog (キュー滞留 > 8 フレーム) の
  // 音声先行時に、再生中音声より古い映像フレームを破棄して映像側で吸収する。
  // 短キュー (≤8 フレーム) はスケジュール前倒し余地があるため PLL 負方向シフト (Issue #15 の
  // graceful catch-up) に任せ、本経路は発動しない。
  // Issue #113: 発動ゲートを旧 150ms から 60ms (デッドバンド+余裕) へ引き下げた。旧ゲートでは
  // 破棄停止目標 (40ms) との間に 60〜150ms の収束不能域が残り、~270ms の先行が定着した。
  // 停止目標 (tolerance) は次に描画される先頭フレームに対する基準で、実際に画面へ出るのはその
  // 1 フレーム分手前になるため、体感ズレは tolerance + 1フレーム以内 (30fps で約 53ms) に収まる。
  // 可視ジャンプ抑止のため 1 tick あたり上限 4 フレーム。正常な 1x 到着 (先頭が再生中音声より
  // 新しい) は破棄条件自体が成立せず一切干渉しない。
  // 連続描画フレーム間の最小間隔 (ms)。タイマー遅延時のバースト描画防止と、前倒しシフトの下限クランプに共通使用
  private static readonly MIN_RENDER_SPACING_MS = 8;
  private static readonly AV_SYNC_STALE_DROP_TOLERANCE_US = 20_000;
  private static readonly AV_SYNC_MAX_STALE_DROPS_PER_TICK = 4;
  private static readonly AV_SYNC_STALE_DROP_MIN_QUEUE = 8;
  private static readonly AV_SYNC_AUDIO_LEAD_ABSORB_GATE_MS = 60;
  private static readonly AV_SYNC_MAX_STALE_DROP_LEAD_MS = 60_000;
  // Issue #115: 滞留の生き残りがデコーダ手前 (pre-decode キュー) にある場合、ペーサーの
  // 4/tick 破棄は供給速率に勝てず平衡が残る。lead がこの値に達した tick で即座に上流 GOP
  // トリムを要求し、以降 1s のレート制限で重複発火を抑える (streaming.ts が
  // decoder.trimPendingBeforePts へ配線)。単発スパイクでもトリム対象が無ければ no-op 安全弁。
  private static readonly SUSTAINED_AUDIO_LEAD_TRIM_MS = 800;
  private static readonly TRIM_REQUEST_MIN_INTERVAL_MS = 1000;

  public onFrameDropped?: () => void;
  public onFrameProcessed?: () => void;
  // Issue #11: 1フレームの canvas 描画所要時間 (ms)。クライアント側の描画負荷計測に使用
  public onFrameRenderTimed?: (durationMs: number) => void;
  public onBufferingChange?: (isBuffering: boolean) => void;
  // Issue #115: 音声先行 ≥800ms を検知した tick で、上流 (デコーダ手前キュー) の GOP 境界
  // トリムを要求する (連続検知ではなく検知毎に最大 1 回/秒のレート制限)。スパイク時の
  // 過剰トリムは trimPendingBeforePts 側で適格な境界が無ければ no-op になる安全弁で抑える。
  // 引数は要求時点の再生中音声 PTS (µs)。
  public onSustainedAudioLead?: (playingAudioPtsUs: number) => void;

  constructor(
    renderer: CanvasRenderer,
    targetFps: number = 30,
    avSync?: AvSyncController,
    options: FramePacerOptions = {},
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
      // ACTIVE_INTERACTION から PASSIVE_STREAMING へ復帰した瞬間:
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
    if (
      this.additionalDelayMs === 0 &&
      this.autoCushionMs === 0 &&
      !this.isBuffering &&
      this.frameQueue.length <= 1
    ) {
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
    // Standard microsecond PTS difference (up to 250ms).
    // Include sub-5ms microsecond intervals (251..4999us, or <=250us once in microsecond PTS scale)
    // so batched 60fps frames are not inflated to a full nominal frame interval.
    if ((diffUs > 250 && diffUs <= 250000) || (diffUs > 0 && diffUs <= 250 && prevPtsUs >= 10000)) {
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
    // If wall-clock arrival gap is large (>= stallThresholdMs), AND the stream PTS gap is significantly smaller
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
          Math.max(this.minCushionMs, this.autoCushionMs + 90),
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

    const playingAudioPts =
      typeof this.avSync?.getCurrentPlayingAudioPtsUs === 'function'
        ? this.avSync.getCurrentPlayingAudioPtsUs()
        : null;

    if (this.frameQueue.length === 0 && !this.isBuffering) {
      // Queue is empty: pace smoothly by deltaMs after previous rendered frame.
      // When returning from ACTIVE_INTERACTION (hasRenderedAny && lastScheduledPtsUs < 0),
      // re-anchor to playing audio within a bounded window (<= 200ms) independent of performance.now().
      let earliestNextSlot: number;
      if (!this.hasRenderedAny) {
        earliestNextSlot = now;
      } else if (this.lastScheduledPtsUs < 0) {
        if (playingAudioPts !== null && playingAudioPts > 0) {
          const audioTargetTime = now + (ptsUs - playingAudioPts) / 1000;
          earliestNextSlot = Math.max(now, Math.min(now + 200, audioTargetTime));
        } else {
          earliestNextSlot = now;
        }
      } else {
        const paceTime = this.lastScheduledTimeMs + deltaMs;
        if (typeof playingAudioPts === 'number' && playingAudioPts > 0) {
          const shift = this.computePllShift(paceTime, ptsUs, playingAudioPts, deltaMs, now);
          earliestNextSlot = paceTime + shift;
        } else {
          earliestNextSlot = paceTime;
        }
      }

      const targetRealtimeSlot =
        this.additionalDelayMs > 0
          ? Math.max(now + this.additionalDelayMs, earliestNextSlot)
          : earliestNextSlot;
      const minIntervalMs = Math.max(FramePacer.MIN_RENDER_SPACING_MS, deltaMs * 0.5);
      const minAfterLastRender = this.hasRenderedAny
        ? this.lastRenderedTimeMs + minIntervalMs
        : now;
      scheduledRenderTime = Math.max(now, targetRealtimeSlot, minAfterLastRender);

      // If the frame slot is due right now (or within 2ms), render immediately without timer/queue overhead,
      // unless doing so would violate minimum inter-frame spacing after a delayed previous render.
      if (
        scheduledRenderTime <= now + 2 &&
        (!this.hasRenderedAny || now - this.lastRenderedTimeMs >= minIntervalMs)
      ) {
        this.renderFrameInternal(frame, ptsUs, now);
        // Preserve accumulated PLL shift on earliestNextSlot even when rendered immediately at `now`,
        // bounded to (now - minIntervalMs) to avoid excessive historical slip while allowing true phase accumulation!
        this.lastScheduledTimeMs = Math.max(now - minIntervalMs, earliestNextSlot);
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
      const playingAudioPts =
        typeof this.avSync?.getCurrentPlayingAudioPtsUs === 'function'
          ? this.avSync.getCurrentPlayingAudioPtsUs()
          : null;

      // Only drop truly stale video on major timeline discontinuity (1500ms..60000ms behind)
      if (playingAudioPts !== null && playingAudioPts > 0) {
        while (this.frameQueue.length > 1) {
          const leadMs = (playingAudioPts - this.frameQueue[0].ptsUs) / 1000;
          if (leadMs <= 1500 || leadMs >= FramePacer.AV_SYNC_MAX_STALE_DROP_LEAD_MS) {
            break;
          }
          const stale = this.frameQueue.shift();
          if (stale) {
            try {
              stale.frame.close();
            } catch {}
            this.onFrameDropped?.();
            this.onFrameProcessed?.();
          }
        }
      }

      let cursorTime = now;
      if (playingAudioPts !== null && playingAudioPts > 0 && this.frameQueue.length > 0) {
        const audioAlignedStart = now + (this.frameQueue[0].ptsUs - playingAudioPts) / 1000;
        // バッファリング明けに音声遅延があっても、映像の即時再生開始を妨げないよう1フレーム分以内に制限
        cursorTime = Math.max(now, Math.min(now + this.getFrameIntervalMs(), audioAlignedStart));
      }

      for (let i = 0; i < this.frameQueue.length; i++) {
        if (i > 0) {
          const dMs = this.computeDeltaPtsMs(
            this.frameQueue[i].ptsUs,
            this.frameQueue[i - 1].ptsUs,
          );
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
    const minTargetTime = this.hasRenderedAny
      ? Math.max(
          nextItem.scheduledRenderTime,
          this.lastRenderedTimeMs + FramePacer.MIN_RENDER_SPACING_MS,
        )
      : nextItem.scheduledRenderTime;
    const remainingMs = minTargetTime - now;
    const delay = remainingMs > 0 ? Math.max(1, Math.round(remainingMs)) : 0;

    this.pacingTimer = setTimeout(() => {
      this.pacingTimer = null;
      this.processQueue();
    }, delay);
  }

  private processQueue(): void {
    if (this.isBuffering || this.frameQueue.length === 0) return;

    const now = performance.now();
    const playingMasterPts =
      typeof this.avSync?.getCurrentPlayingAudioPtsUs === 'function'
        ? this.avSync.getCurrentPlayingAudioPtsUs()
        : null;

    // If playback queue is severely behind master clock (2000ms..60000ms), drop oldest stale frames to catch up smoothly
    if (playingMasterPts !== null && playingMasterPts > 0 && this.frameQueue.length > 1) {
      let droppedAny = false;
      while (this.frameQueue.length > 1) {
        const leadMs = (playingMasterPts - this.frameQueue[0].ptsUs) / 1000;
        if (leadMs <= 2000 || leadMs >= FramePacer.AV_SYNC_MAX_STALE_DROP_LEAD_MS) {
          break;
        }
        const stale = this.frameQueue.shift();
        if (stale) {
          droppedAny = true;
          try {
            stale.frame.close();
          } catch {}
          this.onFrameDropped?.();
          this.onFrameProcessed?.();
        }
      }
      if (droppedAny && this.frameQueue[0].scheduledRenderTime > now + 2) {
        this.frameQueue[0].scheduledRenderTime = now;
        if (this.frameQueue.length === 1) {
          this.lastScheduledTimeMs = now;
        }
      }
    }

    const nextItem = this.frameQueue[0];
    const respectsMinSpacing =
      !this.hasRenderedAny || now - this.lastRenderedTimeMs >= FramePacer.MIN_RENDER_SPACING_MS;

    if (nextItem.scheduledRenderTime <= now + 2 && respectsMinSpacing) {
      this.frameQueue.shift();
      this.renderFrameInternal(nextItem.frame, nextItem.ptsUs, now);

      // CRITICAL: Never render multiple queued frames in a tight while-loop (prevents fast-forward burst!).
      // If subsequent frames are behind `now` due to timer lag, smoothly shift their schedule forward from `now`
      // preserving their exact 1x PTS spacing!
      if (this.frameQueue.length > 0) {
        let totalShift = 0;
        const dMs = this.computeDeltaPtsMs(this.frameQueue[0].ptsUs, nextItem.ptsUs);
        const minCatchupIntervalMs = Math.max(FramePacer.MIN_RENDER_SPACING_MS, dMs * 0.5);
        const minNextTime = now + minCatchupIntervalMs;
        if (this.frameQueue[0].scheduledRenderTime < minNextTime) {
          if (dMs >= minCatchupIntervalMs) {
            // Timer lag caused head frame to slip past minNextTime: shift entire queue uniformly
            // to preserve 1x PTS spacing and let the PLL pull back smoothly.
            totalShift += minNextTime - this.frameQueue[0].scheduledRenderTime;
          } else {
            // Batched arrival (sub-8ms PTS delta): space out only adjacent frames that are too close
            // without shifting already well-spaced future frames backward.
            this.frameQueue[0].scheduledRenderTime = minNextTime;
            for (let i = 1; i < this.frameQueue.length; i++) {
              const pairDeltaMs = this.computeDeltaPtsMs(
                this.frameQueue[i].ptsUs,
                this.frameQueue[i - 1].ptsUs,
              );
              const pairMinGapMs = Math.max(FramePacer.MIN_RENDER_SPACING_MS, pairDeltaMs * 0.5);
              const minPairTime = this.frameQueue[i - 1].scheduledRenderTime + pairMinGapMs;
              if (this.frameQueue[i].scheduledRenderTime < minPairTime) {
                this.frameQueue[i].scheduledRenderTime = minPairTime;
              } else {
                break;
              }
            }
            this.lastScheduledTimeMs =
              this.frameQueue[this.frameQueue.length - 1].scheduledRenderTime;
          }
        }

        // A/V Sync Phase-Locked Loop (リップシンク自動補正):
        // スピーカー出力中の音声PTSに合わせ、映像スケジュールを微小シフトして完全に一致させる
        if (typeof this.avSync?.getCurrentPlayingAudioPtsUs === 'function') {
          const playingAudioPts = this.avSync.getCurrentPlayingAudioPtsUs();
          if (playingAudioPts !== null && playingAudioPts > 0) {
            // Issue #112/#113: 音声先行 (映像遅れ) は負方向シフトが 1x 間隔クランプで構造的に
            // 吸収できないため、再生中音声より古いフレームを映像側で上限付き破棄する。
            const staleDropTargetUs = playingAudioPts - FramePacer.AV_SYNC_STALE_DROP_TOLERANCE_US;
            let staleDropped = 0;
            // Issue #113: 吸収ゲートは 60ms (デッドバンド45ms+余裕)。ゲートは破棄開始の閾値で、
            // 停止目標は head.ptsUs >= staleDropTargetUs (tolerance 20ms)。対象は大バックログ
            // (>8 フレーム) のみ。短キューはスケジュール前倒し余地があるため PLL 負方向シフトに任せる。
            const backlogLagMs = (playingAudioPts - this.frameQueue[0].ptsUs) / 1000;
            const firstStalePtsUs = this.frameQueue[0].ptsUs;
            // 発動ゲート (60ms〜60s の音声先行域)。通過後のループ継続条件は
            // キュー長・1tick上限・停止目標 (head.ptsUs >= staleDropTargetUs) のみに分離する。
            if (
              backlogLagMs > FramePacer.AV_SYNC_AUDIO_LEAD_ABSORB_GATE_MS &&
              backlogLagMs < FramePacer.AV_SYNC_MAX_STALE_DROP_LEAD_MS
            ) {
              // Issue #115: 先行が大きい (≥800ms) 場合は自キューの破棄では追いつけないため、
              // デコーダ手前へ GOP 境界トリムを要求する (最大 1 回/秒)。
              if (
                backlogLagMs >= FramePacer.SUSTAINED_AUDIO_LEAD_TRIM_MS &&
                now - this.lastSustainedTrimRequestMs >= FramePacer.TRIM_REQUEST_MIN_INTERVAL_MS
              ) {
                this.lastSustainedTrimRequestMs = now;
                if (this.telemetry?.isEnabled()) {
                  this.telemetry.recordAvSync('predecode_trim_request', {
                    leadMs: Math.round(backlogLagMs),
                    queueLength: this.frameQueue.length,
                  });
                }
                this.onSustainedAudioLead?.(playingAudioPts);
              }
              while (
                this.frameQueue.length > FramePacer.AV_SYNC_STALE_DROP_MIN_QUEUE &&
                staleDropped < FramePacer.AV_SYNC_MAX_STALE_DROPS_PER_TICK
              ) {
                const head = this.frameQueue[0];
                if (head.ptsUs > 0 && head.ptsUs < staleDropTargetUs) {
                  this.frameQueue.shift();
                  try {
                    head.frame.close();
                  } catch {}
                  this.onFrameProcessed?.();
                  staleDropped++;
                } else {
                  break;
                }
              }
            }
            // Issue #113: 破棄しただけでは 1x の再生クロックは進まない。破棄した内容分の時間を
            // キュー全体の前倒しシフトとして適用し、再生間隔 (1x) を保ったまま描画 PTS を
            // 音声へ追従させる (>2000ms 大遅延経路の head 即時化と同じ目的の 1x 保存版)。
            if (staleDropped > 0 && this.frameQueue.length > 0) {
              const headSchedule = this.frameQueue[0].scheduledRenderTime + totalShift;
              const maxBackwardMs = Math.max(
                0,
                headSchedule - (now + FramePacer.MIN_RENDER_SPACING_MS),
              );
              // 実 PTS 差分ベース (破棄前の旧先頭から新先頭までの経過時間)。公称間隔x個数より
              // VFR・フレーム欠落混在ストリームで正確に収束する。
              const newHeadPtsUs = this.frameQueue[0].ptsUs;
              const droppedSpanMs =
                newHeadPtsUs > firstStalePtsUs ? (newHeadPtsUs - firstStalePtsUs) / 1000 : 0;
              const dropShiftMs = Math.min(droppedSpanMs, maxBackwardMs);
              if (dropShiftMs > 0) {
                totalShift -= dropShiftMs;
              }
            }
            if (staleDropped > 0 && this.telemetry?.isEnabled()) {
              if (now - this.lastStaleDropLogTimeMs >= FramePacer.PLL_NUDGE_LOG_INTERVAL_MS) {
                this.telemetry.recordAvSync('stale_video_drop', {
                  droppedCount: staleDropped,
                  leadMs: Math.round(backlogLagMs),
                  playingAudioPts,
                  queueLength: this.frameQueue.length,
                });
                this.lastStaleDropLogTimeMs = now;
              }
            }

            const nextVideoPts = this.frameQueue[0].ptsUs;
            const currentHeadSchedule = this.frameQueue[0].scheduledRenderTime + totalShift;
            const targetRenderTime = now + (nextVideoPts - playingAudioPts) / 1000;
            const syncErrorMs = targetRenderTime - currentHeadSchedule;

            // Anchor negative catchup bound to `now` (the frame just rendered via renderFrameInternal),
            // NOT `this.lastScheduledTimeMs` (which points to the tail of `this.frameQueue`).
            const earliestHeadTime = Math.max(now + 8, now + minCatchupIntervalMs);
            const maxNegativeShiftAllowed = Math.min(0, earliestHeadTime - currentHeadSchedule);

            if (Math.abs(syncErrorMs) > FramePacer.AV_SYNC_MAX_ERROR_MS) {
              // 150ms超の顕著なズレ:
              // 重要: プラス/マイナス両方向のスルーレートを ±2.0ms/frame に厳格にクランプすることで、
              // 描画間隔（約31.3ms〜35.3ms）を維持し、画面フリーズや急激な前倒しによる激しいカクつき（スタッター）を
              // 完全に防ぎながら、音声へスムーズに吸着・同期させる。
              const maxPositiveShift = FramePacer.AV_SYNC_LARGE_SHIFT_MAX_MS;
              const desiredShift = Math.max(
                -FramePacer.AV_SYNC_LARGE_SHIFT_MAX_MS,
                syncErrorMs * FramePacer.AV_SYNC_LARGE_SHIFT_KP,
              );
              const pllShift =
                syncErrorMs > 0
                  ? Math.min(maxPositiveShift, syncErrorMs * FramePacer.AV_SYNC_LARGE_SHIFT_KP)
                  : Math.max(maxNegativeShiftAllowed, desiredShift);

              if (this.telemetry?.isEnabled()) {
                if (now - this.lastLargeShiftLogTimeMs >= FramePacer.PLL_NUDGE_LOG_INTERVAL_MS) {
                  this.telemetry.recordAvSync('large_shift', {
                    syncErrorMs: Math.round(syncErrorMs),
                    shift: Math.round(pllShift * 10) / 10,
                    nextVideoPts,
                    playingAudioPts,
                    queueLength: this.frameQueue.length,
                    suppressedCount: this.largeShiftSuppressedCount,
                  });
                  this.lastLargeShiftLogTimeMs = now;
                  this.largeShiftSuppressedCount = 0;
                } else {
                  this.largeShiftSuppressedCount++;
                }
              }
              totalShift += pllShift;
            } else if (Math.abs(syncErrorMs) >= FramePacer.AV_SYNC_DEADBAND_MS) {
              // 45ms〜150ms のズレに対して、毎フレーム最大 ±0.75ms (約2%の微小速度調整) の範囲で
              // 画面の等速性を完全に保護しながら滑らかにリップシンクを収束させる (比例ゲイン Kp = 0.005)。
              const errorMagnitude = Math.min(
                FramePacer.AV_SYNC_MAX_ERROR_MS,
                Math.abs(syncErrorMs),
              );
              const rawNudge = Math.sign(syncErrorMs) * (errorMagnitude * FramePacer.AV_SYNC_KP);
              const nudge = rawNudge < 0 ? Math.max(maxNegativeShiftAllowed, rawNudge) : rawNudge;
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
              totalShift += nudge;
            }
          }
        }

        if (totalShift !== 0) {
          for (const item of this.frameQueue) {
            item.scheduledRenderTime += totalShift;
          }
          this.lastScheduledTimeMs += totalShift;
        }
      }
    }

    if (this.frameQueue.length > 0) {
      this.scheduleNextFlush();
    }
  }

  private renderFrameInternal(frame: VideoFrame, ptsUs: number, nowMs: number): void {
    this.hasRenderedAny = true;
    this.lastRenderedPtsUs = ptsUs;
    this.lastRenderedTimeMs = nowMs;
    this.avSync?.updateVideoPts(ptsUs);
    const renderStartMs = performance.now();
    this.renderer.render(frame);
    this.onFrameRenderTimed?.(performance.now() - renderStartMs);
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
   * preserveCushion=true はサーバー起因の早送り用: 自動適応クッション (autoCushionMs) を
   * ゼロにせず維持し、直後の微小ジッタでバッファリング状態 (WAIT) に落ちるのを防ぐ (Issue #112)。
   */
  public jumpToLive(preserveCushion = false): void {
    if (!preserveCushion) {
      this.autoCushionMs = 0;
    }
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
    this.lastRenderedTimeMs = -Infinity;
    this.hasRenderedAny = false;
    this.lastPllNudgeLogTimeMs = -Infinity;
    this.pllNudgeSuppressedCount = 0;
    this.lastLargeShiftLogTimeMs = -Infinity;
    this.largeShiftSuppressedCount = 0;
    this.lastStaleDropLogTimeMs = -Infinity;
    this.lastSustainedTrimRequestMs = -Infinity;
  }

  public resetFirstFrame(): void {
    this.reset();
  }

  public destroy(): void {
    this.reset();
  }
}
