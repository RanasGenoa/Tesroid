import { describe, it, expect, vi } from 'vitest';
import { AdaptiveJitterController } from '../src/core/adaptive-jitter.js';
import { AvSyncController } from '../src/core/av-sync.js';

describe('Adaptive Jitter Buffer Tests for Car LTE Spikes', () => {
  // 要件: クラスを new されるモックは正規関数コンストラクタで（arrow 禁止）
  const MockFramePacerConstructor: any = function (this: any) {
    this.delays = [] as number[];
    this.currentDelay = 0;
    this.setAdditionalDelay = vi.fn((delayMs: number) => {
      this.currentDelay = delayMs;
      this.delays.push(delayMs);
    });
  };

  const MockAudioPlayerConstructor: any = function (this: any) {
    this.delays = [] as number[];
    this.currentDelay = 0;
    this.setAdditionalDelay = vi.fn((delayMs: number) => {
      this.currentDelay = delayMs;
      this.delays.push(delayMs);
    });
  };

  it('(a) should ramp up additional delay on arrival spikes and recover within 30s during quiet periods', () => {
    let notifiedDelay = 0;
    const controller = new AdaptiveJitterController({
      historySize: 20,
      jitterThresholdMs: 50,
      minDelayMs: 80,
      maxDelayMs: 400,
      quietRecoveryTimeSec: 25, // 25s <= 30s
      onDelayChanged: (delayMs) => {
        notifiedDelay = delayMs;
      },
    });

    let fakeNow = 1000;

    // 1. 静穏列 (30fps = ~33.3ms間隔) を20フレーム流す
    for (let i = 0; i < 20; i++) {
      fakeNow += 33.3;
      controller.recordVideoArrival(fakeNow);
    }

    // 静穏時はジッタがほぼ0のため、追加遅延は0ms
    expect(controller.getCurrentDelayMs()).toBe(0);
    expect(notifiedDelay).toBe(0);

    // 2. LTEスパイク列を流す (350ms, 450ms, 772ms 等の遅延到着)
    const spikeIntervals = [350, 450, 772, 33, 33, 400];
    for (const interval of spikeIntervals) {
      fakeNow += interval;
      controller.recordVideoArrival(fakeNow);
    }

    // ジッタ推定 (p95 - median) が閾値 50ms を超え、目標遅延が上昇している
    expect(controller.getTargetDelayMs()).toBeGreaterThanOrEqual(80);
    expect(controller.getTargetDelayMs()).toBeLessThanOrEqual(400);

    // ランプアップが進む (1フレームずつ緩やかに上昇)
    for (let i = 0; i < 15; i++) {
      fakeNow += 33.3;
      controller.recordVideoArrival(fakeNow);
    }

    const peakDelay = controller.getCurrentDelayMs();
    expect(peakDelay).toBeGreaterThanOrEqual(80);
    expect(peakDelay).toBeLessThanOrEqual(400);

    // 3. 回線静穏化 (安定した 33.3ms 間隔のパケット列)
    // 20サンプルを静穏パケットで上書きして targetDelayMs を 0 に戻す
    for (let i = 0; i < 20; i++) {
      fakeNow += 33.3;
      controller.recordVideoArrival(fakeNow);
    }
    expect(controller.getTargetDelayMs()).toBe(0);

    // 4. 25秒間 (30秒以内) 静穏パケットを流し続ける
    const quietFrames = Math.ceil((25 * 1000) / 33.3);
    for (let i = 0; i < quietFrames; i++) {
      fakeNow += 33.3;
      controller.recordVideoArrival(fakeNow);
    }

    // 30秒以内に元の低遅延 (0ms) に完全復帰していることを検証
    expect(controller.getCurrentDelayMs()).toBe(0);
  });

  it('(b) should allocate identical additional delay budget to both audio and video without degrading AV-Drift', () => {
    const mockPacer = new MockFramePacerConstructor();
    const mockPlayer = new MockAudioPlayerConstructor();
    const avSync = new AvSyncController();

    const controller = new AdaptiveJitterController({
      onDelayChanged: (delayMs) => {
        mockPacer.setAdditionalDelay(delayMs);
        mockPlayer.setAdditionalDelay(delayMs);
      },
    });

    let fakeNow = 5000;
    // 静穏
    for (let i = 0; i < 10; i++) {
      fakeNow += 33.3;
      controller.recordVideoArrival(fakeNow);
    }

    // スパイク注入 (RTT スパイク & 到着間隔スパイク)
    controller.updateRtt(350, fakeNow);
    fakeNow += 300;
    controller.recordVideoArrival(fakeNow);
    fakeNow += 400;
    controller.recordVideoArrival(fakeNow);

    for (let i = 0; i < 10; i++) {
      fakeNow += 33.3;
      controller.recordVideoArrival(fakeNow);
    }

    // (b-1) 音声と映像へ同じ追加遅延が配られていることを検証
    expect(mockPacer.delays.length).toBeGreaterThan(0);
    expect(mockPlayer.delays.length).toBeGreaterThan(0);
    expect(mockPacer.delays).toEqual(mockPlayer.delays);
    expect(mockPacer.currentDelay).toBe(mockPlayer.currentDelay);
    expect(mockPacer.currentDelay).toBeGreaterThanOrEqual(80);

    // (b-2) AV-Drift 非悪化のモック検証
    // 映像と音声に同一の追加遅延 D が配られるため、PTS進行比率とDriftが±30ms以内に維持される
    const basePtsUs = 1000000;
    avSync.updateVideoPts(basePtsUs);
    avSync.updateAudioPts(basePtsUs, fakeNow);

    // 500ms 経過時
    const elapsedUs = 500000;
    const additionalDelayUs = mockPacer.currentDelay * 1000;
    // 映像と音声の両方に同一の追加遅延が適用される
    avSync.updateVideoPts(basePtsUs + elapsedUs + additionalDelayUs);
    avSync.updateAudioPts(basePtsUs + elapsedUs + additionalDelayUs, fakeNow + 500);

    const driftMs = avSync.getDriftMs();
    expect(Math.abs(driftMs)).toBeLessThanOrEqual(30);
  });

  it('(c) should reset buffer depth on CATCHUP transition and reconnection', () => {
    let currentDelay = 0;
    const controller = new AdaptiveJitterController({
      onDelayChanged: (delayMs) => {
        currentDelay = delayMs;
      },
    });

    let fakeNow = 10000;
    // スパイクを発生させて追加遅延を上昇させる
    fakeNow += 33.3;
    controller.recordVideoArrival(fakeNow);
    fakeNow += 400; // 400ms スパイク
    controller.recordVideoArrival(fakeNow);
    for (let i = 0; i < 10; i++) {
      fakeNow += 33.3;
      controller.recordVideoArrival(fakeNow);
    }

    expect(controller.getCurrentDelayMs()).toBeGreaterThan(0);
    expect(currentDelay).toBeGreaterThan(0);

    // (c-1) 再接続時の reset() で即時 0ms にリセットされる
    controller.reset();
    expect(controller.getCurrentDelayMs()).toBe(0);
    expect(controller.getTargetDelayMs()).toBe(0);
    expect(currentDelay).toBe(0);

    // 再度スパイクを発生させる
    fakeNow += 33.3;
    controller.recordVideoArrival(fakeNow);
    fakeNow += 450; // 450ms スパイク
    controller.recordVideoArrival(fakeNow);
    for (let i = 0; i < 10; i++) {
      fakeNow += 33.3;
      controller.recordVideoArrival(fakeNow);
    }
    expect(controller.getCurrentDelayMs()).toBeGreaterThan(0);

    // (c-2) CATCHUP 遷移で深さがリセットされ、CATCHUP 中はスパイクが来ても追加遅延が 0ms に固定される
    controller.setCatchup(true);
    expect(controller.getIsCatchup()).toBe(true);
    expect(controller.getCurrentDelayMs()).toBe(0);
    expect(currentDelay).toBe(0);

    // CATCHUP 中にパケットが届いても追加遅延は 0ms のまま (CATCHUP と干渉しない)
    fakeNow += 500;
    controller.recordVideoArrival(fakeNow);
    controller.updateRtt(700, fakeNow);
    expect(controller.getCurrentDelayMs()).toBe(0);

    // CATCHUP 終了で LIVE に復帰
    controller.setCatchup(false);
    expect(controller.getIsCatchup()).toBe(false);
  });
});
