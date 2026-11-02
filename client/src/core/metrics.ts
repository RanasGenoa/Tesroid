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
