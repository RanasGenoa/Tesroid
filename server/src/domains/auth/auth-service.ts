import {
  AUTH_SECURITY_CONSTANTS,
  type AuthLockoutStatus,
  isValidPin,
  type SessionRole,
} from "@tesroid/shared";
import type { Clock } from "../../infra/index.js";
import type { SettingsRepository } from "../settings/ports.js";
import type { LockoutManager } from "./lockout-store.js";
import type {
  AuthServicePort,
  LockoutShutdownHandler,
  PasswordHasher,
  PinVerifyResult,
  TokenRecord,
} from "./ports.js";
import type { SessionTokenStore } from "./token-store.js";

export interface AuthServiceDeps {
  readonly clock: Clock;
  readonly settings: SettingsRepository;
  readonly passwordHasher: PasswordHasher;
  readonly tokenStore: SessionTokenStore;
  readonly lockout: LockoutManager;
  readonly shutdownHandler?: LockoutShutdownHandler;
}

export class AuthService implements AuthServicePort {
  private readonly deps: AuthServiceDeps;

  // Spec: docs/specs/01-auth-security.md#2.1
  constructor(deps: AuthServiceDeps) {
    this.deps = deps;
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  async assertNotLockedAtStartup(): Promise<void> {
    await this.deps.lockout.loadAndAssertUnlocked();
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  getLockoutStatus(): AuthLockoutStatus {
    return this.deps.lockout.getStatus();
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  hashPin(pin: string): Promise<string> {
    return this.deps.passwordHasher.hash(pin, AUTH_SECURITY_CONSTANTS.bcryptCost);
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  async verifyPin(
    pin: string,
    role: Extract<SessionRole, "PRIMARY" | "SECONDARY_STREAMING"> = "PRIMARY",
  ): Promise<PinVerifyResult> {
    const currentLockout = this.deps.lockout.getStatus();
    if (currentLockout.isLocked) {
      return {
        ok: false,
        reason: "LOCKED",
        statusCode: 403,
        remainingAttempts: 0,
      };
    }

    if (typeof pin !== "string" || pin.length === 0) {
      return {
        ok: false,
        reason: "EMPTY_PIN",
        statusCode: 400,
        remainingAttempts: currentLockout.remainingAttempts,
      };
    }

    const currentSettings = this.deps.settings.getCurrent();
    if (!currentSettings.isSetupCompleted || currentSettings.pinHash === null) {
      return {
        ok: false,
        reason: "NOT_SETUP",
        statusCode: 401,
        remainingAttempts: currentLockout.remainingAttempts,
      };
    }

    const matched =
      isValidPin(pin) && (await this.deps.passwordHasher.verify(pin, currentSettings.pinHash));
    if (!matched) {
      const nextStatus = await this.deps.lockout.recordFailure();
      if (nextStatus.isLocked) {
        if (this.deps.shutdownHandler !== undefined) {
          await this.deps.shutdownHandler.onLockoutTriggered();
        }
        await this.deps.lockout.triggerLockoutShutdown();
        return {
          ok: false,
          reason: "LOCKED",
          statusCode: 403,
          remainingAttempts: 0,
        };
      }
      return {
        ok: false,
        reason: "INVALID_PIN",
        statusCode: 401,
        remainingAttempts: nextStatus.remainingAttempts,
      };
    }

    await this.deps.lockout.reset();
    const tokenRecord = this.deps.tokenStore.issue(role);
    return {
      ok: true,
      token: tokenRecord.token,
      role: tokenRecord.role,
    };
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  verifyToken(token: string): TokenRecord | null {
    return this.deps.tokenStore.verify(token);
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  issueToken(role: SessionRole): TokenRecord {
    return this.deps.tokenStore.issue(role);
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  revokeToken(token: string): void {
    this.deps.tokenStore.revoke(token);
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  revokeAllTokens(): void {
    this.deps.tokenStore.revokeAll();
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  async resetLockout(): Promise<void> {
    await this.deps.lockout.reset();
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  startTokenSweep(): void {
    this.deps.tokenStore.startSweep();
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  stopTokenSweep(): void {
    this.deps.tokenStore.stopSweep();
  }
}
