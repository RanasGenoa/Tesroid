import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConfigStore } from '../src/config.js';
import { LockoutManager } from '../src/lockout.js';
import { AuthService } from '../src/auth.js';

describe('AuthService, ConfigStore & LockoutManager', () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('should initialize with setup incomplete and reject verifyPin prior to setup', async () => {
    expect(configStore.isSetupCompleted()).toBe(false);
    const res = await authService.verifyPin('1234');
    expect(res.success).toBe(false);
    expect(res.remainingAttempts).toBe(10);
  });

  it('should enforce PIN length bounds (4 to 8 chars) in setPin', async () => {
    await expect(authService.setPin('')).rejects.toThrow();
    await expect(authService.setPin('123')).rejects.toThrow();
    await expect(authService.setPin('123456789')).rejects.toThrow();
  });

  it('should set and verify PIN, expire sessions after 24h TTL, and support revokeSession', async () => {
    await authService.setPin('1234');
    expect(configStore.isSetupCompleted()).toBe(true);

    const res = await authService.verifyPin('1234');
    expect(res.success).toBe(true);
    expect(res.token).toBeDefined();
    expect(authService.validateSession(res.token)).toBe(true);
    expect(authService.validateSession(undefined)).toBe(false);
    expect(authService.validateSession('forged-token')).toBe(false);

    // Advance Date.now beyond 24h TTL -> session invalidated
    const baseNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow + 25 * 60 * 60 * 1000);
    expect(authService.validateSession(res.token)).toBe(false);
    nowSpy.mockRestore();

    // Explicit revokeSession
    const res2 = await authService.verifyPin('1234');
    expect(authService.validateSession(res2.token)).toBe(true);
    authService.revokeSession(res2.token!);
    expect(authService.validateSession(res2.token)).toBe(false);
  });

  it('should reject invalid PIN, decrement attempts, and reset counter on valid PIN', async () => {
    await authService.setPin('1234');

    const r1 = await authService.verifyPin('9999');
    expect(r1.success).toBe(false);
    expect(r1.remainingAttempts).toBe(9);
    expect(lockoutManager.getConsecutiveFailures()).toBe(1);

    await authService.verifyPin('0000');
    expect(lockoutManager.getConsecutiveFailures()).toBe(2);

    const okRes = await authService.verifyPin('1234');
    expect(okRes.success).toBe(true);
    expect(lockoutManager.getConsecutiveFailures()).toBe(0);
    expect(lockoutManager.getRemainingAttempts()).toBe(10);
  });

  it('should trigger fatal exit on 10 consecutive failed attempts and persist lockout across restarts', async () => {
    await authService.setPin('1234');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    for (let i = 1; i <= 9; i++) {
      const r = await authService.verifyPin('wrong');
      expect(r.success).toBe(false);
      expect(lockoutManager.getConsecutiveFailures()).toBe(i);
    }

    const finalRes = await authService.verifyPin('wrong');
    expect(finalRes.success).toBe(false);
    expect(lockoutManager.getConsecutiveFailures()).toBe(10);

    await new Promise((r) => setTimeout(r, 260));
    expect(exitSpy).toHaveBeenCalledWith(1);

    // Reboot simulation: constructing a new LockoutManager on locked lockout.json must immediately exit(1)
    exitSpy.mockClear();
    new LockoutManager(tmpDir);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should migrate legacy displayScale=85 to 120 unless customized, and recover from corrupted JSON', () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-legacy-'));
    try {
      // 1. Legacy uncustomized displayScale=85 -> migrated to 120
      fs.writeFileSync(
        path.join(legacyDir, 'config.json'),
        JSON.stringify({ isSetupCompleted: true, displayScale: 85 }),
        'utf-8'
      );
      const store1 = new ConfigStore(legacyDir);
      expect(store1.getConfig().displayScale).toBe(120);

      // 2. Explicitly customized displayScale=85 with displayScaleUserSet=true -> preserved as 85
      fs.writeFileSync(
        path.join(legacyDir, 'config.json'),
        JSON.stringify({ isSetupCompleted: true, displayScale: 85, displayScaleUserSet: true }),
        'utf-8'
      );
      const store2 = new ConfigStore(legacyDir);
      expect(store2.getConfig().displayScale).toBe(85);

      // 3. Corrupted JSON -> falls back safely to defaults without crashing
      fs.writeFileSync(path.join(legacyDir, 'config.json'), '{broken-json', 'utf-8');
      fs.writeFileSync(path.join(legacyDir, 'lockout.json'), '{broken-lockout', 'utf-8');
      const store3 = new ConfigStore(legacyDir);
      const lockout3 = new LockoutManager(legacyDir);
      expect(store3.getConfig().displayScale).toBe(120);
      expect(lockout3.getConsecutiveFailures()).toBe(0);
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
