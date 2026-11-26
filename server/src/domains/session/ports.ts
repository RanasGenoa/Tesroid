import type {
  PrimaryPlaybackMode,
  PrimarySyncMetadata,
  SessionRole,
  WsCloseCode,
} from "@tesroid/shared";
import type { PowerSessionPort } from "../power/ports.js";

export type SessionConnectionId = string;

export interface SessionTransportPort {
  readonly id: SessionConnectionId;
  sendBinary(data: Uint8Array): void;
  getBufferedAmount(): number;
  close(code: WsCloseCode, reason?: string): void;
}

export interface ClientSessionRecord {
  readonly id: SessionConnectionId;
  readonly token: string;
  readonly role: SessionRole;
  readonly transport: SessionTransportPort;
  readonly connectedAtMs: number;
}

export type SessionAuthOutcome =
  | {
      readonly ok: true;
      readonly session: ClientSessionRecord;
      readonly displacedSessionId?: SessionConnectionId;
      readonly demotedActingPrimaryId?: SessionConnectionId;
      readonly requiresDualEncoderReset: boolean;
    }
  | {
      readonly ok: false;
      readonly closeCode: WsCloseCode;
      readonly reason: string;
      readonly remainingAttempts?: number;
    };

export interface PrimaryDisconnectOutcome {
  readonly promotedSessionId: SessionConnectionId | null;
  readonly graceTimerArmed: boolean;
  readonly allPrimariesAbsent: boolean;
}

export interface SessionServicePort extends PowerSessionPort {
  authenticatePrimaryPin(transport: SessionTransportPort, pin: string): Promise<SessionAuthOutcome>;
  authenticateSecondaryPin(
    transport: SessionTransportPort,
    pin: string,
    preferStandby?: boolean,
  ): Promise<SessionAuthOutcome>;
  authenticateToken(
    transport: SessionTransportPort,
    token: string,
    pipelineRunning: boolean,
  ): Promise<SessionAuthOutcome>;
  handleDisconnect(sessionId: SessionConnectionId, closeCode: number): PrimaryDisconnectOutcome;
  getSession(sessionId: SessionConnectionId): ClientSessionRecord | null;
  getPrimaryAuthority(): ClientSessionRecord | null;
  getStreamingSecondaries(): readonly ClientSessionRecord[];
  getAllSessions(): readonly ClientSessionRecord[];
  recordPrimaryFeedback(
    sessionId: SessionConnectionId,
    renderedPtsUs: number,
    targetBufferMs: number,
    mode: PrimaryPlaybackMode,
  ): void;
  getPrimarySyncMetadata(): PrimarySyncMetadata;
  closeAllWithPolicyViolation(reason: string): void;
}
