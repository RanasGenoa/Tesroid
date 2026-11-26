import { describe, it } from "vitest";

describe("Integration: Session, Power & Stream Reset (Spec 02, 03, 10)", () => {
  it.todo(
    "Spec 01 AC-02: allows valid initial PIN over WS /ws when setup is incomplete and establishes PRIMARY session",
  );
  it.todo(
    "Spec 02 AC-01: displaces existing PRIMARY with WS 4009 on new raw PIN login and rejects competing token reconnect with WS 4009",
  );
  it.todo(
    "Spec 02 AC-02: closes superseded socket with WS 4000 (not 4009) when new socket authenticates with identical token",
  );
  it.todo(
    "Spec 02 AC-03: ignores resize/reset from SECONDARY_STREAMING, omits audio packets to secondaries, and attaches fresh primary sync metadata on PONG",
  );
  it.todo(
    "Spec 02 AC-04: keeps browser/encoders asleep when SECONDARY_STANDBY connects and promotes to streaming upon PRIMARY login",
  );
  it.todo(
    "Spec 02 AC-05: promotes first secondary to ACTING_PRIMARY on explicit 1000 disconnect (or >3s 1001 grace), prevents chained promotion, and resets V/A encoders on PRIMARY return",
  );
  it.todo(
    "Spec 02 AC-06: protects secondary playback during primary 1006 transient disconnect until auto-sleep triggers SECONDARY_STANDBY",
  );
  it.todo(
    "Spec 03 AC-04 & Spec 10 AC-01: unifies POST /api/stream/reset (always resets V/A encoders + new streamEpoch) and POST /api/power/* lifecycle routes",
  );
});
