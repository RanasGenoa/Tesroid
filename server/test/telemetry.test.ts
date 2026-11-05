import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify, { FastifyInstance } from 'fastify';
import { TelemetryManager } from '../src/telemetry/manager.js';
import { registerTelemetryRoutes } from '../src/routes/telemetry.js';
import { AuthService } from '../src/auth.js';
import { ConfigStore } from '../src/config.js';
import { LockoutManager } from '../src/lockout.js';

describe('TelemetryManager & Routes Tests', () => {
  let tmpDir: string;
  let manager: TelemetryManager;
  let app: FastifyInstance;
  let authService: AuthService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-telemetry-test-'));
    manager = new TelemetryManager({
      logDir: tmpDir,
      maxSessions: 3,
      maxFileSizeBytes: 1024, // 1KB for size limit test
    });

    const configStore = new ConfigStore(path.join(tmpDir, 'config.json'));
    const lockoutManager = new LockoutManager(tmpDir);
    authService = new AuthService(configStore, lockoutManager);

    app = Fastify();
    // Register telemetry routes using our manager instance
    registerTelemetryRoutes(app, authService, manager);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    manager.closeAllStreams();
    TelemetryManager.resetInstance();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('should create session and append events into JSONL file', async () => {
    const sessionId = manager.createSessionId('test');
    expect(sessionId).toMatch(/^test-\d+-\d+-\w+$/);

    await manager.appendEvents(sessionId, [
      {
        timestamp: 1000,
        type: 'av_sync',
        event: 'large_shift',
        data: { syncErrorMs: 200 },
      },
      {
        timestamp: 2000,
        type: 'buffering',
        event: 'enter',
        data: { queueLength: 4 },
      },
    ]);

    const sessions = await manager.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe(sessionId);
    expect(sessions[0].eventCount).toBe(2);

    const filePath = await manager.getSessionFile(sessionId);
    expect(filePath).not.toBeNull();
    const content = fs.readFileSync(filePath!, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]);
    expect(first.type).toBe('av_sync');
    expect(first.event).toBe('large_shift');
    expect(first.sessionId).toBe(sessionId);
    expect(first.serverTimestamp).toBeDefined();
  });

  it('should enforce max file size limit to protect disk space', async () => {
    const sessionId = manager.createSessionId('sizetest');
    const largeData = 'A'.repeat(600);

    // Write first event (~650 bytes)
    await manager.appendEvents(sessionId, [
      { timestamp: 1, type: 'log', event: 'fill1', data: { pad: largeData } },
    ]);

    // Write second event (~650 bytes -> total ~1300 bytes > 1024 bytes)
    await manager.appendEvents(sessionId, [
      { timestamp: 2, type: 'log', event: 'fill2', data: { pad: largeData } },
    ]);

    // Third write should be rejected due to size limit
    await manager.appendEvents(sessionId, [
      { timestamp: 3, type: 'log', event: 'fill3', data: { pad: 'should_be_dropped' } },
    ]);

    const filePath = (await manager.getSessionFile(sessionId))!;
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content.includes('should_be_dropped')).toBe(false);
  });

  it('should prune old sessions when exceeding maxSessions', async () => {
    const s1 = manager.createSessionId('s1');
    await manager.appendEvents(s1, [{ timestamp: 1, type: 'log', event: 's1' }]);
    // Small sleep to ensure differing mtimes
    await new Promise((r) => setTimeout(r, 10));

    const s2 = manager.createSessionId('s2');
    await manager.appendEvents(s2, [{ timestamp: 2, type: 'log', event: 's2' }]);
    await new Promise((r) => setTimeout(r, 10));

    const s3 = manager.createSessionId('s3');
    await manager.appendEvents(s3, [{ timestamp: 3, type: 'log', event: 's3' }]);
    await new Promise((r) => setTimeout(r, 10));

    let sessions = await manager.listSessions();
    expect(sessions.length).toBe(3);

    // Create 4th session -> triggers prune to max 3
    const s4 = manager.createSessionId('s4');
    await manager.appendEvents(s4, [{ timestamp: 4, type: 'log', event: 's4' }]);
    await manager.pruneOldSessions();

    sessions = await manager.listSessions();
    expect(sessions.length).toBe(3);
    const sessionIds = sessions.map((s) => s.sessionId);
    expect(sessionIds).toContain(s4);
    expect(sessionIds).not.toContain(s1); // Oldest session s1 pruned
  });

  it('should expose REST API for session listing, download, and deletion', async () => {
    // 1. Unauthenticated request should be rejected (non-localhost IP simulation)
    const unauthRes = await app.inject({
      method: 'GET',
      url: '/api/telemetry/sessions',
      headers: {
        'x-forwarded-for': '192.168.1.50',
      },
      remoteAddress: '192.168.1.50',
    });
    expect(unauthRes.statusCode).toBe(401);

    // Authenticate
    await authService.setPin('1234');
    const authRes = await authService.verifyPin('1234');
    const token = authRes.token;

    // 2. List sessions
    const s1 = manager.createSessionId('api-test');
    await manager.appendEvents(s1, [{ timestamp: 100, type: 'pacer', event: 'stall' }]);

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/telemetry/sessions',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.body);
    expect(listBody.count).toBe(1);
    expect(listBody.sessions[0].sessionId).toBe(s1);

    // 3. Download latest session
    const downloadRes = await app.inject({
      method: 'GET',
      url: '/api/telemetry/sessions/latest/download',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(downloadRes.statusCode).toBe(200);
    expect(downloadRes.headers['content-type']).toContain('application/x-ndjson');
    expect(downloadRes.body).toContain('"type":"pacer"');

    // 4. Delete all sessions
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/api/telemetry/sessions',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(JSON.parse(deleteRes.body).success).toBe(true);

    const postDeleteList = await manager.listSessions();
    expect(postDeleteList.length).toBe(0);
  });
});
