export type LatencyMode = 'ACTIVE_INTERACTION' | 'PASSIVE_STREAMING';

export class DynamicLatencyController {
  private mode: LatencyMode = 'PASSIVE_STREAMING';
  private activeTimer: number | null = null;
  private onModeChange?: (mode: LatencyMode) => void;
  private holdDurationMs: number;

  constructor(onModeChange?: (mode: LatencyMode) => void, holdDurationMs: number = 4000) {
    this.onModeChange = onModeChange;
    this.holdDurationMs = holdDurationMs;
  }

  public notifyInteraction(): void {
    if (this.activeTimer) {
      clearTimeout(this.activeTimer);
    }

    if (this.mode !== 'ACTIVE_INTERACTION') {
      this.mode = 'ACTIVE_INTERACTION';
      console.log('[DynamicLatency] Switched to ACTIVE_INTERACTION (Zero buffer, ultra-low latency).');
      if (this.onModeChange) this.onModeChange(this.mode);
    }

    // Switch back to PASSIVE_STREAMING after interaction settles (default 4 seconds)
    const setTimer = typeof window !== 'undefined' && typeof window.setTimeout === 'function' ? window.setTimeout : setTimeout;
    this.activeTimer = setTimer(() => {
      this.mode = 'PASSIVE_STREAMING';
      console.log('[DynamicLatency] Switched to PASSIVE_STREAMING (Smooth playback, jitter buffer).');
      if (this.onModeChange) this.onModeChange(this.mode);
    }, this.holdDurationMs) as unknown as number;
  }

  public getMode(): LatencyMode {
    return this.mode;
  }
}
