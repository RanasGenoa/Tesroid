import { describe, it } from "vitest";

describe("server/domains/power (Spec 10)", () => {
  it.todo(
    "AC-01: routes sleep, resume, and restart-browser consistently through single lifecycle state machine with dual V/A encoder guarantee on ACTIVE",
  );
  it.todo(
    "AC-02: enforces strict mutual exclusion between autoSleepTimer and holdExpireTimer, and re-arms holdExpireTimer on primary disconnect in BUFFER_HOLD even when autoSleepMinutes = 0",
  );
  it.todo(
    "AC-03: converts manual sleep during BUFFER_HOLD directly to SLEEP_PAUSED without encoder resume churn, and clears Hold on new primary or LIVE fallback",
  );
  it.todo(
    "AC-04: cancels autoSleepTimer when primary reconnects within grace delay, and transitions to SLEEP_PAUSED + demotes streaming secondaries when grace expires",
  );
});
