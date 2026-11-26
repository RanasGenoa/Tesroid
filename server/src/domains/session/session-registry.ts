import type { PrimaryPlaybackMode, PrimarySyncMetadata, SessionRole } from "@tesroid/shared";
import type { Clock, TimerHandle } from "../../infra/index.js";
import type { ClientSessionRecord, SessionConnectionId } from "./ports.js";

export interface SessionRegistryDeps {
  readonly clock: Clock;
  readonly onGraceExpired: () => void;
}

interface StoredPrimaryFeedback {
  readonly renderedPtsUs: number;
  readonly targetBufferMs: number;
  readonly mode: PrimaryPlaybackMode;
  readonly recordedAtMs: number;
}

export class SessionRegistry {
  private readonly deps: SessionRegistryDeps;
  private readonly sessions = new Map<SessionConnectionId, ClientSessionRecord>();
  private reloadGraceTimer: TimerHandle | null = null;
  private primaryFeedback: StoredPrimaryFeedback | null = null;

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  constructor(deps: SessionRegistryDeps) {
    this.deps = deps;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  register(session: ClientSessionRecord): void {
    this.sessions.set(session.id, session);
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  remove(sessionId: SessionConnectionId): ClientSessionRecord | null {
    const existing = this.sessions.get(sessionId);
    if (existing === undefined) {
      return null;
    }
    this.sessions.delete(sessionId);
    return existing;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  updateRole(sessionId: SessionConnectionId, role: SessionRole): ClientSessionRecord | null {
    const existing = this.sessions.get(sessionId);
    if (existing === undefined) {
      return null;
    }
    const updated: ClientSessionRecord = {
      ...existing,
      role,
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  get(sessionId: SessionConnectionId): ClientSessionRecord | null {
    return this.sessions.get(sessionId) ?? null;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  findByToken(token: string): readonly ClientSessionRecord[] {
    const matches: ClientSessionRecord[] = [];
    for (const session of this.sessions.values()) {
      if (session.token === token) {
        matches.push(session);
      }
    }
    return matches;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  getPrimaryAuthority(): ClientSessionRecord | null {
    let acting: ClientSessionRecord | null = null;
    for (const session of this.sessions.values()) {
      if (session.role === "PRIMARY") {
        return session;
      }
      if (session.role === "ACTING_PRIMARY" && acting === null) {
        acting = session;
      }
    }
    return acting;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  getStreamingSecondaries(): readonly ClientSessionRecord[] {
    const results: ClientSessionRecord[] = [];
    for (const session of this.sessions.values()) {
      if (session.role === "SECONDARY_STREAMING") {
        results.push(session);
      }
    }
    return results;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  getStandbySecondaries(): readonly ClientSessionRecord[] {
    const results: ClientSessionRecord[] = [];
    for (const session of this.sessions.values()) {
      if (session.role === "SECONDARY_STANDBY") {
        results.push(session);
      }
    }
    return results;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  getAll(): readonly ClientSessionRecord[] {
    return [...this.sessions.values()];
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  armReloadGrace(delayMs: number): void {
    this.cancelReloadGrace();
    const safeDelayMs = Number.isFinite(delayMs) ? Math.max(0, Math.round(delayMs)) : 0;
    this.reloadGraceTimer = this.deps.clock.setTimeout(() => {
      this.reloadGraceTimer = null;
      this.deps.onGraceExpired();
    }, safeDelayMs);
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  cancelReloadGrace(): void {
    if (this.reloadGraceTimer !== null) {
      this.deps.clock.clearTimeout(this.reloadGraceTimer);
      this.reloadGraceTimer = null;
    }
  }

  // Spec: docs/specs/02-session-multidisplay.md#4
  isReloadGraceActive(): boolean {
    return this.reloadGraceTimer !== null;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.4
  recordPrimaryFeedback(
    renderedPtsUs: number,
    targetBufferMs: number,
    mode: PrimaryPlaybackMode,
  ): void {
    this.primaryFeedback = {
      renderedPtsUs,
      targetBufferMs,
      mode,
      recordedAtMs: this.deps.clock.nowMs(),
    };
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.4
  clearPrimaryFeedback(): void {
    this.primaryFeedback = null;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.4
  getPrimarySyncMetadata(): PrimarySyncMetadata {
    if (this.isReloadGraceActive()) {
      // Nullify PTS and age during reload grace so secondaries do not extrapolate stale timestamps.
      return {
        primaryRenderedPts: null,
        primaryFeedbackAgeMs: null,
        primaryTargetBufferMs: this.primaryFeedback?.targetBufferMs ?? 0,
        primaryMode: this.primaryFeedback?.mode ?? null,
      };
    }
    if (this.primaryFeedback === null) {
      return {
        primaryRenderedPts: null,
        primaryFeedbackAgeMs: null,
        primaryTargetBufferMs: 0,
        primaryMode: null,
      };
    }
    return {
      primaryRenderedPts: this.primaryFeedback.renderedPtsUs,
      primaryFeedbackAgeMs: Math.max(
        0,
        this.deps.clock.nowMs() - this.primaryFeedback.recordedAtMs,
      ),
      primaryTargetBufferMs: this.primaryFeedback.targetBufferMs,
      primaryMode: this.primaryFeedback.mode,
    };
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  dispose(): void {
    this.cancelReloadGrace();
  }
}
