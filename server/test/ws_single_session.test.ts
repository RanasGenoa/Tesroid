import { describe, expect, it, vi } from 'vitest';
import { PlaybackBuffer } from '../src/encoder/playback-buffer.js';
import { WebSocketHandler } from '../src/ws/handler.js';
import { VIDEO_FLAGS, WSS_CHANNEL } from '../src/ws/protocol.js';

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

async function sendMessage(
  client: ReturnType<typeof createMockSocket>,
  buf: Buffer,
): Promise<void> {
  const listener = client.listeners.get('message');
  if (!listener) {
    throw new Error('Missing message listener on mock socket');
  }
  await listener(buf);
}

function createResizePacket(width: number, height: number, dpr = 1): Buffer {
  const buf = Buffer.alloc(7);
  buf[0] = WSS_CHANNEL.RESIZE;
  buf.writeUInt16BE(width, 1);
  buf.writeUInt16BE(height, 3);
  buf.writeUInt16BE(Math.round(dpr * 100), 5);
  return buf;
}

function createTestContext(mockAuth: any, playbackBuffer?: PlaybackBuffer) {
  const mockBrowser: any = {
    getDimensions: () => ({ width: 1280, height: 720 }),
    getState: () => 'running',
    getCurrentUrl: () => 'https://www.youtube.com',
    resume: vi.fn(),
    pause: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
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
  const mockInput: any = {
    updateDimensions: vi.fn(),
  };
  const mockConfig: any = {
    getConfig: () => ({ isSetupCompleted: true }),
  };
  const handler = new WebSocketHandler(
    mockAuth,
    mockBrowser,
    mockEncoder,
    mockInput,
    mockConfig,
    playbackBuffer,
  );
  return { handler, mockBrowser, mockEncoder, mockInput };
}

function createHandler(mockAuth: any) {
  return createTestContext(mockAuth).handler;
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

describe('WebSocketHandler Multi-Display Secondary Session (Issue #70)', () => {
  it('allows SECONDARY:<pin> to join without disconnecting primary or restarting encoder and preserves buffer', async () => {
    const mockAuth: any = {
      verifyPin: vi
        .fn()
        .mockResolvedValueOnce({ success: true, token: 'token-primary' })
        .mockResolvedValueOnce({ success: true, token: 'token-secondary' }),
      validateSession: vi.fn(() => true),
    };
    const playbackBuffer = new PlaybackBuffer({ bufferSeconds: 10 });
    playbackBuffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1000000n, Buffer.from([0, 0, 0, 1, 0x65]));

    const { handler, mockEncoder } = createTestContext(mockAuth, playbackBuffer);
    expect(handler.hasActiveClients()).toBe(false);

    const primary = createMockSocket();
    handler.handleConnection(primary.socket);
    // Connected but unauthenticated socket does not count as active client
    expect(handler.hasActiveClients()).toBe(false);

    await sendMessage(
      primary,
      Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]),
    );
    expect(handler.hasActiveClients()).toBe(true);
    expect(primary.sentControl.find((m) => m.type === 'AUTH_SUCCESS')).toEqual({
      type: 'AUTH_SUCCESS',
      token: 'token-primary',
      role: 'primary',
    });

    // Primary records ACK and goes idle
    await sendMessage(
      primary,
      Buffer.concat([
        Buffer.from([WSS_CHANNEL.COMMAND]),
        Buffer.from(JSON.stringify({ type: 'ACK', pts: 1000000 })),
      ]),
    );
    handler.setLastInputAt(Date.now() - 10000);

    // Secondary joins via SECONDARY:<pin>
    const secondary = createMockSocket();
    handler.handleConnection(secondary.socket);
    await sendMessage(
      secondary,
      Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('SECONDARY:1234')]),
    );

    expect(mockAuth.verifyPin).toHaveBeenNthCalledWith(2, '1234');
    expect(primary.socket.close).not.toHaveBeenCalled();
    expect(primary.sentControl.some((m) => m.type === 'SESSION_CONFLICT')).toBe(false);
    expect(secondary.socket.close).not.toHaveBeenCalled();
    expect(secondary.sentControl.find((m) => m.type === 'AUTH_SUCCESS')).toEqual({
      type: 'AUTH_SUCCESS',
      token: 'token-secondary',
      role: 'secondary',
    });

    // Encoder must not stop/start/restart, playbackBuffer must be preserved, and secondary joins LIVE
    expect(mockEncoder.stop).not.toHaveBeenCalled();
    expect(mockEncoder.start).not.toHaveBeenCalled();
    expect(mockEncoder.restart).not.toHaveBeenCalled();
    expect(playbackBuffer.getVideoCount()).toBe(1);

    const secondarySession = handler.getClientSession(secondary.socket);
    expect(secondarySession?.role).toBe('secondary');
    expect(secondarySession?.mode).toBe('LIVE');
    expect(secondarySession?.lastAckPts).toBeNull();

    // hasActiveClients remains true while either client is connected, then false once both close
    primary.listeners.get('close')?.();
    expect(handler.hasActiveClients()).toBe(true);
    secondary.listeners.get('close')?.();
    expect(handler.hasActiveClients()).toBe(false);

    handler.close();
  });

  it('ignores RESIZE from secondary session while applying RESIZE from primary session', async () => {
    vi.useFakeTimers();
    try {
      const mockAuth: any = {
        verifyPin: vi
          .fn()
          .mockResolvedValueOnce({ success: true, token: 'token-primary' })
          .mockResolvedValueOnce({ success: true, token: 'token-secondary' }),
        validateSession: vi.fn(() => true),
      };
      const { handler, mockBrowser, mockEncoder, mockInput } = createTestContext(mockAuth);

      const primary = createMockSocket();
      const secondary = createMockSocket();

      handler.handleConnection(primary.socket);
      await sendMessage(
        primary,
        Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]),
      );

      handler.handleConnection(secondary.socket);
      await sendMessage(
        secondary,
        Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('SECONDARY:1234')]),
      );

      // Secondary sends RESIZE -> must be ignored
      await sendMessage(secondary, createResizePacket(1920, 1080));
      await vi.advanceTimersByTimeAsync(500);

      expect(mockBrowser.resize).not.toHaveBeenCalled();
      expect(mockEncoder.restart).not.toHaveBeenCalled();
      expect(mockInput.updateDimensions).not.toHaveBeenCalled();

      // Primary sends RESIZE -> must be applied
      await sendMessage(primary, createResizePacket(1024, 600));
      await vi.advanceTimersByTimeAsync(500);

      expect(mockBrowser.resize).toHaveBeenCalledWith(1024, 600);
      expect(mockEncoder.restart).toHaveBeenCalledWith(1024, 600);
      expect(mockInput.updateDimensions).toHaveBeenCalledWith(1024, 600);

      handler.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows both primary and secondary TOKEN reconnects while partner is active, and rejects unauthorized 3rd token with 4009', async () => {
    const mockAuth: any = {
      verifyPin: vi
        .fn()
        .mockResolvedValueOnce({ success: true, token: 'token-primary' })
        .mockResolvedValueOnce({ success: true, token: 'token-secondary' }),
      validateSession: vi.fn(
        (t: string) => t === 'token-primary' || t === 'token-secondary' || t === 'token-mac',
      ),
    };
    const playbackBuffer = new PlaybackBuffer({ bufferSeconds: 10 });
    playbackBuffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1000000n, Buffer.from([0, 0, 0, 1, 0x65]));

    const { handler, mockEncoder } = createTestContext(mockAuth, playbackBuffer);

    const primary1 = createMockSocket();
    const secondary1 = createMockSocket();

    handler.handleConnection(primary1.socket);
    await sendMessage(
      primary1,
      Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]),
    );

    handler.handleConnection(secondary1.socket);
    await sendMessage(
      secondary1,
      Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('SECONDARY:1234')]),
    );

    // 1. Unauthorized 3rd client attempts TOKEN reconnect while primary & secondary are active
    const thirdClient = createMockSocket();
    handler.handleConnection(thirdClient.socket);
    await sendMessage(
      thirdClient,
      Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('TOKEN:token-mac')]),
    );

    expect(thirdClient.sentControl.some((m) => m.type === 'SESSION_CONFLICT')).toBe(true);
    expect(thirdClient.sentControl.some((m) => m.type === 'AUTH_SUCCESS')).toBe(false);
    expect(thirdClient.socket.close).toHaveBeenCalledWith(4009, 'Another session is active');
    expect(primary1.socket.close).not.toHaveBeenCalled();
    expect(secondary1.socket.close).not.toHaveBeenCalled();

    // 2. Primary reconnects with TOKEN:token-primary while secondary is active (before old primary socket closes)
    const primary2 = createMockSocket();
    handler.handleConnection(primary2.socket);
    await sendMessage(
      primary2,
      Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('TOKEN:token-primary')]),
    );

    expect(primary1.socket.close).toHaveBeenCalledWith(4000, 'Replaced by reconnect');
    expect(secondary1.socket.close).not.toHaveBeenCalled();
    expect(primary2.sentControl.find((m) => m.type === 'AUTH_SUCCESS')).toEqual({
      type: 'AUTH_SUCCESS',
      token: 'token-primary',
      role: 'primary',
    });

    // 3. Secondary disconnects and reconnects with TOKEN:token-secondary while primary is active
    secondary1.listeners.get('close')?.();
    const secondary2 = createMockSocket();
    handler.handleConnection(secondary2.socket);
    await sendMessage(
      secondary2,
      Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('TOKEN:token-secondary')]),
    );

    expect(primary2.socket.close).not.toHaveBeenCalled();
    expect(secondary2.sentControl.find((m) => m.type === 'AUTH_SUCCESS')).toEqual({
      type: 'AUTH_SUCCESS',
      token: 'token-secondary',
      role: 'secondary',
    });

    // Neither partner reconnect should stop/restart encoder or clear playbackBuffer
    expect(mockEncoder.stop).not.toHaveBeenCalled();
    expect(mockEncoder.start).not.toHaveBeenCalled();
    expect(mockEncoder.restart).not.toHaveBeenCalled();
    expect(playbackBuffer.getVideoCount()).toBe(1);

    handler.close();
  });
});
