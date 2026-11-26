import type { AuthLockoutStatus, SessionRole } from "@tesroid/shared";

export interface PasswordHasher {
  hash(pin: string, cost: number): Promise<string>;
  verify(pin: string, hash: string): Promise<boolean>;
}

export interface TokenGenerator {
  generateHexToken(byteLength: number): string;
}

export interface LockoutShutdownHandler {
  onLockoutTriggered(): Promise<void>;
}

export interface LockoutRecord {
  readonly consecutiveFailures: number;
  readonly isLocked: boolean;
  readonly lastFailureAt: string | null;
}

export interface TokenRecord {
  readonly token: string;
  readonly role: SessionRole;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export type PinVerifyResult =
  | { readonly ok: true; readonly token: string; readonly role: SessionRole }
  | {
      readonly ok: false;
      readonly reason: "NOT_SETUP" | "EMPTY_PIN" | "INVALID_PIN" | "LOCKED";
      readonly statusCode: 400 | 401 | 403;
      readonly remainingAttempts: number;
    };

export interface AuthServicePort {
  assertNotLockedAtStartup(): Promise<void>;
  getLockoutStatus(): AuthLockoutStatus;
  verifyPin(
    pin: string,
    role?: Extract<SessionRole, "PRIMARY" | "SECONDARY_STREAMING">,
  ): Promise<PinVerifyResult>;
  verifyToken(token: string): TokenRecord | null;
  issueToken(role: SessionRole): TokenRecord;
  revokeToken(token: string): void;
  revokeAllTokens(): void;
  resetLockout(): Promise<void>;
  startTokenSweep(): void;
  stopTokenSweep(): void;
}
