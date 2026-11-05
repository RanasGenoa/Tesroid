import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth.js';
import { ConfigStore } from '../src/config.js';
import { LockoutManager } from '../src/lockout.js';
import { registerTelemetryRoutes } from '../src/routes/telemetry.js';
import { TelemetryManager } from '../src/telemetry/manager.js';
import { WebSocketHandler } from '../src/ws/handler.js';
import { WSS_CHANNEL } from '../src/ws/protocol.js';

describe('TelemetryManager, Routes & WS Channel Tests', () => {
  let tmpDir: string;
  let logDir: string;
  let manager: TelemetryManager;
  let app: FastifyInstance;
  let authService: AuthService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-telemetry-test-'));
    logDir = path.join(tmpDir, 'telemetry-logs');
    manager = new TelemetryManager({
      logDir,
      maxSessions: 3,
      maxFileSizeBytes: 1024, // 1KB for size limit test
    });

    const configStore = new ConfigStore(path.join(tmpDir, 'config.json'));
    const lockoutManager = new LockoutManager(tmpDir);
    authService = new AuthService(configStore, lockoutManager);

    app = Fastify();
    registerTelemetryRoutes(app, authService, manager);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    TelemetryManager.resetInstance();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('should perform zero disk I/O until telemetry events actually arrive', async () => {
    expect(fs.existsSync(logDir)).toBe(false);

    const sessionId = manager.createSessionId('lazy');
    expect(sessionId).toMatch(/^lazy-\d+-\d+-\w+$/);
    expect(fs.existsSync(logDir)).toBe(false);

    const sessions = await manager.listSessions();
    expect(sessions).toEqual([]);
    expect(fs.existsSync(logDir)).toBe(false);
  });

  it('should create session, append events into JSONL file, and recover eventCount after restart', async () => {
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

    // Simulate server restart with a fresh TelemetryManager instance pointing at the same logDir
    const restartedManager = new TelemetryManager({
      logDir,
      maxSessions: 3,
      maxFileSizeBytes: 1024,
    });
    const recoveredSessions = await restartedManager.listSessions();
    expect(recoveredSessions.length).toBe(1);
    expect(recoveredSessions[0].eventCount).toBe(2);

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

  it('should strictly enforce maxFileSizeBytes and reject subsequent writes once capped', async () => {
    const sessionId = manager.createSessionId('sizetest');
    const largeData = 'A'.repeat(600);

    // Write first event (~700 bytes <= 1024 bytes)
    await manager.appendEvents(sessionId, [
      { timestamp: 1, type: 'log', event: 'fill1', data: { pad: largeData } },
    ]);

    // Write second event (~700 bytes -> would exceed 1024 bytes, so dropped and session capped)
    await manager.appendEvents(sessionId, [
      { timestamp: 2, type: 'log', event: 'fill2', data: { pad: largeData } },
    ]);

    // Third small write must also be rejected once session is capped
    await manager.appendEvents(sessionId, [
      { timestamp: 3, type: 'log', event: 'fill3', data: { pad: 'should_be_dropped' } },
    ]);

    const filePath = (await manager.getSessionFile(sessionId))!;
    const stat = fs.statSync(filePath);
    expect(stat.size).toBeLessThanOrEqual(1024);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content.includes('fill1')).toBe(true);
    expect(content.includes('fill2')).toBe(false);
    expect(content.includes('should_be_dropped')).toBe(false);
  });

  it('should prune old sessions automatically when creating a new session file beyond maxSessions', async () => {
    const s1 = manager.createSessionId('s1');
    await manager.appendEvents(s1, [{ timestamp: 1, type: 'log', event: 's1' }]);
    await new Promise((r) => setTimeout(r, 15));

    const s2 = manager.createSessionId('s2');
    await manager.appendEvents(s2, [{ timestamp: 2, type: 'log', event: 's2' }]);
    await new Promise((r) => setTimeout(r, 15));

    const s3 = manager.createSessionId('s3');
    await manager.appendEvents(s3, [{ timestamp: 3, type: 'log', event: 's3' }]);
    await new Promise((r) => setTimeout(r, 15));

    let sessions = await manager.listSessions();
    expect(sessions.length).toBe(3);

    // Writing first event for 4th session automatically prunes oldest session (s1)
    const s4 = manager.createSessionId('s4');
    await manager.appendEvents(s4, [{ timestamp: 4, type: 'log', event: 's4' }]);

    sessions = await manager.listSessions();
    expect(sessions.length).toBe(3);
    const sessionIds = sessions.map((s) => s.sessionId);
    expect(sessionIds).toContain(s4);
    expect(sessionIds).not.toContain(s1);
  });

  it('should expose REST API for session listing, specific/latest download, 404s, and deletion', async () => {
    // 1. Unauthenticated request should be rejected (non-localhost IP simulation)
    const unauthRes = await app.inject({
      method: 'GET',
      url: '/api/telemetry/sessions',
      headers: { 'x-forwarded-for': '192.168.1.50' },
      remoteAddress: '192.168.1.50',
    });
    expect(unauthRes.statusCode).toBe(401);

    // Authenticate
    await authService.setPin('1234');
    const authRes = await authService.verifyPin('1234');
    const token = authRes.token;

    // 2. 404 when no sessions exist yet
    const emptyLatestRes = await app.inject({
      method: 'GET',
      url: '/api/telemetry/sessions/latest/download',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(emptyLatestRes.statusCode).toBe(404);

    // 3. Create session & list
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

    // 4. Download latest & specific session, and check 404 for unknown session
    const downloadLatestRes = await app.inject({
      method: 'GET',
      url: '/api/telemetry/sessions/latest/download',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(downloadLatestRes.statusCode).toBe(200);
    expect(downloadLatestRes.headers['content-type']).toContain('application/x-ndjson');
    expect(downloadLatestRes.body).toContain('"type":"pacer"');

    const downloadByIdRes = await app.inject({
      method: 'GET',
      url: `/api/telemetry/sessions/${s1}/download`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(downloadByIdRes.statusCode).toBe(200);
    expect(downloadByIdRes.body).toContain('"event":"stall"');

    const missingByIdRes = await app.inject({
      method: 'GET',
      url: '/api/telemetry/sessions/non-existent-session/download',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(missingByIdRes.statusCode).toBe(404);

    // 5. Delete all sessions
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

  it('should handle WebSocket channel 0x15 lazily and require authentication', async () => {
    const wsTelemetryDir = path.join(tmpDir, 'ws-telemetry');
    process.env.TELEMETRY_LOG_DIR = wsTelemetryDir;
    TelemetryManager.resetInstance();

    const mockAuth: any = {
      verifyPin: vi.fn().mockResolvedValue({ success: true, token: 'mock-token' }),
      validateSession: vi.fn().mockReturnValue(true),
    };
    const mockBrowser: any = {
      getDimensions: () => ({ width: 1280, height: 720 }),
      getState: () => 'running',
      getCurrentUrl: () => 'https://www.youtube.com',
      resume: vi.fn(),
      isChromeAlive: () => true,
    };
    const mockEncoder: any = {
      isRunning: vi.fn(() => true),
      start: vi.fn(),
      stop: vi.fn(),
      getCachedKeyframe: vi.fn(() => null),
      isKeyframeStale: vi.fn(() => false),
      getCachedSpsPps: vi.fn(() => null),
      getCachedOpusHead: vi.fn(() => null),
      on: vi.fn(),
    };
    const mockInput: any = {
      handleTouchEvent: vi.fn(),
      sendKey: vi.fn(),
      navigateBack: vi.fn(),
      updateDimensions: vi.fn(),
    };
    const mockConfig: any = {
      getConfig: () => ({ isSetupCompleted: true, stream: { bitrate: 1000000 } }),
    };

    const handler = new WebSocketHandler(mockAuth, mockBrowser, mockEncoder, mockInput, mockConfig);
    const mockSocket: any = {
      readyState: 1,
      send: vi.fn(),
      on: vi.fn(),
    };

    try {
      handler.handleConnection(mockSocket);
      const messageListener = mockSocket.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

      // Connecting alone (telemetry OFF) must NOT create telemetry directory or session ID
      expect(fs.existsSync(wsTelemetryDir)).toBe(false);
      expect(handler.getClientSession(mockSocket)?.telemetrySessionId).toBeUndefined();

      // Unauthenticated 0x15 telemetry packet must be rejected
      const telemetryBuf = Buffer.concat([
        Buffer.from([WSS_CHANNEL.TELEMETRY]),
        Buffer.from(
          JSON.stringify([
            { timestamp: 500, type: 'av_sync', event: 'large_shift', data: { shift: 220 } },
          ]),
        ),
      ]);
      await messageListener(telemetryBuf);
      expect(fs.existsSync(wsTelemetryDir)).toBe(false);

      // Authenticate and send 0x15 telemetry packet
      const authBuf = Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]);
      await messageListener(authBuf);
      expect(fs.existsSync(wsTelemetryDir)).toBe(false); // Still zero disk I/O when telemetry is OFF

      await messageListener(telemetryBuf);
      // Wait briefly for async appendEvents to finish
      await new Promise((r) => setTimeout(r, 40));

      const sessions = await TelemetryManager.getInstance().listSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0].eventCount).toBe(1);
    } finally {
      handler.close();
      delete process.env.TELEMETRY_LOG_DIR;
      TelemetryManager.resetInstance();
    }
  });
});
