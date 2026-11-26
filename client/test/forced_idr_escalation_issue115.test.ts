import { describe, expect, it } from 'vitest';
import { ForcedIdrEscalation } from '../src/core/forced-idr-escalation';

/**
 * Issue #115: エスカレーション状態遷移 (局所 trim no-op 持続 -> FORCE_VIDEO_IDR 要求) の回帰ガード。
 * - 実破棄 (>0) で完全リセット
 * - no-op が 2.5s ウィンドウを跨げば非連続 (数分空いた単発スパイクの合算で発火しない)
 * - ウィンドウ内 2 回連続でのみ要求可、送信後 5s クールダウン
 * - 未接続時は保留 (streak 維持)、接続復帰後の検知で即発火
 */
describe('ForcedIdrEscalation state machine (Issue #115)', () => {
  const T0 = 100_000;

  it('single no-op spike does not escalate; a second within the window does', () => {
    const sm = new ForcedIdrEscalation();
    expect(sm.shouldRequest(0, T0, true)).toBe(false); // 1回目 no-op
    expect(sm.shouldRequest(0, T0 + 1_000, true)).toBe(true); // 2回目 (1s後) -> 発火
    // 実検知は 1回/秒。発火直後の 5s クールダウン内は保留され、経過で再発火する
    for (const dt of [2_000, 3_000, 4_000, 5_000]) {
      expect(sm.shouldRequest(0, T0 + dt, true)).toBe(false);
    }
    expect(sm.shouldRequest(0, T0 + 6_000, true)).toBe(true); // クールダウン明け -> 発火
  });

  it('an actual trim (>0) fully resets the no-op streak', () => {
    const sm = new ForcedIdrEscalation();
    expect(sm.shouldRequest(0, T0, true)).toBe(false); // 1回目 no-op
    expect(sm.shouldRequest(5, T0 + 1_000, true)).toBe(false); // 実破棄 -> リセット
    expect(sm.shouldRequest(0, T0 + 2_000, true)).toBe(false); // no-op 1回目にやり直し
    expect(sm.shouldRequest(0, T0 + 3_000, true)).toBe(true); // ウィンドウ内 2回目 -> 発火
  });

  it('no-ops separated beyond the 2.5s window are not counted as consecutive', () => {
    const sm = new ForcedIdrEscalation();
    expect(sm.shouldRequest(0, T0, true)).toBe(false); // 単発スパイク #1
    // 数分後の単発スパイク -> ウィンドウ超過でリセットされ発火しない
    expect(sm.shouldRequest(0, T0 + 180_000, true)).toBe(false);
    // その 1s 後の no-op で初めて連続が確定 -> 発火
    expect(sm.shouldRequest(0, T0 + 181_000, true)).toBe(true);
  });

  it('disconnection defers the request but preserves the streak until reconnection', () => {
    const sm = new ForcedIdrEscalation();
    expect(sm.shouldRequest(0, T0, true)).toBe(false);
    // 連続条件是満たすが未接続 -> 保留 (streak は維持)
    expect(sm.shouldRequest(0, T0 + 1_000, false)).toBe(false);
    // 接続復帰後の次の検知 (ウィンドウ内) で即発火
    expect(sm.shouldRequest(0, T0 + 2_000, true)).toBe(true);
  });
});
