import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConfigStore } from '../src/config.js';
import { LockoutManager } from '../src/lockout.js';
import { AuthService } from '../src/auth.js';

describe('AuthService & LockoutManager', () => {
  let tmpDir: string;
  let configStore: ConfigStore;
  let lockoutManager: LockoutManager;
  let authService: AuthService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-test-'));
    configStore = new ConfigStore(tmpDir);
    lockoutManager = new LockoutManager(tmpDir);
    authService = new AuthService(configStore, lockoutManager);
  });

  it('should initialize with setup incomplete', () => {
    expect(configStore.isSetupCompleted()).toBe(false);
  });

  it('should set and verify PIN successfully', async () => {
    await authService.setPin('1234');
    expect(configStore.isSetupCompleted()).toBe(true);

    const res = await authService.verifyPin('1234');
    expect(res.success).toBe(true);
    expect(res.token).toBeDefined();
    expect(authService.validateSession(res.token)).toBe(true);
  });

  it('should reject invalid PIN and decrement remaining attempts', async () => {
    await authService.setPin('1234');

    const res = await authService.verifyPin('9999');
    expect(res.success).toBe(false);
    expect(res.remainingAttempts).toBe(9);
    expect(lockoutManager.getConsecutiveFailures()).toBe(1);
  });

  it('should reset failure counter on successful PIN verification', async () => {
    await authService.setPin('1234');

    await authService.verifyPin('0000');
    await authService.verifyPin('0000');
    expect(lockoutManager.getConsecutiveFailures()).toBe(2);

    const okRes = await authService.verifyPin('1234');
    expect(okRes.success).toBe(true);
    expect(lockoutManager.getConsecutiveFailures()).toBe(0);
    expect(lockoutManager.getRemainingAttempts()).toBe(10);
  });

  it('should trigger fatal exit on 10 consecutive failed attempts', async () => {
    await authService.setPin('1234');

    // Mock process.exit
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    for (let i = 1; i <= 9; i++) {
      const r = await authService.verifyPin('wrong');
      expect(r.success).toBe(false);
      expect(lockoutManager.getConsecutiveFailures()).toBe(i);
    }

    // 10th failure should trigger lockout
    const finalRes = await authService.verifyPin('wrong');
    expect(finalRes.success).toBe(false);
    expect(lockoutManager.getConsecutiveFailures()).toBe(10);

    // Wait for setTimeout in recordFailure
    await new Promise((r) => setTimeout(r, 300));
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
