/**
 * Issue #115: 局所 GOP 境界トリムの no-op 持続から、サーバー映像限定ライブエッジ再起動
 * (FORCE_VIDEO_IDR) へエスカレートする判定のみの状態機械。
 *
 * GOP 格子ロックは「trim が切れない状態が約 1 秒以上続く」でのみ確定させる:
 * - 実破棄 (>0) は局所機構が機能中の証拠 → カウント完全リセット
 * - no-op が NOOP_WINDOW_MS (2.5s) を跨いだら非連続とみなす (単発スパイクの合算を防止。
 *   ペーサーの検知は 1 回/秒上限なので、ウィンドウ内の連続 2 回 = 最低約 1 秒持続と同等)
 * - ESCALATE_NOOP_STREAK 回連続で要求可。送信後は COOLDOWN_MS (5s) のレート制限
 *   (サーバー側にも同様の 5s クールダウンを別層で持つ)。
 */
export class ForcedIdrEscalation {
  public static readonly ESCALATE_NOOP_STREAK = 2;
  public static readonly NOOP_WINDOW_MS = 2_500;
  public static readonly COOLDOWN_MS = 5_000;

  private noopStreak = 0;
  private lastNoOpAtMs = -Infinity;
  private lastRequestAtMs = -Infinity;

  /**
   * 音声先行検知のたびに呼び、この時点で FORCE_VIDEO_IDR を送信すべきなら true。
   * @param droppedCount trimPendingBeforePts の実破棄数
   * @param nowMs performance.now() 基準の現在時刻
   * @param connected WebSocket 接続状態
   */
  public shouldRequest(droppedCount: number, nowMs: number, connected: boolean): boolean {
    if (droppedCount > 0) {
      this.noopStreak = 0;
      this.lastNoOpAtMs = -Infinity;
      return false;
    }
    if (nowMs - this.lastNoOpAtMs > ForcedIdrEscalation.NOOP_WINDOW_MS) {
      this.noopStreak = 0;
    }
    this.lastNoOpAtMs = nowMs;
    this.noopStreak += 1;
    if (this.noopStreak < ForcedIdrEscalation.ESCALATE_NOOP_STREAK) {
      return false;
    }
    if (!connected || nowMs - this.lastRequestAtMs < ForcedIdrEscalation.COOLDOWN_MS) {
      // 未接続・クールダウン中は要求を保留し、連続状態 (streak) は維持する。
      // 接続復帰やクールダウン経過後の次の検知で即座に発火できる。
      return false;
    }
    this.lastRequestAtMs = nowMs;
    this.noopStreak = 0;
    this.lastNoOpAtMs = -Infinity;
    return true;
  }
}
