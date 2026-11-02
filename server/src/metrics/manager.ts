export interface ClientQualityMetrics {
  timestamp: number;
  // FPS & Rendering
  renderFps: number;
  minFps: number;
  maxFps: number;
  totalFramesRendered: number;
  droppedFrames: number;

  // Decoder
  decodeQueueSize: number;
  decoderErrors: number;

  // Network & Transport
  rttMs: number;
  videoPacketsReceived: number;
  videoBytesReceived: number;
  audioPacketsReceived: number;
  bitrateKbps: number;

  // AV Sync
  avDriftMs: number;

  // Viewport
  displayWidth?: number;
  displayHeight?: number;
  devicePixelRatio?: number;
}

export interface MetricsSummary {
  sampleCount: number;
  durationSeconds: number;
  currentFps: number;
  averageFps: number;
  minFps: number;
  maxFps: number;
  averageRttMs: number;
  maxRttMs: number;
  totalDroppedFrames: number;
  totalDecoderErrors: number;
  averageBitrateKbps: number;
  averageAvDriftMs: number;
  lastUpdated: number | null;
}

export class MetricsManager {
  private static instance: MetricsManager | null = null;
  private history: ClientQualityMetrics[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 360) { // 360 entries * 10s = 1 hour of history
    this.maxEntries = maxEntries;
  }

  public static getInstance(): MetricsManager {
    if (!MetricsManager.instance) {
      MetricsManager.instance = new MetricsManager();
    }
    return MetricsManager.instance;
  }

  public addMetrics(metrics: Partial<ClientQualityMetrics>): void {
    const entry: ClientQualityMetrics = {
      timestamp: metrics.timestamp || Date.now(),
      renderFps: Math.round((metrics.renderFps || 0) * 10) / 10,
      minFps: Math.round((metrics.minFps || 0) * 10) / 10,
      maxFps: Math.round((metrics.maxFps || 0) * 10) / 10,
      totalFramesRendered: metrics.totalFramesRendered || 0,
      droppedFrames: metrics.droppedFrames || 0,
      decodeQueueSize: metrics.decodeQueueSize || 0,
      decoderErrors: metrics.decoderErrors || 0,
      rttMs: Math.round(metrics.rttMs || 0),
      videoPacketsReceived: metrics.videoPacketsReceived || 0,
      videoBytesReceived: metrics.videoBytesReceived || 0,
      audioPacketsReceived: metrics.audioPacketsReceived || 0,
      bitrateKbps: Math.round(metrics.bitrateKbps || 0),
      avDriftMs: Math.round((metrics.avDriftMs || 0) * 10) / 10,
      displayWidth: metrics.displayWidth,
      displayHeight: metrics.displayHeight,
      devicePixelRatio: metrics.devicePixelRatio,
    };

    this.history.push(entry);
    if (this.history.length > this.maxEntries) {
      this.history.shift();
    }

    console.log(
      `[ClientMetrics] FPS: ${entry.renderFps} (min: ${entry.minFps}, max: ${entry.maxFps}) | ` +
      `RTT: ${entry.rttMs}ms | Bitrate: ${entry.bitrateKbps}kbps | ` +
      `Drops: ${entry.droppedFrames} | DecErrors: ${entry.decoderErrors} | ` +
      `AV-Drift: ${entry.avDriftMs}ms`
    );
  }

  public getHistory(limit = 60): ClientQualityMetrics[] {
    const count = Math.min(Math.max(1, limit), this.history.length);
    return this.history.slice(-count);
  }

  public getSummary(): MetricsSummary {
    if (this.history.length === 0) {
      return {
        sampleCount: 0,
        durationSeconds: 0,
        currentFps: 0,
        averageFps: 0,
        minFps: 0,
        maxFps: 0,
        averageRttMs: 0,
        maxRttMs: 0,
        totalDroppedFrames: 0,
        totalDecoderErrors: 0,
        averageBitrateKbps: 0,
        averageAvDriftMs: 0,
        lastUpdated: null,
      };
    }

    const latest = this.history[this.history.length - 1];
    let sumFps = 0;
    let minFps = Infinity;
    let maxFps = -Infinity;
    let sumRtt = 0;
    let maxRtt = 0;
    let sumBitrate = 0;
    let sumDrift = 0;
    let totalDropped = 0;
    let totalErrors = 0;

    for (const item of this.history) {
      sumFps += item.renderFps;
      if (item.minFps < minFps) minFps = item.minFps;
      if (item.maxFps > maxFps) maxFps = item.maxFps;
      sumRtt += item.rttMs;
      if (item.rttMs > maxRtt) maxRtt = item.rttMs;
      sumBitrate += item.bitrateKbps;
      sumDrift += Math.abs(item.avDriftMs);
      totalDropped += item.droppedFrames;
      totalErrors += item.decoderErrors;
    }

    const count = this.history.length;
    const durationSeconds = count * 10;

    return {
      sampleCount: count,
      durationSeconds,
      currentFps: latest.renderFps,
      averageFps: Math.round((sumFps / count) * 10) / 10,
      minFps: minFps === Infinity ? 0 : minFps,
      maxFps: maxFps === -Infinity ? 0 : maxFps,
      averageRttMs: Math.round(sumRtt / count),
      maxRttMs: maxRtt,
      totalDroppedFrames: totalDropped,
      totalDecoderErrors: totalErrors,
      averageBitrateKbps: Math.round(sumBitrate / count),
      averageAvDriftMs: Math.round((sumDrift / count) * 10) / 10,
      lastUpdated: latest.timestamp,
    };
  }

  public clear(): void {
    this.history = [];
  }
}
