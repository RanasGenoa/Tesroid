import { describe, expect, it, vi } from 'vitest';
import { WebSocketHandler } from '../src/ws/handler.js';
import { WSS_CHANNEL } from '../src/ws/protocol.js';

function createMockSocket() {
  const listeners = new Map<string, Function>();
  const sentControl: any[] = [];
  const socket: any = {
    readyState: 1,
    send: vi.fn((data: Buffer) => {
      if (Buffer.isBuffer(data) && data[0] === WSS_CHANNEL.CONTROL_RESPONSE) {
        try {
          sentControl.push(JSON.parse(data.subarray(1).toString('utf-8')));
        } catch {}
      }
    }),
    close: vi.fn(),
    on: vi.fn((event: string, cb: Function) => {
      listeners.set(event, cb);
    }),
  };
  return { socket, listeners, sentControl };
}

function createHandler(mockAuth: any) {
  const mockBrowser: any = {
    getDimensions: () => ({ width: 1280, height: 720 }),
    getState: () => 'running',
    getCurrentUrl: () => 'https://www.youtube.com',
    resume: vi.fn(),
    pause: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    isChromeAlive: () => true,
  };
  const mockEncoder: any = {
    isRunning: vi.fn(() => true),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn().mockResolvedValue(undefined),
    getCachedKeyframe: () => ({ data: Buffer.from([0, 0, 0, 1, 0x65]), pts: 1000n }),
    isKeyframeStale: () => false,
    getCachedSpsPps: () => Buffer.from([0, 0, 0, 1, 0x67]),
    getCachedOpusHead: () => null,
    on: vi.fn(),
  };
  const mockInput: any = {};
  const mockConfig: any = {
    getConfig: () => ({ isSetupCompleted: true }),
  };
  return new WebSocketHandler(mockAuth, mockBrowser, mockEncoder, mockInput, mockConfig);
}

describe('WebSocketHandler Single-Client Session Exclusivity (Issue #58)', () => {
  it('rejects background TOKEN auto-reconnect from a different session while another client is active', async () => {
    const mockAuth: any = {
      verifyPin: vi.fn().mockResolvedValue({ success: true, token: 'token-tesla' }),
      validateSession: vi.fn((t: string) => t === 'token-tesla' || t === 'token-mac'),
    };
    const handler = createHandler(mockAuth);

    const clientA = createMockSocket();
    const clientB = createMockSocket();

    handler.handleConnection(clientA.socket);
    await clientA.listeners.get('message')!(
      Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]),
    );
    expect(clientA.sentControl.some((m) => m.type === 'AUTH_SUCCESS')).toBe(true);

    // Secondary client B attempts auto-reconnect using a different session token
    handler.handleConnection(clientB.socket);
    await clientB.listeners.get('message')!(
      Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('TOKEN:token-mac')]),
    );

    expect(clientB.sentControl.some((m) => m.type === 'SESSION_CONFLICT')).toBe(true);
    expect(clientB.sentControl.some((m) => m.type === 'AUTH_SUCCESS')).toBe(false);
    expect(clientB.socket.close).toHaveBeenCalledWith(4009, 'Another session is active');
    expect(clientA.socket.close).not.toHaveBeenCalled();

    handler.close();
  });

  it('allows same-token reconnect (network glitch recovery) and replaces old socket', async () => {
    const mockAuth: any = {
      verifyPin: vi.fn().mockResolvedValue({ success: true, token: 'token-tesla' }),
      validateSession: vi.fn((t: string) => t === 'token-tesla'),
    };
    const handler = createHandler(mockAuth);

    const clientOld = createMockSocket();
    const clientNew = createMockSocket();

    handler.handleConnection(clientOld.socket);
    await clientOld.listeners.get('message')!(
      Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]),
    );

    // Same client reconnects before old socket's close event fires
    handler.handleConnection(clientNew.socket);
    await clientNew.listeners.get('message')!(
      Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('TOKEN:token-tesla')]),
    );

    expect(clientOld.socket.close).toHaveBeenCalledWith(4000, 'Replaced by reconnect');
    expect(clientNew.sentControl.some((m) => m.type === 'AUTH_SUCCESS')).toBe(true);
    expect(clientNew.sentControl.some((m) => m.type === 'SESSION_CONFLICT')).toBe(false);

    handler.close();
  });

  it('disconnects existing client and hands over control on manual PIN login', async () => {
    const mockAuth: any = {
      verifyPin: vi
        .fn()
        .mockResolvedValueOnce({ success: true, token: 'token-mac' })
        .mockResolvedValueOnce({ success: true, token: 'token-tesla' }),
      validateSession: vi.fn(() => true),
    };
    const handler = createHandler(mockAuth);

    const clientMac = createMockSocket();
    const clientTesla = createMockSocket();

    handler.handleConnection(clientMac.socket);
    await clientMac.listeners.get('message')!(
      Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]),
    );

    // User manually enters PIN on Tesla
    handler.handleConnection(clientTesla.socket);
    await clientTesla.listeners.get('message')!(
      Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]),
    );

    expect(clientMac.sentControl.some((m) => m.type === 'SESSION_CONFLICT')).toBe(true);
    expect(clientMac.socket.close).toHaveBeenCalledWith(4009, 'Superseded by new PIN login');
    expect(clientTesla.sentControl.some((m) => m.type === 'AUTH_SUCCESS')).toBe(true);
    expect(clientTesla.socket.close).not.toHaveBeenCalled();

    handler.close();
  });

  it('restarts encoders and clears playback buffer when switching to a new client session', async () => {
    const mockAuth: any = {
      verifyPin: vi
        .fn()
        .mockResolvedValueOnce({ success: true, token: 'token-mac' })
        .mockResolvedValueOnce({ success: true, token: 'token-tesla' }),
      validateSession: vi.fn(() => true),
    };
    const mockBrowser: any = {
      getDimensions: () => ({ width: 1280, height: 720 }),
      getState: () => 'running',
      getCurrentUrl: () => 'https://www.youtube.com',
      resume: vi.fn(),
      pause: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      isChromeAlive: () => true,
    };
    const mockEncoder: any = {
      isRunning: vi.fn(() => true),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn().mockResolvedValue(undefined),
      getCachedKeyframe: () => null,
      isKeyframeStale: () => false,
      getCachedSpsPps: () => null,
      getCachedOpusHead: () => null,
      on: vi.fn(),
    };
    const handler = new WebSocketHandler(
      mockAuth,
      mockBrowser,
      mockEncoder,
      {} as any,
      { getConfig: () => ({ isSetupCompleted: true }) } as any,
    );

    const clientMac = createMockSocket();
    handler.handleConnection(clientMac.socket);
    await clientMac.listeners.get('message')!(
      Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]),
    );
    expect(mockEncoder.stop).not.toHaveBeenCalled();

    // Disconnect Mac, then connect Tesla as a new PIN session
    clientMac.listeners.get('close')?.();
    const clientTesla = createMockSocket();
    handler.handleConnection(clientTesla.socket);
    await clientTesla.listeners.get('message')!(
      Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]),
    );

    expect(mockEncoder.stop).toHaveBeenCalledTimes(1);
    expect(mockEncoder.start).toHaveBeenCalledTimes(1);

    handler.close();
  });
});
