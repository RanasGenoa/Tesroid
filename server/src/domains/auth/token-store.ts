import type { SessionRole } from "@tesroid/shared";
import type { Clock } from "../../infra/index.js";
import type { TokenGenerator, TokenRecord } from "./ports.js";

export interface SessionTokenStoreDeps {
  readonly clock: Clock;
  readonly tokenGenerator: TokenGenerator;
}

export class SessionTokenStore {
  // Spec: docs/specs/01-auth-security.md#2.1
  constructor(deps: SessionTokenStoreDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  issue(role: SessionRole): TokenRecord {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  verify(token: string): TokenRecord | null {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  revoke(token: string): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  revokeAll(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  sweepExpired(): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  startSweep(): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  stopSweep(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
