import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocketHandler } from '../src/ws/handler.js';
import { MessageMultiplexer } from '../src/ws/multiplexer.js';
import { WSS_CHANNEL, VIDEO_FLAGS, AUDIO_FLAGS } from '../src/ws/protocol.js';
import { ConfigStore } from '../src/config.js';
import { LockoutManager } from '../src/lockout.js';
import { AuthService } from '../src/auth.js';
import { MetricsManager } from '../src/metrics/manager.js';
import { ClientProtocol, TOUCH_EVENT_ACTION } from '../../client/src/transport/protocol.js';
import { WsClient } from '../../client/src/transport/ws-client.js';

class MockEncoder extends EventEmitter {
  private running = true;
  public start = vi.fn(() => {
    this.running = true;
  });
  public stop = vi.fn(() => {
    this.running = false;
  });
  public restart = vi.fn(async () => {});
  public restartAll = vi.fn(async () => {});
  public isRunning = vi.fn(() => this.running);
  public getCachedSpsPps = vi.fn(() => null);
  public getCachedKeyframe = vi.fn(() => null);
  public getCachedOpusHead = vi.fn(() => null);
  public isKeyframeStale = vi.fn(() => false);
  public getCurrentPts = vi.fn(() => 500_000n);
}

class MockSocket extends EventEmitter {
  public readyState = 1;
  public bufferedAmount = 0;
  public sentPackets: Buffer[] = [];
  public send = vi.fn((data: Buffer | Uint8Array) => {
    this.sentPackets.push(Buffer.from(data));
  });
  public close = vi.fn(() => {
    this.readyState = 3;
    this.emit('close');
  });
}

function parseControlMessages(packets: Buffer[]): any[] {
  return packets
    .filter((p) => p[0] === WSS_CHANNEL.CONTROL_RESPONSE)
    .map((p) => JSON.parse(p.subarray(1).toString('utf-8')));
}

