import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketHandler } from '../src/ws/handler.js';
import { WSS_CHANNEL, VIDEO_FLAGS, AUDIO_FLAGS } from '../src/ws/protocol.js';
import { PlaybackBuffer } from '../src/encoder/playback-buffer.js';

describe('WebSocketHandler CATCHUP Playback Mode & Live Transition', () => {
  let mockAuth: any;
  let mockBrowser: any;
  let mockEncoder: any;
  let mockInput: any;
  let mockConfig: any;

  beforeEach(() => {
    mockAuth = {
      verifyPin: vi.fn().mockResolvedValue({ success: true, token: 'mock-token' }),
      validateSession: vi.fn().mockReturnValue(true),
    };

    mockBrowser = {
      getDimensions: () => ({ width: 1280, height: 720 }),
      getState: () => 'running',
      getCurrentUrl: () => 'https://www.youtube.com',
      resume: vi.fn(),
      navigate: vi.fn().mockResolvedValue(undefined),
      isChromeAlive: () => true,
    };

    mockEncoder = {
      isRunning: vi.fn(() => true),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn().mockResolvedValue(undefined),
      getCachedKeyframe: vi.fn(() => ({ data: Buffer.from([0, 0, 0, 1, 0x65]), pts: 5000000n })),
      isKeyframeStale: vi.fn(() => false),
      getCachedSpsPps: vi.fn(() => Buffer.from([0, 0, 0, 1, 0x67])),
      getCachedOpusHead: vi.fn(() => Buffer.from('OpusHead')),
      on: vi.fn(),
    };

    mockInput = {
      handleTouchEvent: vi.fn(),
      sendKey: vi.fn(),
      navigateBack: vi.fn(),
      updateDimensions: vi.fn(),
    };

    mockConfig = {
      getConfig: () => ({ isSetupCompleted: true, stream: { bitrate: 1000000 } }),
    };
  });

  it('should record ACK messages and preserve lastAckPts without marking user activity', async () => {
    const handler = new WebSocketHandler(mockAuth, mockBrowser, mockEncoder, mockInput, mockConfig);

    const mockSocket: any = {
      readyState: 1,
      send: vi.fn(),
      on: vi.fn(),
    };

    handler.handleConnection(mockSocket);
    const messageListener = mockSocket.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

    // Authenticate
    const authBuf = Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]);
    await messageListener(authBuf);

    // Initial input timestamp
    const initialInputAt = 1000;
    handler.setLastInputAt(initialInputAt);

    // Send ACK command
    const ackPayload = Buffer.concat([
      Buffer.from([WSS_CHANNEL.COMMAND]),
      Buffer.from(JSON.stringify({ type: 'ACK', pts: 2500000 })),
    ]);
    await messageListener(ackPayload);

    // lastAckPts must be updated to 2500000n
    const session = handler.getClientSession(mockSocket);
    expect(session).toBeDefined();
    expect(session!.lastAckPts).toBe(2500000n);

    // ACK must NOT update lastInputAt (it is background telemetry, not user input)
    expect(handler.getLastInputAt()).toBe(initialInputAt);

    handler.close();
  });

  it('should reconnect into CATCHUP mode when idle (> 5s) and replay buffer at 1x pacing', async () => {
    vi.useFakeTimers();

    const playbackBuffer = new PlaybackBuffer({ bufferSeconds: 10 });
    const spsPps = Buffer.from([0, 0, 0, 1, 0x67]);
    const opusHead = Buffer.from('OpusHead');
    const keyframe = Buffer.from([0, 0, 0, 1, 0x65, 0x01]);
    const delta1 = Buffer.from([0, 0, 0, 1, 0x41, 0x02]);
    const delta2 = Buffer.from([0, 0, 0, 1, 0x41, 0x03]);
    const audioPkt1 = Buffer.from([0xf8, 0x01]);
    const audioPkt2 = Buffer.from([0xf8, 0x02]);

    // Populate buffer:
    // Video: 1000ms (key), 1033ms (delta), 1066ms (delta)
    // Audio: 1000ms, 1020ms
    playbackBuffer.addVideo(VIDEO_FLAGS.CONFIG, 0n, spsPps);
    playbackBuffer.addAudio(AUDIO_FLAGS.CONFIG, 0n, opusHead);
    playbackBuffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1000000n, keyframe);
    playbackBuffer.addAudio(AUDIO_FLAGS.KEYFRAME, 1000000n, audioPkt1);
    playbackBuffer.addAudio(AUDIO_FLAGS.KEYFRAME, 1020000n, audioPkt2);
    playbackBuffer.addVideo(0, 1033000n, delta1);
    playbackBuffer.addVideo(0, 1066000n, delta2);

    const handler = new WebSocketHandler(
      mockAuth,
      mockBrowser,
      mockEncoder,
      mockInput,
      mockConfig,
      playbackBuffer
    );

    // Set last input to 10 seconds ago (idle state > IDLE_TO_BUFFER_SECONDS = 5s)
    handler.setLastInputAt(Date.now() - 10000);

    // First socket connects, sends ACK, and disconnects
    const socket1: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket1);
    const msgListener1 = socket1.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];
    const closeListener1 = socket1.on.mock.calls.find((c: any[]) => c[0] === 'close')?.[1];

    await msgListener1(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));
    // Send ACK for 1033ms
    await msgListener1(
      Buffer.concat([
        Buffer.from([WSS_CHANNEL.COMMAND]),
        Buffer.from(JSON.stringify({ type: 'ACK', pts: 1033000 })),
      ])
    );
    closeListener1();

    // Now socket2 reconnects (same client recovering after network drop)
    const socket2: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket2);
    const msgListener2 = socket2.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

    await msgListener2(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));

    const session2 = handler.getClientSession(socket2);
    expect(session2).toBeDefined();
    expect(session2!.mode).toBe('CATCHUP');

    // CONFIG packets (video SPS/PPS and audio OpusHead) should have been sent first, followed by the first frame
    const sentPackets: Buffer[] = socket2.send.mock.calls.map((call: any[]) => call[0]);
    expect(sentPackets.length).toBeGreaterThanOrEqual(2);

    // Step fake timers forward to let pacer emit remaining frames in 1x speed
    // Total duration of frames is 66ms. Advance 150ms to ensure all queued frames are flushed.
    vi.advanceTimersByTime(150);

    // After all frames sent, mode must transition to LIVE
    expect(session2!.mode).toBe('LIVE');
    expect(session2!.playbackQueue.length).toBe(0);

    handler.close();
    vi.useRealTimers();
  });

  it('should queue live frames at end of playback queue during CATCHUP and drain them seamlessly', async () => {
    vi.useFakeTimers();

    const playbackBuffer = new PlaybackBuffer({ bufferSeconds: 10 });
    playbackBuffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1000000n, Buffer.from('v1000'));
    playbackBuffer.addVideo(0, 1033000n, Buffer.from('v1033'));

    let videoListener: ((data: any) => void) | null = null;
    mockEncoder.on = vi.fn((event: string, cb: any) => {
      if (event === 'video') videoListener = cb;
    });

    const handler = new WebSocketHandler(
      mockAuth,
      mockBrowser,
      mockEncoder,
      mockInput,
      mockConfig,
      playbackBuffer
    );

    handler.setLastInputAt(Date.now() - 10000);

    const socket: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket);
    const msgListener = socket.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

    const session = handler.getClientSession(socket);
    session!.lastAckPts = 1000000n;

    await msgListener(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));
    expect(session!.mode).toBe('CATCHUP');

    // Live video frames arrive from FFmpeg while client is still catching up
    expect(videoListener).toBeDefined();
    videoListener!({ flags: 0, pts: 1066000n, data: Buffer.from('v1066-live') });
    videoListener!({ flags: 0, pts: 1099000n, data: Buffer.from('v1099-live') });

    // Live frames should have been appended to session.playbackQueue rather than sent directly
    expect(session!.playbackQueue.length).toBeGreaterThanOrEqual(2);
    expect(session!.mode).toBe('CATCHUP');

    // Advance timers until all queued frames (buffer + live frames) are drained
    vi.advanceTimersByTime(200);

    expect(session!.mode).toBe('LIVE');
    expect(session!.playbackQueue.length).toBe(0);

    handler.close();
    vi.useRealTimers();
  });

  it('should automatically interrupt CATCHUP on user touch or key input (Auto-Hybrid mode), drop buffer, and jump to LIVE', async () => {
    vi.useFakeTimers();

    const playbackBuffer = new PlaybackBuffer({ bufferSeconds: 10 });
    playbackBuffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1000000n, Buffer.alloc(100));
    playbackBuffer.addVideo(0, 1033000n, Buffer.alloc(100));
    playbackBuffer.addVideo(0, 1066000n, Buffer.alloc(100));
    playbackBuffer.addVideo(0, 1099000n, Buffer.alloc(100));

    const handler = new WebSocketHandler(
      mockAuth,
      mockBrowser,
      mockEncoder,
      mockInput,
      mockConfig,
      playbackBuffer
    );

    // Idle reconnect
    handler.setLastInputAt(Date.now() - 10000);

    const socket: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket);
    const msgListener = socket.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

    // Set lastAckPts and authenticate
    const session = handler.getClientSession(socket);
    session!.lastAckPts = 1000000n;

    await msgListener(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));
    expect(session!.mode).toBe('CATCHUP');
    expect(session!.playbackQueue.length).toBeGreaterThan(0);

    socket.send.mockClear();

    // User touches the screen (WSS_CHANNEL.TOUCH) -> Auto-Hybrid immediately switches to LIVE for snappy UI operation
    const touchBuf = Buffer.alloc(33);
    touchBuf[0] = WSS_CHANNEL.TOUCH;
    touchBuf[2] = 0; // DOWN
    await msgListener(touchBuf);

    expect(session!.mode).toBe('LIVE');
    expect(session!.playbackQueue.length).toBe(0);
    expect(session!.pacingTimer).toBeNull();

    handler.close();
    vi.useRealTimers();
  });

  it('should immediately interrupt CATCHUP on explicit JUMP_TO_LIVE command, drop buffer, and jump to LIVE', async () => {
    vi.useFakeTimers();

    const playbackBuffer = new PlaybackBuffer({ bufferSeconds: 10 });
    playbackBuffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1000000n, Buffer.alloc(100));
    playbackBuffer.addVideo(0, 1033000n, Buffer.alloc(100));
    playbackBuffer.addVideo(0, 1066000n, Buffer.alloc(100));

    const handler = new WebSocketHandler(
      mockAuth,
      mockBrowser,
      mockEncoder,
      mockInput,
      mockConfig,
      playbackBuffer
    );

    handler.setLastInputAt(Date.now() - 10000);

    const socket: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket);
    const msgListener = socket.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

    const session = handler.getClientSession(socket);
    session!.lastAckPts = 1000000n;

    await msgListener(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));
    expect(session!.mode).toBe('CATCHUP');
    expect(session!.playbackQueue.length).toBeGreaterThan(0);

    socket.send.mockClear();

    // User taps the HUD "LIVEへ戻る" button -> sends JUMP_TO_LIVE
    const jumpCmd = Buffer.concat([
      Buffer.from([WSS_CHANNEL.COMMAND]),
      Buffer.from(JSON.stringify({ type: 'JUMP_TO_LIVE' })),
    ]);
    await msgListener(jumpCmd);

    expect(session!.mode).toBe('LIVE');
    expect(session!.playbackQueue.length).toBe(0);
    expect(session!.pacingTimer).toBeNull();

    // Latest IDR keyframe should have been sent immediately for sub-second live jump
    const sentVideoCalls = socket.send.mock.calls.filter((call: any[]) => {
      const b = call[0];
      return Buffer.isBuffer(b) && b[0] === WSS_CHANNEL.VIDEO;
    });
    expect(sentVideoCalls.length).toBeGreaterThanOrEqual(1);

    handler.close();
    vi.useRealTimers();
  });

  it('should clear buffer and revert all clients to LIVE on navigation', async () => {
    const playbackBuffer = new PlaybackBuffer();
    playbackBuffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1000000n, Buffer.alloc(100));
    expect(playbackBuffer.getVideoCount()).toBe(1);

    const handler = new WebSocketHandler(
      mockAuth,
      mockBrowser,
      mockEncoder,
      mockInput,
      mockConfig,
      playbackBuffer
    );

    const socket: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket);
    const msgListener = socket.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];
    await msgListener(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));

    // Send NAVIGATE command
    const navCmd = Buffer.concat([
      Buffer.from([WSS_CHANNEL.COMMAND]),
      Buffer.from(JSON.stringify({ type: 'NAVIGATE', url: 'https://youtube.com/watch?v=test' })),
    ]);
    await msgListener(navCmd);

    // Buffer must be cleared completely
    expect(playbackBuffer.getVideoCount()).toBe(0);
    expect(handler.getClientSession(socket)?.mode).toBe('LIVE');

    handler.close();
  });

  it('should perform standard LIVE reconnection when user was active within 5s (not idle)', async () => {
    const playbackBuffer = new PlaybackBuffer({ bufferSeconds: 10 });
    playbackBuffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1000000n, Buffer.alloc(100));

    const handler = new WebSocketHandler(
      mockAuth,
      mockBrowser,
      mockEncoder,
      mockInput,
      mockConfig,
      playbackBuffer
    );

    // Last input was 1 second ago (< IDLE_TO_BUFFER_SECONDS = 5s)
    handler.setLastInputAt(Date.now() - 1000);

    const socket: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket);
    const msgListener = socket.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

    const session = handler.getClientSession(socket);
    session!.lastAckPts = 1000000n;

    await msgListener(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));

    // Should stay in LIVE mode, not CATCHUP
    expect(session!.mode).toBe('LIVE');
    expect(session!.playbackQueue.length).toBe(0);

    handler.close();
  });

  it('should handle BUFFER_FEEDBACK command to update client telemetry and abort CATCHUP on interaction', async () => {
    const playbackBuffer = new PlaybackBuffer({ bufferSeconds: 10 });
    playbackBuffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1000000n, Buffer.alloc(100));

    const handler = new WebSocketHandler(
      mockAuth,
      mockBrowser,
      mockEncoder,
      mockInput,
      mockConfig,
      playbackBuffer
    );

    const socket: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket);
    const msgListener = socket.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

    await msgListener(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));
    const session = handler.getClientSession(socket)!;

    // Send BUFFER_FEEDBACK with telemetry
    const feedbackPayload = Buffer.concat([
      Buffer.from([WSS_CHANNEL.COMMAND]),
      Buffer.from(JSON.stringify({
        type: 'BUFFER_FEEDBACK',
        bufferedMs: 4200,
        targetBufferMs: 10000,
        lastRenderedPts: '1050000',
        isInteractive: false,
      })),
    ]);
    await msgListener(feedbackPayload);

    expect(session.bufferedMs).toBe(4200);
    expect(session.targetBufferMs).toBe(10000);
    expect(session.lastAckPts).toBe(1050000n);
    expect(session.isInteractive).toBe(false);

    // Simulate CATCHUP state and interactive touch feedback
    session.mode = 'CATCHUP';
    session.playbackQueue = [{ type: 'video', flags: 0, pts: 1080000n, data: Buffer.alloc(10) }];

    const interactiveFeedback = Buffer.concat([
      Buffer.from([WSS_CHANNEL.COMMAND]),
      Buffer.from(JSON.stringify({
        type: 'BUFFER_FEEDBACK',
        bufferedMs: 0,
        targetBufferMs: 10000,
        isInteractive: true,
      })),
    ]);
    await msgListener(interactiveFeedback);

    // Should abort CATCHUP immediately and switch to LIVE
    expect(session.mode).toBe('LIVE');
    expect(session.playbackQueue.length).toBe(0);

    handler.close();
  });
});
