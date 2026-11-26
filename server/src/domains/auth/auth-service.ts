import type { AuthLockoutStatus, SessionRole } from "@tesroid/shared";
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
  // Spec: docs/specs/01-auth-security.md#2.1
  constructor(deps: AuthServiceDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  assertNotLockedAtStartup(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  getLockoutStatus(): AuthLockoutStatus {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  verifyPin(
    pin: string,
    role?: Extract<SessionRole, "PRIMARY" | "SECONDARY_STREAMING">,
  ): Promise<PinVerifyResult> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  verifyToken(token: string): TokenRecord | null {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  issueToken(role: SessionRole): TokenRecord {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  revokeToken(token: string): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  revokeAllTokens(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  resetLockout(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  startTokenSweep(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  stopTokenSweep(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
