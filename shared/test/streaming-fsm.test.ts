import {
  createInitialStreamingState,
  INTERACTION_TIMEOUT_MS,
  isInputAllowed,
  type StreamingEffect,
  type StreamingEvent,
  type StreamingState,
  type StreamingStateKind,
  selectHudModeBadge,
  selectQueueKind,
  shouldSuppressMediaSend,
  transitionStreamingState,
} from "@tesroid/shared";
import { describe, expect, it } from "vitest";

describe("shared/state streaming-fsm (Spec 03 AC-04, AC-06, Spec 04, Spec 07, Spec 10)", () => {
  it("Spec 03 AC-06: transitions STANDBY -> LIVE or CATCHUP on SESSION_ACTIVATED with BROADCAST_STATE effect", () => {
    const standby = createInitialStreamingState(1, "UNAUTHENTICATED");
    expect(standby).toEqual({ kind: "STANDBY", streamEpoch: 1, reason: "UNAUTHENTICATED" });

    const toLive = transitionStreamingState(standby, {
      type: "SESSION_ACTIVATED",
      streamEpoch: 2,
    });
    expect(toLive).toEqual({
      nextState: { kind: "LIVE", streamEpoch: 2 },
      effects: [{ type: "BROADCAST_STATE" }],
    });

    const toCatchup = transitionStreamingState(standby, {
      type: "SESSION_ACTIVATED",
      streamEpoch: 3,
      resumeCatchup: { targetBufferMs: 10_000, resumePtsUs: 450_000 },
    });
    expect(toCatchup).toEqual({
      nextState: {
        kind: "CATCHUP",
        streamEpoch: 3,
        targetBufferMs: 10_000,
        resumePtsUs: 450_000,
      },
      effects: [{ type: "BROADCAST_STATE" }],
    });
  });

  it("Spec 03 AC-06: ignores USER_INTERACTION, SOCKET_CONGESTED, and HOLD_THRESHOLD_REACHED while in STANDBY", () => {
    const standby = createInitialStreamingState(4, "REAR_STANDBY");

    for (const event of [
      { type: "USER_INTERACTION", atMs: 1_000, newStreamEpoch: 5 },
      { type: "SOCKET_CONGESTED" },
      { type: "HOLD_THRESHOLD_REACHED", atMs: 1_000, targetBufferMs: 10_000 },
      { type: "INTERACTION_TIMEOUT" },
      { type: "CATCHUP_DRAINED" },
      { type: "HOLD_DRAINED", newStreamEpoch: 5 },
      { type: "STREAM_RESET", newStreamEpoch: 5 },
    ] satisfies readonly StreamingEvent[]) {
      const result = transitionStreamingState(standby, event);
      expect(result.nextState).toEqual(standby);
      expect(result.effects).toEqual([]);
    }
  });

  it("Spec 03 AC-06: keeps LIVE invariant on SOCKET_CONGESTED with ENTER_LIVE_HYSTERESIS effect and never transitions to CATCHUP", () => {
    const live: StreamingState = { kind: "LIVE", streamEpoch: 7 };
    const result = transitionStreamingState(live, { type: "SOCKET_CONGESTED" });

    expect(result.nextState).toEqual(live);
    expect(result.nextState.kind).not.toBe("CATCHUP");
    expect(result.effects).toEqual([{ type: "ENTER_LIVE_HYSTERESIS" }]);
  });

  it("Spec 03 AC-06 & Spec 04 §2.3: transitions LIVE -> INTERACTIVE on USER_INTERACTION and refreshes INTERACTION_TIMEOUT (4,000 ms)", () => {
    const live: StreamingState = { kind: "LIVE", streamEpoch: 2 };
    const entered = transitionStreamingState(live, {
      type: "USER_INTERACTION",
      atMs: 1_000,
      newStreamEpoch: 3,
    });
    expect(entered).toEqual({
      nextState: { kind: "INTERACTIVE", streamEpoch: 2, lastInteractionAtMs: 1_000 },
      effects: [
        { type: "ARM_INTERACTION_TIMER", delayMs: INTERACTION_TIMEOUT_MS },
        { type: "BROADCAST_STATE" },
      ],
    });

    const refreshed = transitionStreamingState(entered.nextState, {
      type: "USER_INTERACTION",
      atMs: 2_500,
      newStreamEpoch: 4,
    });
    expect(refreshed).toEqual({
      nextState: { kind: "INTERACTIVE", streamEpoch: 2, lastInteractionAtMs: 2_500 },
      effects: [{ type: "ARM_INTERACTION_TIMER", delayMs: 4_000 }],
    });
  });

  it("Spec 03 AC-06: transitions INTERACTIVE -> LIVE on INTERACTION_TIMEOUT", () => {
    const interactive: StreamingState = {
      kind: "INTERACTIVE",
      streamEpoch: 9,
      lastInteractionAtMs: 5_000,
    };
    expect(transitionStreamingState(interactive, { type: "INTERACTION_TIMEOUT" })).toEqual({
      nextState: { kind: "LIVE", streamEpoch: 9 },
      effects: [{ type: "BROADCAST_STATE" }],
    });
  });

  it("Spec 03 AC-06: transitions CATCHUP -> LIVE on CATCHUP_DRAINED and CATCHUP -> INTERACTIVE on USER_INTERACTION with FLUSH_CATCHUP_QUEUE + ADVANCE_EPOCH_AND_RESET + ARM_INTERACTION_TIMER", () => {
    const catchup: StreamingState = {
      kind: "CATCHUP",
      streamEpoch: 5,
      targetBufferMs: 10_000,
      resumePtsUs: 200_000,
    };

    expect(transitionStreamingState(catchup, { type: "CATCHUP_DRAINED" })).toEqual({
      nextState: { kind: "LIVE", streamEpoch: 5 },
      effects: [{ type: "BROADCAST_STATE" }],
    });

    expect(
      transitionStreamingState(catchup, {
        type: "USER_INTERACTION",
        atMs: 3_000,
        newStreamEpoch: 6,
      }),
    ).toEqual({
      nextState: { kind: "INTERACTIVE", streamEpoch: 6, lastInteractionAtMs: 3_000 },
      effects: [
        { type: "FLUSH_CATCHUP_QUEUE" },
        { type: "ADVANCE_EPOCH_AND_RESET", streamEpoch: 6 },
        { type: "ARM_INTERACTION_TIMER", delayMs: INTERACTION_TIMEOUT_MS },
        { type: "BROADCAST_STATE" },
      ],
    });
  });

  it("Spec 03 AC-06: transitions LIVE and CATCHUP -> BUFFER_HOLD on HOLD_THRESHOLD_REACHED with CANCEL_INTERACTION_TIMER + REQUEST_POWER_HOLD + BROADCAST_STATE", () => {
    const expectedEffects: readonly StreamingEffect[] = [
      { type: "CANCEL_INTERACTION_TIMER" },
      { type: "REQUEST_POWER_HOLD" },
      { type: "BROADCAST_STATE" },
    ];

    for (const active of [
      { kind: "LIVE", streamEpoch: 8 },
      { kind: "CATCHUP", streamEpoch: 8, targetBufferMs: 12_000, resumePtsUs: 999 },
    ] satisfies readonly StreamingState[]) {
      expect(
        transitionStreamingState(active, {
          type: "HOLD_THRESHOLD_REACHED",
          atMs: 9_000,
          targetBufferMs: 12_000,
        }),
      ).toEqual({
        nextState: {
          kind: "BUFFER_HOLD",
          streamEpoch: 8,
          holdSinceMs: 9_000,
          targetBufferMs: 12_000,
        },
        effects: expectedEffects,
      });
    }
  });

  it("Spec 03 AC-06 & Spec 10 AC-03: transitions BUFFER_HOLD -> LIVE on HOLD_DRAINED and BUFFER_HOLD -> INTERACTIVE on USER_INTERACTION with REQUEST_POWER_RESUME + ADVANCE_EPOCH_AND_RESET", () => {
    const hold: StreamingState = {
      kind: "BUFFER_HOLD",
      streamEpoch: 10,
      holdSinceMs: 4_000,
      targetBufferMs: 10_000,
    };

    expect(transitionStreamingState(hold, { type: "HOLD_DRAINED", newStreamEpoch: 11 })).toEqual({
      nextState: { kind: "LIVE", streamEpoch: 11 },
      effects: [
        { type: "REQUEST_POWER_RESUME" },
        { type: "ADVANCE_EPOCH_AND_RESET", streamEpoch: 11 },
        { type: "BROADCAST_STATE" },
      ],
    });

    expect(
      transitionStreamingState(hold, {
        type: "USER_INTERACTION",
        atMs: 6_000,
        newStreamEpoch: 12,
      }),
    ).toEqual({
      nextState: { kind: "INTERACTIVE", streamEpoch: 12, lastInteractionAtMs: 6_000 },
      effects: [
        { type: "FLUSH_CATCHUP_QUEUE" },
        { type: "REQUEST_POWER_RESUME" },
        { type: "ADVANCE_EPOCH_AND_RESET", streamEpoch: 12 },
        { type: "ARM_INTERACTION_TIMER", delayMs: INTERACTION_TIMEOUT_MS },
        { type: "BROADCAST_STATE" },
      ],
    });
  });

  it("Spec 10 AC-03: transitions BUFFER_HOLD -> STANDBY directly on POWER_SLEEP / ENTER_STANDBY with FLUSH_CATCHUP_QUEUE and without REQUEST_POWER_RESUME", () => {
    const hold: StreamingState = {
      kind: "BUFFER_HOLD",
      streamEpoch: 10,
      holdSinceMs: 4_000,
      targetBufferMs: 10_000,
    };

    const sleepResult = transitionStreamingState(hold, { type: "POWER_SLEEP" });
    expect(sleepResult).toEqual({
      nextState: { kind: "STANDBY", streamEpoch: 10, reason: "SLEEP_PAUSED" },
      effects: [{ type: "FLUSH_CATCHUP_QUEUE" }, { type: "BROADCAST_STATE" }],
    });
    expect(sleepResult.effects.some((e) => e.type === "REQUEST_POWER_RESUME")).toBe(false);

    const standbyResult = transitionStreamingState(hold, {
      type: "ENTER_STANDBY",
      reason: "REAR_STANDBY",
    });
    expect(standbyResult).toEqual({
      nextState: { kind: "STANDBY", streamEpoch: 10, reason: "REAR_STANDBY" },
      effects: [{ type: "FLUSH_CATCHUP_QUEUE" }, { type: "BROADCAST_STATE" }],
    });
  });

  it("Spec 03 AC-04: transitions all active states to LIVE on STREAM_RESET with FLUSH_CATCHUP_QUEUE + ADVANCE_EPOCH_AND_RESET + CANCEL_INTERACTION_TIMER", () => {
    const activeStates: readonly StreamingState[] = [
      { kind: "INTERACTIVE", streamEpoch: 1, lastInteractionAtMs: 500 },
      { kind: "LIVE", streamEpoch: 1 },
      { kind: "CATCHUP", streamEpoch: 1, targetBufferMs: 10_000, resumePtsUs: 100 },
      { kind: "BUFFER_HOLD", streamEpoch: 1, holdSinceMs: 1_000, targetBufferMs: 10_000 },
    ];

    for (const state of activeStates) {
      const result = transitionStreamingState(state, {
        type: "STREAM_RESET",
        newStreamEpoch: 99,
      });
      expect(result.nextState).toEqual({ kind: "LIVE", streamEpoch: 99 });
      expect(result.effects).toEqual(
        expect.arrayContaining([
          { type: "FLUSH_CATCHUP_QUEUE" },
          { type: "ADVANCE_EPOCH_AND_RESET", streamEpoch: 99 },
          { type: "CANCEL_INTERACTION_TIMER" },
          { type: "BROADCAST_STATE" },
        ]),
      );
    }
  });

  it("Spec 03 AC-06 & Spec 04 §2.3 & Spec 07 §2.1: verifies pure selectors selectQueueKind, isInputAllowed, shouldSuppressMediaSend, and selectHudModeBadge across all states", () => {
    const states: readonly StreamingState[] = [
      { kind: "STANDBY", streamEpoch: 1, reason: "UNAUTHENTICATED" },
      { kind: "INTERACTIVE", streamEpoch: 1, lastInteractionAtMs: 1_000 },
      { kind: "LIVE", streamEpoch: 1 },
      { kind: "CATCHUP", streamEpoch: 1, targetBufferMs: 10_000, resumePtsUs: 1_000 },
      { kind: "BUFFER_HOLD", streamEpoch: 1, holdSinceMs: 1_000, targetBufferMs: 10_000 },
    ];

    expect(states.map(selectQueueKind)).toEqual(["NONE", "LIVE", "LIVE", "CATCHUP", "CATCHUP"]);
    expect(states.map(isInputAllowed)).toEqual([false, true, true, true, true]);
    expect(states.map(shouldSuppressMediaSend)).toEqual([true, false, false, false, true]);

    const calm = { localBufferedMs: 100, serverBufferedMs: 100, isWaitingForKeyframe: false };
    const waiting = { localBufferedMs: 1_000, serverBufferedMs: 1_000, isWaitingForKeyframe: true };
    const bufferedLocal = {
      localBufferedMs: 800,
      serverBufferedMs: 100,
      isWaitingForKeyframe: false,
    };
    const bufferedServer = {
      localBufferedMs: 100,
      serverBufferedMs: 600,
      isWaitingForKeyframe: false,
    };

    expect(states.map((s) => selectHudModeBadge(s, calm))).toEqual([
      "STANDBY",
      "DIRECT_LIVE",
      "LIVE",
      "LIVE",
      "HOLD",
    ]);
    expect(states.map((s) => selectHudModeBadge(s, waiting))).toEqual([
      "STANDBY",
      "DIRECT_LIVE",
      "WAIT",
      "WAIT",
      "HOLD",
    ]);
    const liveState: StreamingState = { kind: "LIVE", streamEpoch: 1 };
    const catchupState: StreamingState = {
      kind: "CATCHUP",
      streamEpoch: 1,
      targetBufferMs: 10_000,
      resumePtsUs: 1_000,
    };
    expect(selectHudModeBadge(liveState, bufferedLocal)).toBe("BUF");
    expect(selectHudModeBadge(catchupState, bufferedServer)).toBe("BUF");
  });

  it("Spec 03 AC-06: covers full 5x10 state-event transition matrix deterministically", () => {
    const sampleStates: Record<StreamingStateKind, StreamingState> = {
      STANDBY: { kind: "STANDBY", streamEpoch: 1, reason: "UNAUTHENTICATED" },
      INTERACTIVE: { kind: "INTERACTIVE", streamEpoch: 1, lastInteractionAtMs: 100 },
      LIVE: { kind: "LIVE", streamEpoch: 1 },
      CATCHUP: { kind: "CATCHUP", streamEpoch: 1, targetBufferMs: 10_000, resumePtsUs: 500 },
      BUFFER_HOLD: {
        kind: "BUFFER_HOLD",
        streamEpoch: 1,
        holdSinceMs: 200,
        targetBufferMs: 10_000,
      },
    };

    const sampleEvents: Record<StreamingEvent["type"], StreamingEvent> = {
      SESSION_ACTIVATED: { type: "SESSION_ACTIVATED", streamEpoch: 2 },
      ENTER_STANDBY: { type: "ENTER_STANDBY", reason: "REAR_STANDBY" },
      USER_INTERACTION: { type: "USER_INTERACTION", atMs: 300, newStreamEpoch: 2 },
      INTERACTION_TIMEOUT: { type: "INTERACTION_TIMEOUT" },
      CATCHUP_DRAINED: { type: "CATCHUP_DRAINED" },
      SOCKET_CONGESTED: { type: "SOCKET_CONGESTED" },
      HOLD_THRESHOLD_REACHED: { type: "HOLD_THRESHOLD_REACHED", atMs: 400, targetBufferMs: 10_000 },
      HOLD_DRAINED: { type: "HOLD_DRAINED", newStreamEpoch: 2 },
      STREAM_RESET: { type: "STREAM_RESET", newStreamEpoch: 2 },
      POWER_SLEEP: { type: "POWER_SLEEP" },
    };

    const expectedMatrix: Record<
      StreamingStateKind,
      Record<StreamingEvent["type"], StreamingStateKind>
    > = {
      STANDBY: {
        SESSION_ACTIVATED: "LIVE",
        ENTER_STANDBY: "STANDBY",
        USER_INTERACTION: "STANDBY",
        INTERACTION_TIMEOUT: "STANDBY",
        CATCHUP_DRAINED: "STANDBY",
        SOCKET_CONGESTED: "STANDBY",
        HOLD_THRESHOLD_REACHED: "STANDBY",
        HOLD_DRAINED: "STANDBY",
        STREAM_RESET: "STANDBY",
        POWER_SLEEP: "STANDBY",
      },
      INTERACTIVE: {
        SESSION_ACTIVATED: "LIVE",
        ENTER_STANDBY: "STANDBY",
        USER_INTERACTION: "INTERACTIVE",
        INTERACTION_TIMEOUT: "LIVE",
        CATCHUP_DRAINED: "INTERACTIVE",
        SOCKET_CONGESTED: "INTERACTIVE",
        HOLD_THRESHOLD_REACHED: "INTERACTIVE",
        HOLD_DRAINED: "INTERACTIVE",
        STREAM_RESET: "LIVE",
        POWER_SLEEP: "STANDBY",
      },
      LIVE: {
        SESSION_ACTIVATED: "LIVE",
        ENTER_STANDBY: "STANDBY",
        USER_INTERACTION: "INTERACTIVE",
        INTERACTION_TIMEOUT: "LIVE",
        CATCHUP_DRAINED: "LIVE",
        SOCKET_CONGESTED: "LIVE",
        HOLD_THRESHOLD_REACHED: "BUFFER_HOLD",
        HOLD_DRAINED: "LIVE",
        STREAM_RESET: "LIVE",
        POWER_SLEEP: "STANDBY",
      },
      CATCHUP: {
        SESSION_ACTIVATED: "LIVE",
        ENTER_STANDBY: "STANDBY",
        USER_INTERACTION: "INTERACTIVE",
        INTERACTION_TIMEOUT: "CATCHUP",
        CATCHUP_DRAINED: "LIVE",
        SOCKET_CONGESTED: "CATCHUP",
        HOLD_THRESHOLD_REACHED: "BUFFER_HOLD",
        HOLD_DRAINED: "CATCHUP",
        STREAM_RESET: "LIVE",
        POWER_SLEEP: "STANDBY",
      },
      BUFFER_HOLD: {
        SESSION_ACTIVATED: "LIVE",
        ENTER_STANDBY: "STANDBY",
        USER_INTERACTION: "INTERACTIVE",
        INTERACTION_TIMEOUT: "BUFFER_HOLD",
        CATCHUP_DRAINED: "BUFFER_HOLD",
        SOCKET_CONGESTED: "BUFFER_HOLD",
        HOLD_THRESHOLD_REACHED: "BUFFER_HOLD",
        HOLD_DRAINED: "LIVE",
        STREAM_RESET: "LIVE",
        POWER_SLEEP: "STANDBY",
      },
    };

    for (const [stateKind, state] of Object.entries(sampleStates) as [
      StreamingStateKind,
      StreamingState,
    ][]) {
      for (const [eventType, event] of Object.entries(sampleEvents) as [
        StreamingEvent["type"],
        StreamingEvent,
      ][]) {
        const result = transitionStreamingState(state, event);
        expect(result.nextState.kind, `${stateKind} + ${eventType}`).toBe(
          expectedMatrix[stateKind][eventType],
        );
      }
    }
  });
});
