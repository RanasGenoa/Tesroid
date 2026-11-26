import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AUTH_SECURITY_CONSTANTS, DEFAULT_TIMEZONE, MAX_FAVORITES } from "@tesroid/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  CryptoTokenGenerator,
  LockoutManager,
  SessionTokenStore,
} from "../../src/domains/auth/index.js";
import { SettingsDomainError, SettingsService } from "../../src/domains/settings/index.js";
import { NodeAtomicJsonStore } from "../../src/infra/index.js";
import {
  FakeAtomicJsonStore,
  FakeClock,
  FakeProcessExit,
  FakeProcessExitError,
} from "../helpers/fakes.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tesroid-p2-unit-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("Unit: Atomic Storage, Settings, TokenStore & LockoutManager (Spec 01)", () => {
  it("NodeAtomicJsonStore writes atomically without leaving temp files and detects corrupted JSON", async () => {
    const dir = await makeTempDir();
    const store = new NodeAtomicJsonStore();
    const filePath = path.join(dir, "nested", "data.json");

    expect(await store.exists(filePath)).toBe(false);
    expect(await store.readJson(filePath)).toBeNull();

    await store.writeJsonAtomic(filePath, { hello: "world", count: 1 });
    expect(await store.exists(filePath)).toBe(true);
    expect(await store.readJson(filePath)).toEqual({ hello: "world", count: 1 });

    const entries = await fs.readdir(path.dirname(filePath));
    expect(entries).toEqual(["data.json"]);

    await fs.writeFile(filePath, "{broken-json", "utf8");
    await expect(store.readJson(filePath)).rejects.toThrow();

    await store.remove(filePath);
    await store.remove(filePath);
    expect(await store.exists(filePath)).toBe(false);
  });

  it("SettingsService falls back to unconfigured defaults on corrupted JSON and enforces favorite uniqueness & limit", async () => {
    const store = new FakeAtomicJsonStore();
    const filePath = "/data/settings.json";
    store.setRawText(filePath, "{not-valid-json");

    const service = new SettingsService({ store, filePath });
    const loaded = await service.load();
    expect(loaded.isSetupCompleted).toBe(false);
    expect(loaded.pinHash).toBeNull();
    expect(loaded.timezone).toBe(DEFAULT_TIMEZONE);

    await service.completeSetup({ pinHash: "$2a$10$hashvalue", timezone: "Asia/Tokyo" });

    await expect(
      service.updateSettings(
        {
          favorites: [
            { id: "a", title: "A", url: "https://example.com/1", isHome: true },
            { id: "b", title: "B", url: "https://example.com/1", isHome: false },
          ],
        },
        { backend: "vaapi" },
      ),
    ).rejects.toBeInstanceOf(SettingsDomainError);

    const tooMany = Array.from({ length: MAX_FAVORITES + 1 }, (_, i) => ({
      id: `item-${i}`,
      title: `Item ${i}`,
      url: `https://example.com/${i}`,
      isHome: i === 0,
    }));

    await expect(
      service.updateSettings({ favorites: tooMany }, { backend: "vaapi" }),
    ).rejects.toBeInstanceOf(SettingsDomainError);
  });

  it("SessionTokenStore issues 64-hex tokens, enforces 24h TTL, sweeps every 10 minutes, and revokes all", () => {
    const clock = new FakeClock(1_700_000_000_000);
    const tokenStore = new SessionTokenStore({
      clock,
      tokenGenerator: new CryptoTokenGenerator(),
    });
    tokenStore.startSweep();

    const record = tokenStore.issue("PRIMARY");
    expect(record.token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenStore.verify(record.token)).not.toBeNull();

    clock.advanceByMs(AUTH_SECURITY_CONSTANTS.tokenTtlMs - 1);
    expect(tokenStore.verify(record.token)).not.toBeNull();

    clock.advanceByMs(1);
    expect(tokenStore.verify(record.token)).toBeNull();

    const t2 = tokenStore.issue("PRIMARY");
    clock.advanceByMs(
      AUTH_SECURITY_CONSTANTS.tokenTtlMs + AUTH_SECURITY_CONSTANTS.tokenSweepIntervalMs,
    );
    expect(tokenStore.verify(t2.token)).toBeNull();

    const t3 = tokenStore.issue("SECONDARY_STREAMING");
    tokenStore.revokeAll();
    expect(tokenStore.verify(t3.token)).toBeNull();

    tokenStore.stopSweep();
  });

  it("LockoutManager persists each failure, exits(1) at startup when locked or corrupted, and exits(1) after 200ms", async () => {
    const dir = await makeTempDir();
    const store = new NodeAtomicJsonStore();
    const filePath = path.join(dir, "lockout.json");
    const clock = new FakeClock(1_700_000_000_000);
    const processExit = new FakeProcessExit();

    const manager = new LockoutManager({ clock, store, filePath, processExit });
    await manager.loadAndAssertUnlocked();

    for (let i = 1; i <= 9; i += 1) {
      const status = await manager.recordFailure();
      expect(status.consecutiveFailures).toBe(i);
      expect(status.isLocked).toBe(false);
      expect(status.remainingAttempts).toBe(10 - i);
    }

    const tenth = await manager.recordFailure();
    expect(tenth.isLocked).toBe(true);
    expect(tenth.remainingAttempts).toBe(0);

    await manager.triggerLockoutShutdown();
    expect(processExit.exitCodes).toEqual([]);
    expect(() => clock.advanceByMs(AUTH_SECURITY_CONSTANTS.lockoutShutdownDelayMs)).toThrow(
      FakeProcessExitError,
    );
    expect(processExit.exitCodes).toEqual([1]);

    const restartedExit = new FakeProcessExit();
    const restarted = new LockoutManager({
      clock,
      store,
      filePath,
      processExit: restartedExit,
    });
    await expect(restarted.loadAndAssertUnlocked()).rejects.toThrow(FakeProcessExitError);
    expect(restartedExit.exitCodes).toEqual([1]);

    await fs.writeFile(filePath, "{corrupt", "utf8");
    const corruptExit = new FakeProcessExit();
    const corruptManager = new LockoutManager({
      clock,
      store,
      filePath,
      processExit: corruptExit,
    });
    await expect(corruptManager.loadAndAssertUnlocked()).rejects.toThrow(FakeProcessExitError);
    expect(corruptExit.exitCodes).toEqual([1]);
  });
});
