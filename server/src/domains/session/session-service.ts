import {
  encodeServerControlFrame,
  isCurrentStreamEpoch,
  isValidPin,
  PROTOCOL_TIMING,
  type PrimaryPlaybackMode,
  type PrimarySyncMetadata,
  type SessionRole,
  STREAM_EPOCH_INITIAL,
  WS_CLOSE_CODE,
} from "@tesroid/shared";
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

export interface SessionServiceCallbacks {
  readonly getStreamEpoch?: () => number;
  readonly onActingPrimaryPromoted?: (session: ClientSessionRecord) => void;
  readonly onReloadGraceExpiredWithoutSecondary?: () => void;
}

export interface SessionServiceDeps {
  readonly clock: Clock;
  readonly auth: AuthServicePort;
  readonly settings: SettingsRepository;
  readonly registry: SessionRegistry;
  readonly callbacks?: SessionServiceCallbacks;
}

export class SessionService implements SessionServicePort {
  private readonly deps: SessionServiceDeps;
  private activePrimaryToken: string | null = null;
  private pendingGracePrimaryToken: string | null = null;
  private readonly tokenLastRole = new Map<string, SessionRole>();

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  constructor(deps: SessionServiceDeps) {
    this.deps = deps;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  async authenticatePrimaryPin(
    transport: SessionTransportPort,
    pin: string,
  ): Promise<SessionAuthOutcome> {
    let token: string;
    const currentSettings = this.deps.settings.getCurrent();
    if (!currentSettings.isSetupCompleted) {
      const lockoutStatus = this.deps.auth.getLockoutStatus();
      if (lockoutStatus.isLocked) {
        return {
          ok: false,
          closeCode: WS_CLOSE_CODE.POLICY_VIOLATION,
          reason: "LOCKED",
          remainingAttempts: 0,
        };
      }
      if (!isValidPin(pin)) {
        return {
          ok: false,
          closeCode: WS_CLOSE_CODE.POLICY_VIOLATION,
          reason: "INVALID_PIN",
          remainingAttempts: lockoutStatus.remainingAttempts,
        };
      }
      const pinHash = await this.deps.auth.hashPin(pin);
      await this.deps.settings.completeSetup({
        pinHash,
        timezone: currentSettings.timezone,
      });
      await this.deps.auth.resetLockout();
      token = this.deps.auth.issueToken("PRIMARY").token;
    } else {
      const result = await this.deps.auth.verifyPin(pin, "PRIMARY");
      if (!result.ok) {
        return {
          ok: false,
          closeCode: WS_CLOSE_CODE.POLICY_VIOLATION,
          reason: result.reason,
          remainingAttempts: result.remainingAttempts,
        };
      }
      token = result.token;
    }

    this.deps.registry.cancelReloadGrace();
    if (this.pendingGracePrimaryToken !== null) {
      this.revokeAndForgetToken(this.pendingGracePrimaryToken);
      this.pendingGracePrimaryToken = null;
    }

    let displacedSessionId: SessionConnectionId | undefined;
    let demotedActingPrimaryId: SessionConnectionId | undefined;
    let requiresDualEncoderReset = false;

    const authority = this.deps.registry.getPrimaryAuthority();
    if (authority !== null) {
      if (authority.role === "PRIMARY") {
        displacedSessionId = authority.id;
        // Remove from registry before closing so async socket close does not trigger disconnect promotion.
        this.deps.registry.remove(authority.id);
        this.revokeAndForgetToken(authority.token);
        authority.transport.sendBinary(
          encodeServerControlFrame({
            type: "SESSION_CONFLICT",
            reason: "Replaced by new primary login",
          }),
        );
        authority.transport.close(WS_CLOSE_CODE.SESSION_CONFLICT, "Replaced by new primary login");
      } else if (authority.role === "ACTING_PRIMARY") {
        demotedActingPrimaryId = authority.id;
        requiresDualEncoderReset = true;
        this.deps.registry.updateRole(authority.id, "SECONDARY_STREAMING");
        this.tokenLastRole.set(authority.token, "SECONDARY_STREAMING");
      }
    }

    if (this.activePrimaryToken !== null && this.activePrimaryToken !== token) {
      this.revokeAndForgetToken(this.activePrimaryToken);
    }

    const session: ClientSessionRecord = {
      id: transport.id,
      token,
      role: "PRIMARY",
      transport,
      connectedAtMs: this.deps.clock.nowMs(),
    };
    this.deps.registry.register(session);
    this.activePrimaryToken = token;
    this.tokenLastRole.set(token, "PRIMARY");
    this.deps.registry.clearPrimaryFeedback();

    return {
      ok: true,
      session,
      displacedSessionId,
      demotedActingPrimaryId,
      requiresDualEncoderReset,
    };
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  async authenticateSecondaryPin(
    transport: SessionTransportPort,
    pin: string,
    _preferStandby?: boolean,
  ): Promise<SessionAuthOutcome> {
    const result = await this.deps.auth.verifyPin(pin, "SECONDARY_STREAMING");
    if (!result.ok) {
      return {
        ok: false,
        closeCode: WS_CLOSE_CODE.POLICY_VIOLATION,
        reason: result.reason,
        remainingAttempts: result.remainingAttempts,
      };
    }

    const authority = this.deps.registry.getPrimaryAuthority();
    if (authority?.role === "ACTING_PRIMARY") {
      this.deps.auth.revokeToken(result.token);
      transport.sendBinary(
        encodeServerControlFrame({
          type: "SESSION_CONFLICT",
          reason: "Acting primary is currently active",
        }),
      );
      transport.close(WS_CLOSE_CODE.SESSION_CONFLICT, "Acting primary is currently active");
      return {
        ok: false,
        closeCode: WS_CLOSE_CODE.SESSION_CONFLICT,
        reason: "ACTING_PRIMARY_ACTIVE",
      };
    }

    const role: SessionRole =
      authority?.role === "PRIMARY" ? "SECONDARY_STREAMING" : "SECONDARY_STANDBY";
    const session: ClientSessionRecord = {
      id: transport.id,
      token: result.token,
      role,
      transport,
      connectedAtMs: this.deps.clock.nowMs(),
    };
    this.deps.registry.register(session);
    this.tokenLastRole.set(result.token, role);

    return {
      ok: true,
      session,
      requiresDualEncoderReset: false,
    };
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  async authenticateToken(
    transport: SessionTransportPort,
    token: string,
    pipelineRunning: boolean,
  ): Promise<SessionAuthOutcome> {
    const tokenRecord = this.deps.auth.verifyToken(token);
    if (tokenRecord === null) {
      return {
        ok: false,
        closeCode: WS_CLOSE_CODE.POLICY_VIOLATION,
        reason: "INVALID_TOKEN",
      };
    }

    const sameTokenSessions = this.deps.registry.findByToken(token);
    if (sameTokenSessions.length > 0) {
      const inheritedRole = sameTokenSessions[0]?.role ?? tokenRecord.role;
      const displacedSessionId = sameTokenSessions[0]?.id;
      for (const oldSession of sameTokenSessions) {
        this.deps.registry.remove(oldSession.id);
        oldSession.transport.close(
          WS_CLOSE_CODE.SESSION_SUPERSEDED,
          "Replaced by reconnection with same token",
        );
      }
      if (inheritedRole === "PRIMARY") {
        this.deps.registry.cancelReloadGrace();
        if (this.pendingGracePrimaryToken === token) {
          this.pendingGracePrimaryToken = null;
        }
        this.activePrimaryToken = token;
      }
      const session: ClientSessionRecord = {
        id: transport.id,
        token,
        role: inheritedRole,
        transport,
        connectedAtMs: this.deps.clock.nowMs(),
      };
      this.deps.registry.register(session);
      this.tokenLastRole.set(token, inheritedRole);
      return {
        ok: true,
        session,
        displacedSessionId,
        requiresDualEncoderReset: false,
      };
    }

    const authority = this.deps.registry.getPrimaryAuthority();
    if (tokenRecord.role === "PRIMARY") {
      const hasDifferentAuthority = authority !== null && authority.token !== token;
      const hasDifferentGraceToken =
        this.deps.registry.isReloadGraceActive() &&
        this.pendingGracePrimaryToken !== null &&
        this.pendingGracePrimaryToken !== token;
      const hasDifferentActiveSessionWithSecondaries =
        this.activePrimaryToken !== null &&
        this.activePrimaryToken !== token &&
        this.deps.registry.getStreamingSecondaries().length > 0;

      if (
        hasDifferentAuthority ||
        hasDifferentGraceToken ||
        hasDifferentActiveSessionWithSecondaries
      ) {
        transport.sendBinary(
          encodeServerControlFrame({
            type: "SESSION_CONFLICT",
            reason: "Another primary session is active",
          }),
        );
        transport.close(WS_CLOSE_CODE.SESSION_CONFLICT, "Another primary session is active");
        return {
          ok: false,
          closeCode: WS_CLOSE_CODE.SESSION_CONFLICT,
          reason: "SESSION_CONFLICT",
        };
      }

      if (this.deps.registry.isReloadGraceActive() && this.pendingGracePrimaryToken === token) {
        this.deps.registry.cancelReloadGrace();
        this.pendingGracePrimaryToken = null;
      }

      const session: ClientSessionRecord = {
        id: transport.id,
        token,
        role: "PRIMARY",
        transport,
        connectedAtMs: this.deps.clock.nowMs(),
      };
      this.deps.registry.register(session);
      this.activePrimaryToken = token;
      this.tokenLastRole.set(token, "PRIMARY");
      return {
        ok: true,
        session,
        requiresDualEncoderReset: false,
      };
    }

    const lastRole = this.tokenLastRole.get(token);
    let role: SessionRole;
    if (authority?.role === "PRIMARY") {
      role = "SECONDARY_STREAMING";
    } else if (authority?.role === "ACTING_PRIMARY") {
      if (lastRole === "SECONDARY_STREAMING" && pipelineRunning) {
        role = "SECONDARY_STREAMING";
      } else {
        transport.sendBinary(
          encodeServerControlFrame({
            type: "SESSION_CONFLICT",
            reason: "Acting primary is currently active",
          }),
        );
        transport.close(WS_CLOSE_CODE.SESSION_CONFLICT, "Acting primary is currently active");
        return {
          ok: false,
          closeCode: WS_CLOSE_CODE.SESSION_CONFLICT,
          reason: "ACTING_PRIMARY_ACTIVE",
        };
      }
    } else if (lastRole === "ACTING_PRIMARY" && pipelineRunning) {
      role = "ACTING_PRIMARY";
    } else if (lastRole === "SECONDARY_STANDBY" || !pipelineRunning) {
      role = "SECONDARY_STANDBY";
    } else {
      role = "SECONDARY_STREAMING";
    }

    const session: ClientSessionRecord = {
      id: transport.id,
      token,
      role,
      transport,
      connectedAtMs: this.deps.clock.nowMs(),
    };
    this.deps.registry.register(session);
    this.tokenLastRole.set(token, role);

    return {
      ok: true,
      session,
      requiresDualEncoderReset: false,
    };
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  handleDisconnect(sessionId: SessionConnectionId, closeCode: number): PrimaryDisconnectOutcome {
    const removed = this.deps.registry.remove(sessionId);
    if (removed === null) {
      return {
        promotedSessionId: null,
        graceTimerArmed: false,
        allPrimariesAbsent: false,
      };
    }

    if (removed.role === "PRIMARY") {
      if (closeCode === WS_CLOSE_CODE.NORMAL) {
        this.revokeAndForgetToken(removed.token);
        if (this.activePrimaryToken === removed.token) {
          this.activePrimaryToken = null;
        }
        this.deps.registry.cancelReloadGrace();
        if (this.pendingGracePrimaryToken === removed.token) {
          this.pendingGracePrimaryToken = null;
        }
        const promoted = this.promoteFirstStreamingSecondary();
        if (promoted !== null) {
          return {
            promotedSessionId: promoted.id,
            graceTimerArmed: false,
            allPrimariesAbsent: false,
          };
        }
        return {
          promotedSessionId: null,
          graceTimerArmed: false,
          allPrimariesAbsent: true,
        };
      }

      if (closeCode === WS_CLOSE_CODE.GOING_AWAY) {
        if (this.deps.registry.getStreamingSecondaries().length > 0) {
          this.pendingGracePrimaryToken = removed.token;
          this.deps.registry.armReloadGrace(PROTOCOL_TIMING.reloadPromotionGraceMs);
          return {
            promotedSessionId: null,
            graceTimerArmed: true,
            allPrimariesAbsent: false,
          };
        }
        return {
          promotedSessionId: null,
          graceTimerArmed: false,
          allPrimariesAbsent: true,
        };
      }

      // Transient disconnect: retain token and keep streaming secondaries alive until power grace expires.
      return {
        promotedSessionId: null,
        graceTimerArmed: false,
        allPrimariesAbsent: true,
      };
    }

    if (removed.role === "ACTING_PRIMARY") {
      if (closeCode === WS_CLOSE_CODE.NORMAL) {
        this.revokeAndForgetToken(removed.token);
      }
      // Never chain-promote another secondary when ACTING_PRIMARY disconnects.
      return {
        promotedSessionId: null,
        graceTimerArmed: false,
        allPrimariesAbsent: !this.hasActivePrimaryOrActing(),
      };
    }

    if (closeCode === WS_CLOSE_CODE.NORMAL) {
      this.revokeAndForgetToken(removed.token);
    }
    return {
      promotedSessionId: null,
      graceTimerArmed: false,
      allPrimariesAbsent: false,
    };
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  handleReloadGraceExpired(): PrimaryDisconnectOutcome {
    const expiredToken = this.pendingGracePrimaryToken;
    this.pendingGracePrimaryToken = null;
    if (expiredToken !== null) {
      this.revokeAndForgetToken(expiredToken);
      if (this.activePrimaryToken === expiredToken) {
        this.activePrimaryToken = null;
      }
    }

    if (this.hasActivePrimaryOrActing()) {
      return {
        promotedSessionId: null,
        graceTimerArmed: false,
        allPrimariesAbsent: false,
      };
    }

    const promoted = this.promoteFirstStreamingSecondary();
    if (promoted !== null) {
      return {
        promotedSessionId: promoted.id,
        graceTimerArmed: false,
        allPrimariesAbsent: false,
      };
    }

    this.deps.callbacks?.onReloadGraceExpiredWithoutSecondary?.();
    return {
      promotedSessionId: null,
      graceTimerArmed: false,
      allPrimariesAbsent: true,
    };
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  getSession(sessionId: SessionConnectionId): ClientSessionRecord | null {
    return this.deps.registry.get(sessionId);
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  getPrimaryAuthority(): ClientSessionRecord | null {
    return this.deps.registry.getPrimaryAuthority();
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  getStreamingSecondaries(): readonly ClientSessionRecord[] {
    return this.deps.registry.getStreamingSecondaries();
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.1
  getAllSessions(): readonly ClientSessionRecord[] {
    return this.deps.registry.getAll();
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.4
  recordPrimaryFeedback(
    sessionId: SessionConnectionId,
    streamEpoch: number,
    renderedPtsUs: number,
    targetBufferMs: number,
    mode: PrimaryPlaybackMode,
  ): void {
    const authority = this.deps.registry.getPrimaryAuthority();
    if (authority === null || authority.id !== sessionId) {
      return;
    }
    if (
      !isCurrentStreamEpoch(streamEpoch, this.getStreamEpoch()) ||
      !Number.isFinite(renderedPtsUs)
    ) {
      return;
    }
    this.deps.registry.recordPrimaryFeedback(streamEpoch, renderedPtsUs, targetBufferMs, mode);
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  clearPrimaryFeedback(): void {
    this.deps.registry.clearPrimaryFeedback();
  }

  // Spec: docs/specs/03-streaming-transport.md#2.4
  getPrimaryConfirmedPtsUs(activeStreamEpoch: number): bigint | null {
    return this.deps.registry.getPrimaryConfirmedPtsUs(activeStreamEpoch);
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.4
  getPrimarySyncMetadata(): PrimarySyncMetadata {
    return this.deps.registry.getPrimarySyncMetadata(this.getStreamEpoch());
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  closeAllWithPolicyViolation(reason: string): void {
    this.deps.registry.cancelReloadGrace();
    const sessions = this.deps.registry.getAll();
    for (const session of sessions) {
      this.deps.registry.remove(session.id);
      session.transport.close(WS_CLOSE_CODE.POLICY_VIOLATION, reason);
    }
  }

  // Spec: docs/specs/10-power-lifecycle.md#2.3
  hasActivePrimaryOrActing(): boolean {
    return this.deps.registry.getPrimaryAuthority() !== null;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  demoteAllStreamingToStandby(streamEpoch: number): void {
    const streaming = this.deps.registry.getStreamingSecondaries();
    if (streaming.length === 0) {
      return;
    }
    const frame = encodeServerControlFrame({
      type: "PRIMARY_SESSION_STATUS",
      active: false,
      streamEpoch,
    });
    for (const session of streaming) {
      this.deps.registry.updateRole(session.id, "SECONDARY_STANDBY");
      this.tokenLastRole.set(session.token, "SECONDARY_STANDBY");
      session.transport.sendBinary(frame);
    }
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.2
  promoteStandbyToStreaming(streamEpoch: number): void {
    const standby = this.deps.registry.getStandbySecondaries();
    if (standby.length === 0) {
      return;
    }
    const frame = encodeServerControlFrame({
      type: "PRIMARY_SESSION_STATUS",
      active: true,
      streamEpoch,
    });
    for (const session of standby) {
      this.deps.registry.updateRole(session.id, "SECONDARY_STREAMING");
      this.tokenLastRole.set(session.token, "SECONDARY_STREAMING");
      session.transport.sendBinary(frame);
    }
  }

  private getStreamEpoch(): number {
    return this.deps.callbacks?.getStreamEpoch?.() ?? STREAM_EPOCH_INITIAL;
  }

  private revokeAndForgetToken(token: string): void {
    this.deps.auth.revokeToken(token);
    this.tokenLastRole.delete(token);
  }

  private promoteFirstStreamingSecondary(): ClientSessionRecord | null {
    const first = this.deps.registry.getStreamingSecondaries()[0];
    if (first === undefined) {
      return null;
    }
    const promoted = this.deps.registry.updateRole(first.id, "ACTING_PRIMARY");
    if (promoted === null) {
      return null;
    }
    this.tokenLastRole.set(promoted.token, "ACTING_PRIMARY");
    promoted.transport.sendBinary(
      encodeServerControlFrame({
        type: "SESSION_ROLE_CHANGED",
        role: "ACTING_PRIMARY",
        streamEpoch: this.getStreamEpoch(),
      }),
    );
    this.deps.callbacks?.onActingPrimaryPromoted?.(promoted);
    return promoted;
  }
}
