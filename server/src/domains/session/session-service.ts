import type { PrimaryPlaybackMode, PrimarySyncMetadata } from "@tesroid/shared";
import type { Clock } from "../../infra/index.js";
import type { AuthServicePort } from "../auth/ports.js";
import type { SettingsRepository } from "../settings/ports.js";
import type {
  ClientSessionRecord,
  PrimaryDisconnectOutcome,
  SessionAuthOutcome,
  SessionConnectionId,
  SessionServicePort,
  SessionTransportPort,
} from "./ports.js";
import type { SessionRegistry } from "./session-registry.js";

export interface SessionServiceDeps {
  readonly clock: Clock;
  readonly auth: AuthServicePort;
  readonly settings: SettingsRepository;
  readonly registry: SessionRegistry;
}

export class SessionService implements SessionServicePort {
  // Spec: docs/specs/02-session-multidisplay.md#2.1
  constructor(deps: SessionServiceDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  authenticatePrimaryPin(
    transport: SessionTransportPort,
    pin: string,
  ): Promise<SessionAuthOutcome> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  authenticateSecondaryPin(
    transport: SessionTransportPort,
    pin: string,
    preferStandby?: boolean,
  ): Promise<SessionAuthOutcome> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  authenticateToken(
    transport: SessionTransportPort,
    token: string,
    pipelineRunning: boolean,
  ): Promise<SessionAuthOutcome> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  handleDisconnect(sessionId: SessionConnectionId, closeCode: number): PrimaryDisconnectOutcome {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  getSession(sessionId: SessionConnectionId): ClientSessionRecord | null {
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
  getAllSessions(): readonly ClientSessionRecord[] {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.4
  recordPrimaryFeedback(
    sessionId: SessionConnectionId,
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

  // Spec: docs/specs/01-auth-security.md#2.2
  closeAllWithPolicyViolation(reason: string): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  hasActivePrimaryOrActing(): boolean {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  demoteAllStreamingToStandby(streamEpoch: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  promoteStandbyToStreaming(streamEpoch: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
