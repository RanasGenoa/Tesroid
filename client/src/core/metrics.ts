export interface ClientQualityMetrics {
  timestamp: number;
  renderFps: number;
  minFps: number;
  maxFps: number;
  totalFramesRendered: number;
  droppedFrames: number;

  decodeQueueSize: number;
  decoderErrors: number;

  rttMs: number;
  videoPacketsReceived: number;
  videoBytesReceived: number;
  audioPacketsReceived: number;
  bitrateKbps: number;

  avDriftMs: number;

  // Issue #11 (D5): 1フレーム描画処理時間の中央値/95パーセンタイル (ms)。0 = 計測サンプルなし
  frameProcessP50Ms?: number;
  frameProcessP95Ms?: number;

  displayWidth: number;
  displayHeight: number;
  devicePixelRatio: number;
}

export class MetricsCollector {
  private totalFramesRendered = 0;
  private droppedFrames = 0;
  private decoderErrors = 0;

  // Windowed counters (reset every 10 seconds)
  private windowFrames = 0;
  private windowVideoPackets = 0;
  private windowVideoBytes = 0;
  private windowAudioPackets = 0;
  private windowMinFps = 999;
  private windowMaxFps = 0;
  // Issue #11 (D5): ウィンドウ内の 1 フレーム描画所要時間サンプル (ms)
  private windowFrameRenderTimes: number[] = [];
  private static readonly MAX_FRAME_TIME_SAMPLES = 1200;
  private lastReportTime: number;

  // Current states
  private currentRtt = 0;
  private currentDecodeQueueSize = 0;
  private currentAvDriftMs = 0;
  private latestMetrics: ClientQualityMetrics | null = null;

  private reportTimer: number | null = null;
  public onReport?: (metrics: ClientQualityMetrics) => void;

  constructor() {
    this.lastReportTime = performance.now();
    this.startPeriodicReport();
  }

  public recordFrameRendered(instantFps?: number): void {
    this.totalFramesRendered++;
    this.windowFrames++;

    if (instantFps !== undefined && instantFps > 0) {
      if (instantFps < this.windowMinFps) this.windowMinFps = instantFps;
      if (instantFps > this.windowMaxFps) this.windowMaxFps = instantFps;
    }
  }

  public recordFrameDropped(): void {
    this.droppedFrames++;
  }

  /** Issue #11 (D5): 1フレームの canvas 描画所要時間をサンプル収集する。 */
  public recordFrameProcessed(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    if (this.windowFrameRenderTimes.length < MetricsCollector.MAX_FRAME_TIME_SAMPLES) {
      this.windowFrameRenderTimes.push(durationMs);
    }
  }

  private static percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return Math.round(sorted[idx] * 10) / 10;
  }

  public recordDecoderError(): void {
    this.decoderErrors++;
  }

  public recordVideoPacket(byteLength: number): void {
    this.windowVideoPackets++;
    this.windowVideoBytes += byteLength;
  }

  public recordAudioPacket(): void {
    this.windowAudioPackets++;
  }

  public updateRtt(rttMs: number): void {
    this.currentRtt = rttMs;
  }

  public updateDecodeQueueSize(size: number): void {
    this.currentDecodeQueueSize = size;
  }

  public updateAvDrift(driftMs: number): void {
    this.currentAvDriftMs = driftMs;
  }

  public getLatestMetrics(): ClientQualityMetrics | null {
    return this.latestMetrics;
  }

  private startPeriodicReport(): void {
    // 10-second batch interval for minimal CPU impact
    this.reportTimer = window.setInterval(() => {
      const now = performance.now();
      const elapsedSec = (now - this.lastReportTime) / 1000;
      if (elapsedSec <= 0) return;

      const renderFps = Math.round((this.windowFrames / elapsedSec) * 10) / 10;
      const bitrateKbps = Math.round((this.windowVideoBytes * 8) / elapsedSec / 1000);
      // Issue #11 (D5): 描画処理時間のパーセンタイル (サンプル 0 の場合は 0)
      const sortedFrameTimes = [...this.windowFrameRenderTimes].sort((a, b) => a - b);

      const metrics: ClientQualityMetrics = {
        timestamp: Date.now(),
        renderFps,
        minFps: this.windowMinFps === 999 ? renderFps : this.windowMinFps,
        maxFps: this.windowMaxFps === 0 ? renderFps : this.windowMaxFps,
        totalFramesRendered: this.totalFramesRendered,
        droppedFrames: this.droppedFrames,
        decodeQueueSize: this.currentDecodeQueueSize,
        decoderErrors: this.decoderErrors,
        rttMs: this.currentRtt,
        videoPacketsReceived: this.windowVideoPackets,
        videoBytesReceived: this.windowVideoBytes,
        audioPacketsReceived: this.windowAudioPackets,
        bitrateKbps,
        avDriftMs: Math.round(this.currentAvDriftMs * 10) / 10,
        frameProcessP50Ms: MetricsCollector.percentile(sortedFrameTimes, 0.5),
        frameProcessP95Ms: MetricsCollector.percentile(sortedFrameTimes, 0.95),
        displayWidth: window.innerWidth,
        displayHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      };

      this.latestMetrics = metrics;

      // Reset windowed counters
      this.windowFrames = 0;
      this.windowVideoPackets = 0;
      this.windowVideoBytes = 0;
      this.windowAudioPackets = 0;
      this.windowMinFps = 999;
      this.windowMaxFps = 0;
      this.windowFrameRenderTimes = [];
      this.lastReportTime = now;

      if (this.onReport) {
        try {
          this.onReport(metrics);
        } catch (e) {
          console.warn('[MetricsCollector] Error emitting report:', e);
        }
      }
    }, 10000);
  }

  public destroy(): void {
    if (this.reportTimer !== null) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
  }
}