function toArrayBuffer(buf: Buffer | Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function sendClientMsg(client: MockSocket, payload: Uint8Array | Buffer): Promise<void> {
  const buf = Buffer.from(payload);
  for (const listener of client.listeners('message')) {
    await (listener as any)(buf, true);
  }
}

describe('WebSocket Binary Protocol Round-Trip, Hysteresis Backpressure & Auto-Sleep', () => {
  let tmpDir: string;
  let configStore: ConfigStore;
  let lockoutManager: LockoutManager;
  let authService: AuthService;
  let mockBrowser: any;
  let mockEncoder: MockEncoder;
  let mockInput: any;
  let wsHandler: WebSocketHandler;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-ws-proto-'));
    configStore = new ConfigStore(tmpDir);
    lockoutManager = new LockoutManager(tmpDir);
    authService = new AuthService(configStore, lockoutManager);
    await authService.setPin('1234');

    mockBrowser = {
      getState: vi.fn(() => 'running'),
      getCurrentUrl: vi.fn(() => 'https://www.youtube.com'),
      getDimensions: vi.fn(() => ({ width: 1280, height: 720 })),
      pause: vi.fn(),
      resume: vi.fn(),
      start: vi.fn(async () => {}),
      resize: vi.fn(async () => true),
      navigate: vi.fn(async () => {}),
      restartChrome: vi.fn(async () => {}),
      typeText: vi.fn(async () => true),
      setDisplayScale: vi.fn(async () => {}),
    };

    mockEncoder = new MockEncoder();
    mockInput = {
      handleTouchEvent: vi.fn(),
      updateDimensions: vi.fn(),
      navigateBack: vi.fn(),
      navigateForward: vi.fn(),
      reloadPage: vi.fn(),
      toggleVideoFullscreen: vi.fn(),
      sendKey: vi.fn(),
    };

    wsHandler = new WebSocketHandler(
      authService,
      mockBrowser,
      mockEncoder as any,
      mockInput,
      configStore
    );
  });

  afterEach(() => {
    wsHandler.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('rejects non-AUTH messages from unauthenticated clients and supports TOKEN:<session> resume', async () => {
    const client = new MockSocket();
    wsHandler.handleConnection(client as any);

    // Attempt touch before authentication -> blocked with AUTH_REQUIRED, inputManager untouched
    await sendClientMsg(client, ClientProtocol.packTouch({
      action: TOUCH_EVENT_ACTION.DOWN,
      pointerId: 1,
      x: 500,
      y: 300,
      screenWidth: 1280,
      screenHeight: 720,
    }));
    expect(mockInput.handleTouchEvent).not.toHaveBeenCalled();
    const preAuthControls = parseControlMessages(client.sentPackets);
    expect(preAuthControls.some((c) => c.type === 'AUTH_REQUIRED')).toBe(true);

    // Authenticate with PIN -> receives session token
    client.sentPackets = [];
    await sendClientMsg(client, ClientProtocol.packAuth('1234'));
    const authControls = parseControlMessages(client.sentPackets);
    const authSuccess = authControls.find((c) => c.type === 'AUTH_SUCCESS');
    expect(authSuccess).toBeDefined();
    expect(typeof authSuccess.token).toBe('string');

    // Second socket authenticates seamlessly via TOKEN:<sessionToken>
    const client2 = new MockSocket();
    wsHandler.handleConnection(client2 as any);
    await sendClientMsg(client2, ClientProtocol.packAuth(`TOKEN:${authSuccess.token}`));
    const auth2Controls = parseControlMessages(client2.sentPackets);
    expect(auth2Controls.some((c) => c.type === 'AUTH_SUCCESS')).toBe(true);
  });

  it('round-trips binary protocol packets between ClientProtocol/WsClient and WebSocketHandler/MessageMultiplexer', async () => {
    const client = new MockSocket();
    wsHandler.handleConnection(client as any);
    await sendClientMsg(client, ClientProtocol.packAuth('1234'));
    client.sentPackets = [];

    // 1. ClientProtocol.packTouch -> WebSocketHandler -> X11InputManager
    const touchPkt = ClientProtocol.packTouch({
      action: TOUCH_EVENT_ACTION.POINTER_DOWN,
      pointerId: 42,
      x: -15, // negative coordinate supported by Int32BE
      y: 719,
      screenWidth: 1920,
      screenHeight: 1080,
      pressure: 0x8000,
    });
    await sendClientMsg(client, touchPkt);
    expect(mockInput.handleTouchEvent).toHaveBeenCalledWith({
      action: TOUCH_EVENT_ACTION.POINTER_DOWN,
      pointerId: 42,
      x: -15,
      y: 719,
      screenWidth: 1920,
      screenHeight: 1080,
    });

    // 2. ClientProtocol.packPing -> WebSocketHandler -> PONG -> WsClient demux
    const pingPkt = ClientProtocol.packPing(77, 12345.6);
    await sendClientMsg(client, pingPkt);

    const wsClient = new WsClient('ws://127.0.0.1:9001/ws');
    const receivedControls: any[] = [];
    const receivedVideos: any[] = [];
    const receivedAudios: any[] = [];
    wsClient.on('control', (m) => receivedControls.push(m));
    wsClient.on('video', (m) => receivedVideos.push(m));
    wsClient.on('audio', (m) => receivedAudios.push(m));

    for (const pkt of client.sentPackets) {
      (wsClient as any).handleMessage(toArrayBuffer(pkt));
    }
    expect(receivedControls).toHaveLength(1);
    expect(receivedControls[0]).toMatchObject({
      type: 'PONG',
      id: 77,
      clientTime: 12345.6,
      latestPts: 500_000,
      serverMode: 'LIVE',
    });

    // 3. Server VIDEO & AUDIO multiplexed frames -> WsClient demux with exact 64-bit PTS & payload
    const videoRaw = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0xaa]);
    const audioRaw = new Uint8Array([0xf8, 0xff, 0xfe, 0x11]);
    const packedVideo = MessageMultiplexer.packVideo(
      VIDEO_FLAGS.KEYFRAME | VIDEO_FLAGS.CONFIG,
      9_876_543_210n,
      Buffer.from(videoRaw)
    );
    const packedAudio = MessageMultiplexer.packAudio(
      AUDIO_FLAGS.KEYFRAME,
      9_876_560_000n,
      Buffer.from(audioRaw)
    );

    (wsClient as any).handleMessage(toArrayBuffer(packedVideo));
    (wsClient as any).handleMessage(toArrayBuffer(packedAudio));

    expect(receivedVideos).toHaveLength(1);
    expect(receivedVideos[0].flags).toBe(VIDEO_FLAGS.KEYFRAME | VIDEO_FLAGS.CONFIG);
    expect(receivedVideos[0].pts).toBe(9_876_543_210n);
    expect(Array.from(receivedVideos[0].data)).toEqual(Array.from(videoRaw));

    expect(receivedAudios).toHaveLength(1);
    expect(receivedAudios[0].flags).toBe(AUDIO_FLAGS.KEYFRAME);
    expect(receivedAudios[0].pts).toBe(9_876_560_000n);
    expect(Array.from(receivedAudios[0].data)).toEqual(Array.from(audioRaw));

    // 4. ClientProtocol.packMetrics -> MetricsManager
    const beforeCount = MetricsManager.getInstance().getHistory(60).length;
    await sendClientMsg(client, ClientProtocol.packMetrics({ renderFps: 59.8, rttMs: 24 }));
    expect(MetricsManager.getInstance().getHistory(60).length).toBeGreaterThanOrEqual(beforeCount);
  });

  it('enforces dual-watermark hysteresis backpressure (never drops on normal IDR burst, recovers only on <=LOW_WATER_MARK + keyframe)', async () => {
    // At 1Mbps default stream bitrate:
    // HIGH_WATER_MARK = max(512KB, min(1536KB, (1_000_000/8)*3)) = 524,288 bytes (512KB)
    // LOW_WATER_MARK  = max(96KB, round(524288 * 0.2))          = 104,858 bytes (~102.4KB)
    const HIGH = 512 * 1024;
    const LOW = Math.round(HIGH * 0.2);

    const client = new MockSocket();
    wsHandler.handleConnection(client as any);
    await sendClientMsg(client, ClientProtocol.packAuth('1234'));
    client.sentPackets = [];

    // 1. Typical 140KB socket burst after sending a 60KB IDR keyframe (< HIGH_WATER_MARK):
    // P-frames MUST NOT be dropped (prevents 2 FPS slideshow bug!)
    client.bufferedAmount = 140 * 1024;
    mockEncoder.emit('video', { flags: 0, pts: 33_000n, data: Buffer.alloc(64) });
    expect(client.sentPackets).toHaveLength(1);

    // 2. Severe congestion (> HIGH_WATER_MARK): enters _droppingGop mode and drops P-frames
    client.sentPackets = [];
    client.bufferedAmount = HIGH + 10_000;
    mockEncoder.emit('video', { flags: 0, pts: 66_000n, data: Buffer.alloc(64) });
    expect(client.sentPackets).toHaveLength(0);

    // 3. Keyframe arrives while bufferedAmount is STILL above LOW_WATER_MARK (e.g. 250KB):
    // MUST still drop so socket can drain cleanly!
    client.bufferedAmount = 250 * 1024;
    mockEncoder.emit('video', { flags: VIDEO_FLAGS.KEYFRAME, pts: 500_000n, data: Buffer.alloc(64) });
    expect(client.sentPackets).toHaveLength(0);

    // 4. Socket drains below LOW_WATER_MARK (e.g. 32KB), but next frame is a delta P-frame:
    // MUST wait for clean IDR keyframe to avoid decoder corruption!
    client.bufferedAmount = LOW - 50_000;
    mockEncoder.emit('video', { flags: 0, pts: 533_000n, data: Buffer.alloc(64) });
    expect(client.sentPackets).toHaveLength(0);

    // 5. Clean IDR keyframe arrives while <= LOW_WATER_MARK -> recovers and resumes P-frames!
    mockEncoder.emit('video', { flags: VIDEO_FLAGS.KEYFRAME, pts: 1_000_000n, data: Buffer.alloc(64) });
    mockEncoder.emit('video', { flags: 0, pts: 1_033_000n, data: Buffer.alloc(64) });
    expect(client.sentPackets).toHaveLength(2);

    // 6. Audio 2MB extreme buffer guard
    client.sentPackets = [];
    client.bufferedAmount = 3 * 1024 * 1024;
    mockEncoder.emit('audio', { flags: AUDIO_FLAGS.KEYFRAME, pts: 1_000_000n, data: Buffer.alloc(32) });
    expect(client.sentPackets).toHaveLength(0);
  });

  it('aligns dynamic RESIZE dimensions to 8-pixel swscaler boundaries (& ~7) after 400ms debounce', async () => {
    vi.useFakeTimers();
    const client = new MockSocket();
    wsHandler.handleConnection(client as any);
    await sendClientMsg(client, ClientProtocol.packAuth('1234'));
    client.sentPackets = [];

    // Request 1453x817 -> width clamped [640..1920] & ~7 = 1448, height [360..1080] & ~1 = 816
    await sendClientMsg(client, ClientProtocol.packResize(1453, 817, 1));
    expect(mockBrowser.resize).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(450);

    expect(mockBrowser.resize).toHaveBeenCalledWith(1448, 816);
    expect(mockEncoder.restart).toHaveBeenCalledWith(1448, 816);
    expect(mockInput.updateDimensions).toHaveBeenCalledWith(1448, 816);

    const controls = parseControlMessages(client.sentPackets);
    expect(controls).toContainEqual({
      type: 'RESOLUTION_CHANGED',
      width: 1448,
      height: 816,
    });
  });

  it('triggers auto-sleep after configured idle timeout and cancels sleep if a client reconnects', async () => {
    vi.useFakeTimers();
    configStore.updateConfig({ autoSleepMinutes: 1 }); // 60,000ms

    const client = new MockSocket();
    wsHandler.handleConnection(client as any);
    await sendClientMsg(client, ClientProtocol.packAuth('1234'));

    // Client disconnects -> 60s auto-sleep timer armed
    client.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockBrowser.pause).not.toHaveBeenCalled();

    // Reconnect before timeout -> cancels sleep!
    const client2 = new MockSocket();
    wsHandler.handleConnection(client2 as any);
    await sendClientMsg(client2, ClientProtocol.packAuth('1234'));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(mockBrowser.pause).not.toHaveBeenCalled();

    // Disconnect again and let full 60s elapse -> encoder stops & Chrome enters SIGSTOP pause!
    client2.close();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(mockEncoder.stop).toHaveBeenCalled();
    expect(mockBrowser.pause).toHaveBeenCalledTimes(1);
  });

  it('handles control commands (NAVIGATE URL scheme check, SET_ZOOM, KEY, TYPE_TEXT, PAUSE/RESUME/RESTART_BROWSER)', async () => {
    const client = new MockSocket();
    wsHandler.handleConnection(client as any);
    await sendClientMsg(client, ClientProtocol.packAuth('1234'));
    client.sentPackets = [];

    // Unsafe file:// NAVIGATE must be blocked before reaching browserManager.navigate
    await sendClientMsg(client, ClientProtocol.packCommand({ type: 'NAVIGATE', url: 'file:///etc/passwd' }));
    expect(mockBrowser.navigate).not.toHaveBeenCalled();
    expect(parseControlMessages(client.sentPackets).some((c) => c.type === 'ERROR')).toBe(true);

    // Valid https:// NAVIGATE succeeds
    await sendClientMsg(client, ClientProtocol.packCommand({ type: 'NAVIGATE', url: 'https://www.netflix.com' }));
    expect(mockBrowser.navigate).toHaveBeenCalledWith('https://www.netflix.com');

    // SET_ZOOM, KEY, TYPE_TEXT, PAUSE_BROWSER, RESUME_BROWSER, RESTART_BROWSER
    await sendClientMsg(client, ClientProtocol.packCommand({ type: 'SET_ZOOM', displayScale: 135 }));
    expect(mockBrowser.setDisplayScale).toHaveBeenCalledWith(135);

    await sendClientMsg(client, ClientProtocol.packCommand({ type: 'KEY', key: 'BackSpace' }));
    expect(mockInput.sendKey).toHaveBeenCalledWith('BackSpace');

    await sendClientMsg(client, ClientProtocol.packCommand({ type: 'TYPE_TEXT', text: 'Tesla', enter: false }));
    expect(mockBrowser.typeText).toHaveBeenCalledWith('Tesla', false);

    await sendClientMsg(client, ClientProtocol.packCommand({ type: 'PAUSE_BROWSER' }));
    expect(mockBrowser.pause).toHaveBeenCalled();

    await sendClientMsg(client, ClientProtocol.packCommand({ type: 'RESUME_BROWSER' }));
    expect(mockBrowser.resume).toHaveBeenCalled();

    await sendClientMsg(client, ClientProtocol.packCommand({ type: 'RESTART_BROWSER' }));
    expect(mockBrowser.restartChrome).toHaveBeenCalled();
  });
});
