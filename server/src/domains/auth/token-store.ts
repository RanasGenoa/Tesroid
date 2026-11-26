import { AUTH_SECURITY_CONSTANTS, type SessionRole } from "@tesroid/shared";
import type { Clock, TimerHandle } from "../../infra/index.js";
import type { TokenGenerator, TokenRecord } from "./ports.js";

export interface SessionTokenStoreDeps {
  readonly clock: Clock;
  readonly tokenGenerator: TokenGenerator;
}

export class SessionTokenStore {
  private readonly deps: SessionTokenStoreDeps;
  private readonly tokens = new Map<string, TokenRecord>();
  private sweepTimer: TimerHandle | null = null;

  // Spec: docs/specs/01-auth-security.md#2.1
  constructor(deps: SessionTokenStoreDeps) {
    this.deps = deps;
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  issue(role: SessionRole): TokenRecord {
    const token = this.deps.tokenGenerator.generateHexToken(AUTH_SECURITY_CONSTANTS.tokenBytes);
    const issuedAtMs = this.deps.clock.nowMs();
    const record: TokenRecord = {
      token,
      role,
      issuedAtMs,
      expiresAtMs: issuedAtMs + AUTH_SECURITY_CONSTANTS.tokenTtlMs,
    };
    this.tokens.set(token, record);
    return record;
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  verify(token: string): TokenRecord | null {
    const record = this.tokens.get(token);
    if (record === undefined) {
      return null;
    }
    if (this.deps.clock.nowMs() >= record.expiresAtMs) {
      this.tokens.delete(token);
      return null;
    }
    return record;
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  revoke(token: string): void {
    this.tokens.delete(token);
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  revokeAll(): void {
    this.tokens.clear();
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  sweepExpired(): number {
    const nowMs = this.deps.clock.nowMs();
    let removed = 0;
    for (const [token, record] of this.tokens) {
      if (nowMs >= record.expiresAtMs) {
        this.tokens.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  startSweep(): void {
    if (this.sweepTimer !== null) {
      return;
    }
    this.sweepTimer = this.deps.clock.setInterval(() => {
      this.sweepExpired();
    }, AUTH_SECURITY_CONSTANTS.tokenSweepIntervalMs);
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  stopSweep(): void {
    if (this.sweepTimer !== null) {
      this.deps.clock.clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
