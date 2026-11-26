import type { AuthLockoutStatus } from "@tesroid/shared";
import type { AtomicJsonStore, Clock, ProcessExitPort } from "../../infra/index.js";
import type { LockoutRecord } from "./ports.js";

export interface LockoutManagerDeps {
  readonly clock: Clock;
  readonly store: AtomicJsonStore;
  readonly filePath: string;
  readonly processExit: ProcessExitPort;
}

export class LockoutManager {
  // Spec: docs/specs/01-auth-security.md#2.2
  constructor(deps: LockoutManagerDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  loadAndAssertUnlocked(): Promise<LockoutRecord> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  getStatus(): AuthLockoutStatus {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  recordFailure(): Promise<AuthLockoutStatus> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  reset(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  triggerLockoutShutdown(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
}
