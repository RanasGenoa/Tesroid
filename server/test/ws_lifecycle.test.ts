import { describe, expect, it, vi } from 'vitest';
import { WebSocketHandler } from '../src/ws/handler.js';
import { WSS_CHANNEL } from '../src/ws/protocol.js';

describe('WebSocketHandler Idle & Metrics Lifecycle', () => {
  it('should resume encoder on client authentication and stop on auto-sleep', async () => {
    const mockAuth: any = {
      verifyPin: vi.fn().mockResolvedValue({ success: true, token: 'mock-token' }),
    };

    const mockBrowser: any = {
      getDimensions: () => ({ width: 1280, height: 720 }),
      getState: () => 'paused',
      getCurrentUrl: () => 'https://www.youtube.com',
      resume: vi.fn(),
      pause: vi.fn(),
      start: vi.fn(),
      isChromeAlive: () => true,
    };

    let encoderRunning = false;
    const mockEncoder: any = {
      isRunning: vi.fn(() => encoderRunning),
      start: vi.fn(() => {
        encoderRunning = true;
      }),
      stop: vi.fn(() => {
        encoderRunning = false;
      }),
      getCachedKeyframe: () => null,
      getCachedSpsPps: () => null,
      getCachedOpusHead: () => null,
      on: vi.fn(),
    };

    const mockInput: any = {};
    const mockConfig: any = {
      getConfig: () => ({ isSetupCompleted: true }),
    };

    const handler = new WebSocketHandler(mockAuth, mockBrowser, mockEncoder, mockInput, mockConfig);

    const mockSocket: any = {
      readyState: 1,
      send: vi.fn(),
      on: vi.fn(),
    };

    // Simulate connection
    handler.handleConnection(mockSocket);

    // Find message listener
    const messageListener = mockSocket.on.mock.calls.find(
      (call: any[]) => call[0] === 'message',
    )?.[1];
    expect(messageListener).toBeDefined();

    // Send valid auth PIN
    const authBuf = Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]);
    await messageListener(authBuf);

    // Verify browser resumed and encoder started
    expect(mockBrowser.resume).toHaveBeenCalled();
    expect(mockEncoder.start).toHaveBeenCalled();
    expect(encoderRunning).toBe(true);

    // Now test sending METRICS
    const metricsPayload = {
      renderFps: 30,
      minFps: 29,
      maxFps: 30,
      rttMs: 40,
      bitrateKbps: 500,
      droppedFrames: 0,
      decoderErrors: 0,
      avDriftMs: 2,
    };
    const metricsBuf = Buffer.concat([
      Buffer.from([WSS_CHANNEL.METRICS]),
      Buffer.from(JSON.stringify(metricsPayload)),
    ]);
    messageListener(metricsBuf);

    // Cleanup
    handler.close();
    expect(mockEncoder.stop).toHaveBeenCalled();
  });

  it('should trigger encoder.restart() on auth when cached keyframe is stale (>= 2s)', async () => {
    const mockAuth: any = {
      verifyPin: vi.fn().mockResolvedValue({ success: true, token: 'mock-token' }),
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
      restart: vi.fn().mockResolvedValue(undefined),
      getCachedKeyframe: vi.fn(() => ({ data: Buffer.from([0, 0, 0, 1, 0x65]), pts: 1000000n })),
      isKeyframeStale: vi.fn(() => true),
      getCachedSpsPps: () => null,
      getCachedOpusHead: () => null,
      on: vi.fn(),
    };

    const mockInput: any = {};
    const mockConfig: any = {
      getConfig: () => ({ isSetupCompleted: true }),
    };

    const handler = new WebSocketHandler(mockAuth, mockBrowser, mockEncoder, mockInput, mockConfig);

    const mockSocket: any = {
      readyState: 1,
      send: vi.fn(),
      on: vi.fn(),
    };

    handler.handleConnection(mockSocket);
    const messageListener = mockSocket.on.mock.calls.find(
      (call: any[]) => call[0] === 'message',
    )?.[1];

    // Authenticate client
    const authBuf = Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]);
    await messageListener(authBuf);

    // Stale keyframe must trigger encoder.restart() instead of sending the old keyframe
    expect(mockEncoder.isKeyframeStale).toHaveBeenCalled();
    expect(mockEncoder.restart).toHaveBeenCalledTimes(1);

    // Ensure stale video frame was NOT sent
    const sentVideoPackets = mockSocket.send.mock.calls.filter((call: any[]) => {
      const buf = call[0];
      return Buffer.isBuffer(buf) && buf[0] === WSS_CHANNEL.VIDEO;
    });
    expect(sentVideoPackets.length).toBe(0);

    handler.close();
  });

  it('should replay fresh cached keyframe when keyframe is not stale (< 2s)', async () => {
    const mockAuth: any = {
      verifyPin: vi.fn().mockResolvedValue({ success: true, token: 'mock-token' }),
    };

    const mockBrowser: any = {
      getDimensions: () => ({ width: 1280, height: 720 }),
      getState: () => 'running',
      getCurrentUrl: () => 'https://www.youtube.com',
      resume: vi.fn(),
      isChromeAlive: () => true,
    };

    const keyframeData = Buffer.from([0, 0, 0, 1, 0x65]);
    const mockEncoder: any = {
      isRunning: vi.fn(() => true),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn().mockResolvedValue(undefined),
      getCachedKeyframe: vi.fn(() => ({ data: keyframeData, pts: 2500000n })),
      isKeyframeStale: vi.fn(() => false),
      getCachedSpsPps: () => null,
      getCachedOpusHead: () => null,
      on: vi.fn(),
    };

    const mockInput: any = {};
    const mockConfig: any = {
      getConfig: () => ({ isSetupCompleted: true }),
    };

    const handler = new WebSocketHandler(mockAuth, mockBrowser, mockEncoder, mockInput, mockConfig);

    const mockSocket: any = {
      readyState: 1,
      send: vi.fn(),
      on: vi.fn(),
    };

    handler.handleConnection(mockSocket);
    const messageListener = mockSocket.on.mock.calls.find(
      (call: any[]) => call[0] === 'message',
    )?.[1];

    // Authenticate client
    const authBuf = Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]);
    await messageListener(authBuf);

    // Fresh keyframe should NOT trigger restart
    expect(mockEncoder.isKeyframeStale).toHaveBeenCalled();
    expect(mockEncoder.restart).not.toHaveBeenCalled();

    // Keyframe packet SHOULD have been sent
    const sentVideoPackets = mockSocket.send.mock.calls.filter((call: any[]) => {
      const buf = call[0];
      return Buffer.isBuffer(buf) && buf[0] === WSS_CHANNEL.VIDEO;
    });
    expect(sentVideoPackets.length).toBe(1);

    handler.close();
  });
});
