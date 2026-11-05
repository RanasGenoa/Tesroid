import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { ConfigStore } from './config.js';
import type { LockoutManager } from './lockout.js';

export interface AuthSession {
  token: string;
  createdAt: number;
  expiresAt: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class AuthService {
  private configStore: ConfigStore;
  private lockoutManager: LockoutManager;
  private sessions: Map<string, AuthSession> = new Map();

  constructor(configStore: ConfigStore, lockoutManager: LockoutManager) {
    this.configStore = configStore;
    this.lockoutManager = lockoutManager;

    // Periodic cleanup of expired sessions every 10 minutes
    setInterval(() => this.cleanupExpiredSessions(), 10 * 60 * 1000).unref();
  }

  public async setPin(pin: string): Promise<void> {
    if (!pin || pin.length < 4 || pin.length > 8) {
      throw new Error('PIN must be between 4 and 8 characters/digits long.');
    }
    const salt = await bcrypt.genSalt(10);
    const pinHash = await bcrypt.hash(pin, salt);
    this.configStore.updateConfig({
      pinHash,
      isSetupCompleted: true,
    });
    this.lockoutManager.recordSuccess();
  }

  public async verifyPin(
    pin: string,
  ): Promise<{ success: boolean; token?: string; remainingAttempts: number }> {
    const config = this.configStore.getConfig();
    if (!config.isSetupCompleted || !config.pinHash) {
      return { success: false, remainingAttempts: this.lockoutManager.getRemainingAttempts() };
    }

    const isValid = await bcrypt.compare(pin, config.pinHash);
    if (!isValid) {
      this.lockoutManager.recordFailure();
      return {
        success: false,
        remainingAttempts: this.lockoutManager.getRemainingAttempts(),
      };
    }

    this.lockoutManager.recordSuccess();
    const session = this.createSession();
    return {
      success: true,
      token: session.token,
      remainingAttempts: this.lockoutManager.getRemainingAttempts(),
    };
  }

  public validateSession(token: string | undefined): boolean {
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;

    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  public revokeSession(token: string): void {
    this.sessions.delete(token);
  }

  private createSession(): AuthSession {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const session: AuthSession = {
      token,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.sessions.set(token, session);
    return session;
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(token);
      }
    }
  }
}
