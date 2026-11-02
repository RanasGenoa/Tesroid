import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsManager } from '../src/metrics/manager.js';

describe('MetricsManager Tests', () => {
  let manager: MetricsManager;

  beforeEach(() => {
    manager = new MetricsManager(10); // Small limit for testing
    manager.clear();
  });

  it('should return empty summary when no metrics recorded', () => {
    const summary = manager.getSummary();
    expect(summary.sampleCount).toBe(0);
    expect(summary.averageFps).toBe(0);
  });

  it('should calculate accurate statistical summaries', () => {
    manager.addMetrics({
      renderFps: 30,
      minFps: 28,
      maxFps: 30,
      rttMs: 20,
      droppedFrames: 0,
      decoderErrors: 0,
      bitrateKbps: 3000,
      avDriftMs: 5,
    });

    manager.addMetrics({
      renderFps: 29.5,
      minFps: 27,
      maxFps: 30,
      rttMs: 30,
      droppedFrames: 1,
      decoderErrors: 0,
      bitrateKbps: 3200,
      avDriftMs: -10,
    });

    const summary = manager.getSummary();
    expect(summary.sampleCount).toBe(2);
    expect(summary.currentFps).toBe(29.5);
    expect(summary.averageFps).toBe(29.8);
    expect(summary.minFps).toBe(27);
    expect(summary.maxFps).toBe(30);
    expect(summary.averageRttMs).toBe(25);
    expect(summary.totalDroppedFrames).toBe(1);
    expect(summary.averageBitrateKbps).toBe(3100);
  });

  it('should enforce ring buffer maximum limit', () => {
    for (let i = 1; i <= 15; i++) {
      manager.addMetrics({ renderFps: i });
    }

    const history = manager.getHistory(20);
    expect(history.length).toBe(10);
    expect(history[0].renderFps).toBe(6); // Oldest remaining
    expect(history[9].renderFps).toBe(15); // Newest
  });
});
