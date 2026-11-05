export interface AdaptiveJitterOptions {
  historySize?: number;
  jitterThresholdMs?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  quietRecoveryTimeSec?: number;
  maxRampUpPerFrameMs?: number;
  onDelayChanged?: (delayMs: number) => void;
}

export class AdaptiveJitterController {
  private historySize: number;
  private jitterThresholdMs: number;
  private minDelayMs: number;
  private maxDelayMs: number;
  private quietRecoveryTimeSec: number;
  private maxRampUpPerFrameMs: number;
  private onDelayChanged?: (delayMs: number) => void;

  private arrivalIntervals: number[] = [];
  private lastAuArrival: number = 0;
  private rttHistory: number[] = [];

  private currentDelayMs: number = 0;
  private targetDelayMs: number = 0;
  private lastRampTime: number = 0;
  private lastNotifiedDelay: number = 0;
  private isCatchup: boolean = false;
  private sortScratch: number[] = [];

  constructor(options: AdaptiveJitterOptions = {}) {
    this.historySize = options.historySize ?? 20;
    this.jitterThresholdMs = options.jitterThresholdMs ?? 90;
    this.minDelayMs = options.minDelayMs ?? 60;
    this.maxDelayMs = options.maxDelayMs ?? 240;
    this.quietRecoveryTimeSec = options.quietRecoveryTimeSec ?? 12; // 12秒以内で素早く0msへ復帰
    this.maxRampUpPerFrameMs = options.maxRampUpPerFrameMs ?? 20;
    this.onDelayChanged = options.onDelayChanged;
    this.lastRampTime = performance.now();
  }

  /**
   * AU（映像フレーム）到着を記録し、直近到着間隔からジッタを更新
   * ※ 静止画明け等の正常な間隔（例: > 350ms）は回線ジッタではないためフィルタリング
   */
  public recordVideoArrival(timestamp?: number): void {
    if (this.isCatchup) return;

    const now = timestamp ?? performance.now();
    if (this.lastAuArrival > 0) {
      const interval = now - this.lastAuArrival;
      if (interval >= 0 && interval <= 850) {
        this.arrivalIntervals.push(interval);
        if (this.arrivalIntervals.length > this.historySize) {
          this.arrivalIntervals.shift();
        }
      }
    }
    this.lastAuArrival = now;

    this.evaluateJitter();
    this.stepRamp(now);
  }

  /**
   * WS RTT の更新を記録
   */
  public updateRtt(rttMs: number, timestamp?: number): void {
    if (this.isCatchup) return;

    if (rttMs > 0 && rttMs < 10000) {
      this.rttHistory.push(rttMs);
      if (this.rttHistory.length > this.historySize) {
        this.rttHistory.shift();
      }
    }

    const now = timestamp ?? performance.now();
    this.evaluateJitter();
    this.stepRamp(now);
  }

  /**
   * 配列アロケーションなしで中央値と95パーセンタイルの差分（ジッタ）を算出
   */
  private computeJitter(arr: number[], minLen: number): number {
    const len = arr.length;
    if (len < minLen) return 0;
    this.sortScratch.length = len;
    for (let i = 0; i < len; i++) {
      this.sortScratch[i] = arr[i];
    }
    this.sortScratch.sort((a, b) => a - b);
    const median = this.sortScratch[Math.floor(len * 0.5)];
    const p95 = this.sortScratch[Math.min(len - 1, Math.floor(len * 0.95))];
    return Math.max(0, p95 - median);
  }

  /**
   * 直近のAU到着間隔とRTTからジッタを推定し、目標追加遅延を計算
   */
  private evaluateJitter(): void {
    if (this.isCatchup) {
      this.targetDelayMs = 0;
      return;
    }

    const arrivalJitter = this.computeJitter(this.arrivalIntervals, 5);
    const rttJitter = this.computeJitter(this.rttHistory, 3);
    const estimatedJitter = Math.max(arrivalJitter, rttJitter);

    if (estimatedJitter >= this.jitterThresholdMs) {
      // 閾値超過時: 80〜400ms で段階的に適用
      const clamped = Math.min(
        this.maxDelayMs,
        Math.max(this.minDelayMs, Math.round(estimatedJitter)),
      );
      this.targetDelayMs = clamped;
    } else {
      // 静穏化時: 元の低遅延（0ms）へ戻す
      this.targetDelayMs = 0;
    }
  }

  /**
   * 急峻な段差を避け、緩やかなランプ（ランプアップ: 1フレームずつ、ランプダウン: 30秒以内）で遅延を調整
   */
  public stepRamp(now?: number): void {
    const currentTime = now ?? performance.now();
    if (this.lastRampTime <= 0) {
      this.lastRampTime = currentTime;
      return;
    }

    const elapsedMs = Math.max(0, currentTime - this.lastRampTime);
    this.lastRampTime = currentTime;

    if (this.isCatchup) {
      this.currentDelayMs = 0;
      this.targetDelayMs = 0;
      this.notifyIfChanged();
      return;
    }

    if (this.currentDelayMs < this.targetDelayMs) {
      // ランプアップ（1フレーム約33msあたり最大 maxRampUpPerFrameMs）
      const frameEquivalent = Math.max(1, elapsedMs / 33.3);
      const maxIncrease = this.maxRampUpPerFrameMs * frameEquivalent;
      this.currentDelayMs = Math.min(this.targetDelayMs, this.currentDelayMs + maxIncrease);
    } else if (this.currentDelayMs > this.targetDelayMs) {
      // ランプダウン（静穏時: 30秒以内で 400ms -> 0ms へ復帰）
      const drainRateMsPerSec = this.maxDelayMs / this.quietRecoveryTimeSec; // 例: 400 / 25 = 16ms/sec
      const maxDecrease = (drainRateMsPerSec * elapsedMs) / 1000;
      this.currentDelayMs = Math.max(this.targetDelayMs, this.currentDelayMs - maxDecrease);
    }

    this.notifyIfChanged();
  }

  private notifyIfChanged(): void {
    const rounded = Math.round(this.currentDelayMs);
    if (rounded !== this.lastNotifiedDelay) {
      this.lastNotifiedDelay = rounded;
      this.onDelayChanged?.(rounded);
    }
  }

  /**
   * 現在の適用追加遅延 (ms)
   */
  public getCurrentDelayMs(): number {
    this.stepRamp();
    return Math.round(this.currentDelayMs);
  }

  /**
   * 目標追加遅延 (ms)
   */
  public getTargetDelayMs(): number {
    return this.targetDelayMs;
  }

  /**
   * CATCHUP モードの設定（CATCHUP 中は等速送出のため追加遅延は不要・0msに固定）
   */
  public setCatchup(isCatchup: boolean): void {
    this.isCatchup = isCatchup;
    if (isCatchup) {
      this.reset();
    }
  }

  public getIsCatchup(): boolean {
    return this.isCatchup;
  }

  /**
   * 再接続時やストリーム切断時の深さリセット
   */
  public reset(): void {
    this.arrivalIntervals = [];
    this.rttHistory = [];
    this.lastAuArrival = 0;
    this.currentDelayMs = 0;
    this.targetDelayMs = 0;
    this.lastRampTime = performance.now();
    this.notifyIfChanged();
  }

  public destroy(): void {
    this.reset();
    this.onDelayChanged = undefined;
  }
}
