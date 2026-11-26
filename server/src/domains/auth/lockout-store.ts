import { AUTH_SECURITY_CONSTANTS, type AuthLockoutStatus } from "@tesroid/shared";
import type { AtomicJsonStore, Clock, ProcessExitPort, TimerHandle } from "../../infra/index.js";
import type { LockoutRecord } from "./ports.js";

export interface LockoutManagerDeps {
  readonly clock: Clock;
  readonly store: AtomicJsonStore;
  readonly filePath: string;
  readonly processExit: ProcessExitPort;
}

const INITIAL_LOCKOUT_RECORD: LockoutRecord = {
  consecutiveFailures: 0,
  isLocked: false,
  lastFailureAt: null,
};

function parseLockoutRecord(raw: unknown): LockoutRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.consecutiveFailures !== "number" ||
    !Number.isInteger(obj.consecutiveFailures) ||
    obj.consecutiveFailures < 0 ||
    typeof obj.isLocked !== "boolean"
  ) {
    return null;
  }
  if (obj.lastFailureAt !== null && typeof obj.lastFailureAt !== "string") {
    return null;
  }
  return {
    consecutiveFailures: obj.consecutiveFailures,
    isLocked: obj.isLocked,
    lastFailureAt: obj.lastFailureAt,
  };
}

export class LockoutManager {
  private readonly deps: LockoutManagerDeps;
  private record: LockoutRecord = { ...INITIAL_LOCKOUT_RECORD };
  private shutdownTimer: TimerHandle | null = null;

  // Spec: docs/specs/01-auth-security.md#2.2
  constructor(deps: LockoutManagerDeps) {
    this.deps = deps;
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  async loadAndAssertUnlocked(): Promise<LockoutRecord> {
    let raw: unknown;
    try {
      raw = await this.deps.store.readJson<unknown>(this.deps.filePath);
    } catch {
      // Fail-closed: treat unreadable or corrupted lockout state as locked.
      this.record = {
        consecutiveFailures: AUTH_SECURITY_CONSTANTS.maxConsecutiveFailures,
        isLocked: true,
        lastFailureAt: null,
      };
      this.deps.processExit.exit(1);
    }

    if (raw === null) {
      this.record = { ...INITIAL_LOCKOUT_RECORD };
      return { ...this.record };
    }

    const parsed = parseLockoutRecord(raw);
    if (parsed === null) {
      this.record = {
        consecutiveFailures: AUTH_SECURITY_CONSTANTS.maxConsecutiveFailures,
        isLocked: true,
        lastFailureAt: null,
      };
      this.deps.processExit.exit(1);
    }

    this.record = parsed;
    if (
      parsed.isLocked ||
      parsed.consecutiveFailures >= AUTH_SECURITY_CONSTANTS.maxConsecutiveFailures
    ) {
      this.deps.processExit.exit(1);
    }

    return { ...this.record };
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  getStatus(): AuthLockoutStatus {
    const max = AUTH_SECURITY_CONSTANTS.maxConsecutiveFailures;
    return {
      consecutiveFailures: this.record.consecutiveFailures,
      isLocked: this.record.isLocked,
      remainingAttempts: Math.max(0, max - this.record.consecutiveFailures),
      lastFailureAt: this.record.lastFailureAt,
    };
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  async recordFailure(): Promise<AuthLockoutStatus> {
    const max = AUTH_SECURITY_CONSTANTS.maxConsecutiveFailures;
    const nextFailures = Math.min(max, this.record.consecutiveFailures + 1);
    const nextRecord: LockoutRecord = {
      consecutiveFailures: nextFailures,
      isLocked: nextFailures >= max,
      lastFailureAt: new Date(this.deps.clock.nowMs()).toISOString(),
    };
    this.record = nextRecord;
    await this.deps.store.writeJsonAtomic(this.deps.filePath, nextRecord);
    return this.getStatus();
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  async reset(): Promise<void> {
    const nextRecord: LockoutRecord = { ...INITIAL_LOCKOUT_RECORD };
    this.record = nextRecord;
    await this.deps.store.writeJsonAtomic(this.deps.filePath, nextRecord);
  }

  // Spec: docs/specs/01-auth-security.md#2.2
  async triggerLockoutShutdown(): Promise<void> {
    if (this.shutdownTimer !== null) {
      return;
    }
    this.shutdownTimer = this.deps.clock.setTimeout(() => {
      this.shutdownTimer = null;
      this.deps.processExit.exit(1);
    }, AUTH_SECURITY_CONSTANTS.lockoutShutdownDelayMs);
  }
}
