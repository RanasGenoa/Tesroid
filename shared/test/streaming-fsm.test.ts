import { describe, it } from "vitest";

describe("shared/state streaming-fsm (Spec 03 AC-04, AC-06, Spec 04, Spec 07, Spec 10)", () => {
  it.todo(
    "Spec 03 AC-06: transitions STANDBY -> LIVE or CATCHUP on SESSION_ACTIVATED with BROADCAST_STATE effect",
  );
  it.todo(
    "Spec 03 AC-06: ignores USER_INTERACTION, SOCKET_CONGESTED, and HOLD_THRESHOLD_REACHED while in STANDBY",
  );
  it.todo(
    "Spec 03 AC-06: keeps LIVE invariant on SOCKET_CONGESTED with ENTER_LIVE_HYSTERESIS effect and never transitions to CATCHUP",
  );
  it.todo(
    "Spec 03 AC-06 & Spec 04 §2.3: transitions LIVE -> INTERACTIVE on USER_INTERACTION and refreshes INTERACTION_TIMEOUT (4,000 ms)",
  );
  it.todo("Spec 03 AC-06: transitions INTERACTIVE -> LIVE on INTERACTION_TIMEOUT");
  it.todo(
    "Spec 03 AC-06: transitions CATCHUP -> LIVE on CATCHUP_DRAINED and CATCHUP -> INTERACTIVE on USER_INTERACTION with FLUSH_CATCHUP_QUEUE + ADVANCE_EPOCH_AND_RESET + ARM_INTERACTION_TIMER",
  );
  it.todo(
    "Spec 03 AC-06: transitions LIVE and CATCHUP -> BUFFER_HOLD on HOLD_THRESHOLD_REACHED with CANCEL_INTERACTION_TIMER + REQUEST_POWER_HOLD + BROADCAST_STATE",
  );
  it.todo(
    "Spec 03 AC-06 & Spec 10 AC-03: transitions BUFFER_HOLD -> LIVE on HOLD_DRAINED and BUFFER_HOLD -> INTERACTIVE on USER_INTERACTION with REQUEST_POWER_RESUME + ADVANCE_EPOCH_AND_RESET",
  );
  it.todo(
    "Spec 10 AC-03: transitions BUFFER_HOLD -> STANDBY directly on POWER_SLEEP / ENTER_STANDBY with FLUSH_CATCHUP_QUEUE and without REQUEST_POWER_RESUME",
  );
  it.todo(
    "Spec 03 AC-04: transitions all active states to LIVE on STREAM_RESET with FLUSH_CATCHUP_QUEUE + ADVANCE_EPOCH_AND_RESET + CANCEL_INTERACTION_TIMER",
  );
  it.todo(
    "Spec 03 AC-06 & Spec 04 §2.3 & Spec 07 §2.1: verifies pure selectors selectQueueKind, isInputAllowed, shouldSuppressMediaSend, and selectHudModeBadge across all states",
  );
});
