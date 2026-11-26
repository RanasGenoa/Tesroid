import type { PrimaryPlaybackMode, PrimarySyncMetadata } from "@tesroid/shared";
import type { Clock } from "../../infra/index.js";
import type { ClientSessionRecord, SessionConnectionId } from "./ports.js";

export interface SessionRegistryDeps {
  readonly clock: Clock;
  readonly onGraceExpired: () => void;
}

export class SessionRegistry {
  // Spec: docs/specs/02-session-multidisplay.md#2.1
  constructor(deps: SessionRegistryDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  register(session: ClientSessionRecord): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  remove(sessionId: SessionConnectionId): ClientSessionRecord | null {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  get(sessionId: SessionConnectionId): ClientSessionRecord | null {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  findByToken(token: string): readonly ClientSessionRecord[] {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  getPrimaryAuthority(): ClientSessionRecord | null {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  getStreamingSecondaries(): readonly ClientSessionRecord[] {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  getStandbySecondaries(): readonly ClientSessionRecord[] {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  getAll(): readonly ClientSessionRecord[] {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  armReloadGrace(delayMs: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  cancelReloadGrace(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#4
  isReloadGraceActive(): boolean {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.4
  recordPrimaryFeedback(
    renderedPtsUs: number,
    targetBufferMs: number,
    mode: PrimaryPlaybackMode,
  ): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.4
  getPrimarySyncMetadata(): PrimarySyncMetadata {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  dispose(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
