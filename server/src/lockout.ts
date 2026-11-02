import fs from 'node:fs';
import path from 'node:path';

export interface LockoutState {
  consecutiveFailures: number;
  lastFailureTimestamp: number;
  isLocked: boolean;
}

const MAX_FAILED_ATTEMPTS = 10;

export class LockoutManager {
  private dataDir: string;
  private lockoutFilePath: string;
  private state: LockoutState;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.lockoutFilePath = path.join(this.dataDir, 'lockout.json');
    this.state = this.loadState();

    // If the system was already locked prior to restart, shut down immediately
    if (this.state.isLocked || this.state.consecutiveFailures >= MAX_FAILED_ATTEMPTS) {
      console.error(
        '[CRITICAL SECURITY ALERT] System is locked due to 10 consecutive failed PIN attempts in previous run.\n' +
        'To unlock, delete /data/lockout.json or restart the container after resetting the file.'
      );
      process.exit(1);
    }
  }

  public getConsecutiveFailures(): number {
    return this.state.consecutiveFailures;
  }

  public getRemainingAttempts(): number {
    return Math.max(0, MAX_FAILED_ATTEMPTS - this.state.consecutiveFailures);
  }

  public recordSuccess(): void {
    if (this.state.consecutiveFailures > 0) {
      this.state = {
        consecutiveFailures: 0,
        lastFailureTimestamp: 0,
        isLocked: false,
      };
      this.saveState();
      console.log('[LockoutManager] PIN verified successfully. Failure counter reset to 0.');
    }
  }

  public recordFailure(): void {
    this.state.consecutiveFailures += 1;
    this.state.lastFailureTimestamp = Date.now();

    console.warn(
      `[SECURITY WARNING] Invalid PIN attempt recorded. ` +
      `Failed: ${this.state.consecutiveFailures}/${MAX_FAILED_ATTEMPTS}. ` +
      `Remaining attempts: ${this.getRemainingAttempts()}`
    );

    if (this.state.consecutiveFailures >= MAX_FAILED_ATTEMPTS) {
      this.state.isLocked = true;
      this.saveState();

      console.error(
        '\n=========================================================================\n' +
        '[FATAL SECURITY LOCKOUT] 10 consecutive failed PIN attempts detected!\n' +
        'Terminating Tesroid Server immediately to defend against brute-force attacks.\n' +
        'The container will stop and require manual intervention from the administrator.\n' +
        '=========================================================================\n'
      );

      // Force flush logs and terminate process
      setTimeout(() => {
        process.exit(1);
      }, 200);
    } else {
      this.saveState();
    }
  }

  private loadState(): LockoutState {
    try {
      if (fs.existsSync(this.lockoutFilePath)) {
        const raw = fs.readFileSync(this.lockoutFilePath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.error('[LockoutManager] Error reading lockout.json:', err);
    }
    return {
      consecutiveFailures: 0,
      lastFailureTimestamp: 0,
      isLocked: false,
    };
  }

  private saveState(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      fs.writeFileSync(this.lockoutFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      console.error('[LockoutManager] Error saving lockout.json:', err);
    }
  }
}
