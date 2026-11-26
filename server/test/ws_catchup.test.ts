import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackBuffer } from '../src/encoder/playback-buffer.js';
import { WebSocketHandler } from '../src/ws/handler.js';
import { AUDIO_FLAGS, VIDEO_FLAGS, WSS_CHANNEL } from '../src/ws/protocol.js';

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
      pause: vi.fn(),
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
      playbackBuffer,
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
      ]),
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
      playbackBuffer,
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
      playbackBuffer,
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
      playbackBuffer,
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
      playbackBuffer,
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
      playbackBuffer,
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
      playbackBuffer,
    );

    const socket: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket);
    const msgListener = socket.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

    await msgListener(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));
    const session = handler.getClientSession(socket)!;

    // Send BUFFER_FEEDBACK with telemetry
    const feedbackPayload = Buffer.concat([
      Buffer.from([WSS_CHANNEL.COMMAND]),
      Buffer.from(
        JSON.stringify({
          type: 'BUFFER_FEEDBACK',
          bufferedMs: 4200,
          targetBufferMs: 10000,
          lastRenderedPts: '1050000',
          isInteractive: false,
        }),
      ),
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
      Buffer.from(
        JSON.stringify({
          type: 'BUFFER_FEEDBACK',
          bufferedMs: 0,
          targetBufferMs: 10000,
          isInteractive: true,
        }),
      ),
    ]);
    await msgListener(interactiveFeedback);

    // Should abort CATCHUP immediately and switch to LIVE
    expect(session.mode).toBe('LIVE');
    expect(session.playbackQueue.length).toBe(0);

    handler.close();
  });

  it('should pause catchup burst when in-flight buffer reaches targetBufferMs (Flow Control / Sliding Window)', async () => {
    vi.useFakeTimers();

    // 20秒分のバッファを用意 (30fps = 600フレーム, pts: 0s 〜 20s)
    const playbackBuffer = new PlaybackBuffer({ bufferSeconds: 30 });
    const spsPps = Buffer.from([0, 0, 0, 1, 0x67]);
    const opusHead = Buffer.from('OpusHead');
    const keyframe = Buffer.from([0, 0, 0, 1, 0x65]);

    playbackBuffer.addVideo(VIDEO_FLAGS.CONFIG, 0n, spsPps);
    playbackBuffer.addAudio(AUDIO_FLAGS.CONFIG, 0n, opusHead);
    playbackBuffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1000000n, keyframe); // PTS = 1s

    // 1秒から21秒まで 33ms 刻みで600フレーム登録
    for (let i = 1; i < 600; i++) {
      const pts = 1000000n + BigInt(i * 33333);
      playbackBuffer.addVideo(0, pts, Buffer.alloc(50));
    }

    const handler = new WebSocketHandler(
      mockAuth,
      mockBrowser,
      mockEncoder,
      mockInput,
      mockConfig,
      playbackBuffer,
    );

    // アイドル状態 (CATCHUP 許可)
    handler.setLastInputAt(Date.now() - 10000);

    const socket: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket);
    const msgListener = socket.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

    const session = handler.getClientSession(socket)!;
    session.lastAckPts = 1000000n; // 1秒地点まで再生済み
    session.targetBufferMs = 10000; // クライアントの上限は10秒

    // 認証して CATCHUP 開始
    await msgListener(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));
    expect(session.mode).toBe('CATCHUP');
    expect(session.playbackQueue.length).toBeGreaterThan(500);

    // クライアントが再接続直後に BUFFER_FEEDBACK (手元バッファ 0ms) を送信 (Issue 26 の再現)
    const feedbackPayload = Buffer.concat([
      Buffer.from([WSS_CHANNEL.COMMAND]),
      Buffer.from(
        JSON.stringify({
          type: 'BUFFER_FEEDBACK',
          bufferedMs: 0,
          targetBufferMs: 10000,
          lastRenderedPts: '1000000',
        }),
      ),
    ]);
    await msgListener(feedbackPayload);

    // バーストタイマーを進める (2ms ごとにフレーム送信)
    // 10秒分 = 約300フレーム 送出されるまで進める (~1000ms)
    vi.advanceTimersByTime(1200);

    // 10秒分（pts = 11s）に到達した時点でフロー制御が発動し、送出が一時停止していること
    expect(session.isFlowPaused).toBe(true);
    // サーバーのキューにはまだ残りの約10秒分（約300フレーム）が残っていること！
    expect(session.playbackQueue.length).toBeGreaterThan(250);

    // クライアントが 5秒 分再生を進めたと報告 (PTS = 6s)
    const ackPayload = Buffer.concat([
      Buffer.from([WSS_CHANNEL.COMMAND]),
      Buffer.from(JSON.stringify({ type: 'ACK', pts: 6000000 })),
    ]);
    await msgListener(ackPayload);

    // 送出が再開され、さらにタイマーを進めると残りのキューから順次送出されること
    vi.advanceTimersByTime(500);
    // キューがさらに消費されていること
    expect(session.playbackQueue.length).toBeLessThan(250);

    handler.close();
    vi.useRealTimers();
  });

  it('should prevent client buffer trim and skip on 25s outage recovery via sliding window (Issue 26)', async () => {
    vi.useFakeTimers();

    // 25秒分のバッファを用意 (30fps = 750フレーム, pts: 10s 〜 35s)
    const playbackBuffer = new PlaybackBuffer({ bufferSeconds: 40 });
    const spsPps = Buffer.from([0, 0, 0, 1, 0x67]);
    const opusHead = Buffer.from('OpusHead');
    const keyframe = Buffer.from([0, 0, 0, 1, 0x65]);

    playbackBuffer.addVideo(VIDEO_FLAGS.CONFIG, 0n, spsPps);
    playbackBuffer.addAudio(AUDIO_FLAGS.CONFIG, 0n, opusHead);
    playbackBuffer.addVideo(VIDEO_FLAGS.KEYFRAME, 10_000_000n, keyframe); // PTS = 10s

    for (let i = 1; i < 750; i++) {
      const pts = 10_000_000n + BigInt(i * 33333);
      playbackBuffer.addVideo(0, pts, Buffer.alloc(50));
      if (i % 2 === 0) {
        playbackBuffer.addAudio(0, pts, Buffer.alloc(20));
      }
    }

    const handler = new WebSocketHandler(
      mockAuth,
      mockBrowser,
      mockEncoder,
      mockInput,
      mockConfig,
      playbackBuffer,
    );

    // アイドル状態 (CATCHUP 許可)
    handler.setLastInputAt(Date.now() - 25000);

    const socket: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket);
    const msgListener = socket.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

    const session = handler.getClientSession(socket)!;
    session.lastAckPts = 10_000_000n; // 10秒地点まで再生済みで切断された
    session.targetBufferMs = 10000; // クライアント許容バッファは10秒

    // 1. 回線回復・認証
    await msgListener(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));
    expect(session.mode).toBe('CATCHUP');
    const initialQueueCount = session.playbackQueue.length;
    expect(initialQueueCount).toBeGreaterThanOrEqual(750);

    // 2. クライアントから手元バッファ枯渇 (0ms) フィードバックが届く
    await msgListener(
      Buffer.concat([
        Buffer.from([WSS_CHANNEL.COMMAND]),
        Buffer.from(
          JSON.stringify({
            type: 'BUFFER_FEEDBACK',
            bufferedMs: 0,
            targetBufferMs: 10000,
            lastRenderedPts: '10000000',
          }),
        ),
      ]),
    );

    // 3. バースト送出を進める (10秒分 = 約300映像フレームが送られるまで)
    vi.advanceTimersByTime(1500);

    // フロー制御が働き、In-Flight が 10秒に達したところで送出が一時停止すること
    expect(session.isFlowPaused).toBe(true);
    // サーバーのキューにはまだ残りの約15秒分（約450フレーム以上）が保持されていること！
    expect(session.playbackQueue.length).toBeGreaterThan(400);

    // In-Flight 時間が targetBufferMs (10000ms) を大きく超えていないことを検証
    // (クライアントの trimPendingPackets 閾値 16000ms を絶対に超えない)
    const inFlightMs = Number(session.lastSentVideoPts! - session.lastAckPts!) / 1000;
    expect(inFlightMs).toBeGreaterThanOrEqual(9900);
    expect(inFlightMs).toBeLessThanOrEqual(10100);

    // 4. クライアントが 250ms 周期で再生を進め、フィードバックを返すステップをシミュレート
    // 4秒間（16回 × 250ms）の再生進捗
    for (let step = 1; step <= 16; step++) {
      const currentPtsUs = 10_000_000n + BigInt(step * 250_000);
      await msgListener(
        Buffer.concat([
          Buffer.from([WSS_CHANNEL.COMMAND]),
          Buffer.from(
            JSON.stringify({
              type: 'BUFFER_FEEDBACK',
              bufferedMs: 9750, // 手元バッファは約10秒維持
              targetBufferMs: 10000,
              lastRenderedPts: currentPtsUs.toString(),
            }),
          ),
        ]),
      );
      // 250ms 時間経過（サーバーが消費された 250ms 分を補充送出）
      vi.advanceTimersByTime(250);

      // In-Flight 時間が常に 10.5 秒以下に収まっていること（決して 16 秒に達しない）
      const currentInFlight = Number(session.lastSentVideoPts! - session.lastAckPts!) / 1000;
      expect(currentInFlight).toBeLessThanOrEqual(10500);
    }

    // 4秒分（約120映像 + 60音声 = 約180フレーム）がサーバーからさらに消費されていること (674 -> 494)
    expect(session.playbackQueue.length).toBeLessThan(550);
    expect(session.playbackQueue.length).toBeGreaterThan(450);

    handler.close();
    vi.useRealTimers();
  });

  it('should adapt sliding window flow control to client targetBufferMs (e.g. 2000ms for MCU2)', async () => {
    vi.useFakeTimers();

    const playbackBuffer = new PlaybackBuffer({ bufferSeconds: 15 });
    playbackBuffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1_000_000n, Buffer.alloc(100));

    for (let i = 1; i < 300; i++) {
      playbackBuffer.addVideo(0, 1_000_000n + BigInt(i * 33333), Buffer.alloc(50));
    }

    const handler = new WebSocketHandler(
      mockAuth,
      mockBrowser,
      mockEncoder,
      mockInput,
      mockConfig,
      playbackBuffer,
    );

    handler.setLastInputAt(Date.now() - 10000);

    const socket: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket);
    const msgListener = socket.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

    const session = handler.getClientSession(socket)!;
    session.lastAckPts = 1_000_000n;
    session.targetBufferMs = 2000; // MCU2: 2秒バッファ

    await msgListener(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));
    await msgListener(
      Buffer.concat([
        Buffer.from([WSS_CHANNEL.COMMAND]),
        Buffer.from(
          JSON.stringify({
            type: 'BUFFER_FEEDBACK',
            bufferedMs: 0,
            targetBufferMs: 2000,
            lastRenderedPts: '1000000',
          }),
        ),
      ]),
    );

    // バースト送出を進める
    vi.advanceTimersByTime(500);

    // 2秒分（約60フレーム）送出された時点で一時停止すること
    expect(session.isFlowPaused).toBe(true);
    const inFlightMs = Number(session.lastSentVideoPts! - session.lastAckPts!) / 1000;
    expect(inFlightMs).toBeGreaterThanOrEqual(1900);
    expect(inFlightMs).toBeLessThanOrEqual(2100);

    // キューにはまだ約240フレーム残っていること
    expect(session.playbackQueue.length).toBeGreaterThanOrEqual(230);

    handler.close();
    vi.useRealTimers();
  });

  it('should clamp targetBufferMs to [0, 30000] and preserve 0 across reconnects in BUFFER_FEEDBACK', async () => {
    const handler = new WebSocketHandler(mockAuth, mockBrowser, mockEncoder, mockInput, mockConfig);

    const socket1: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket1);
    const msgListener1 = socket1.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];
    const closeListener1 = socket1.on.mock.calls.find((c: any[]) => c[0] === 'close')?.[1];

    await msgListener1(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));
    const session1 = handler.getClientSession(socket1)!;

    // 1. Upper clamp: 45000 -> 30000
    await msgListener1(
      Buffer.concat([
        Buffer.from([WSS_CHANNEL.COMMAND]),
        Buffer.from(
          JSON.stringify({ type: 'BUFFER_FEEDBACK', bufferedMs: 0, targetBufferMs: 45000 }),
        ),
      ]),
    );
    expect(session1.targetBufferMs).toBe(30000);

    // 2. Lower clamp: -500 -> 0
    await msgListener1(
      Buffer.concat([
        Buffer.from([WSS_CHANNEL.COMMAND]),
        Buffer.from(
          JSON.stringify({ type: 'BUFFER_FEEDBACK', bufferedMs: -10, targetBufferMs: -500 }),
        ),
      ]),
    );
    expect(session1.bufferedMs).toBe(0);
    expect(session1.targetBufferMs).toBe(0);

    // 3. Reconnect preserves 0 instead of falling back to 10000
    closeListener1();
    const socket2: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket2);
    const session2 = handler.getClientSession(socket2)!;
    expect(session2.targetBufferMs).toBe(0);

    handler.close();
  });

  it('should retain >3300 frames in CATCHUP playbackQueue for 30s at 60fps + 50pps audio without truncating at 3000', async () => {
    vi.useFakeTimers();
    const playbackBuffer = new PlaybackBuffer({ bufferSeconds: 60 });
    playbackBuffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1_000_000n, Buffer.alloc(100));

    const handler = new WebSocketHandler(
      mockAuth,
      mockBrowser,
      mockEncoder,
      mockInput,
      mockConfig,
      playbackBuffer,
    );
    handler.setLastInputAt(Date.now() - 10000);

    const socket: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket);
    const msgListener = socket.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];
    const session = handler.getClientSession(socket)!;
    session.lastAckPts = 1_000_000n;

    await msgListener(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));

    // Force flow-paused CATCHUP with 30s target so incoming frames accumulate in playbackQueue
    session.mode = 'CATCHUP';
    session.targetBufferMs = 30000;
    session.bufferedMs = 30000;
    session.isFlowPaused = true;

    const videoCb = mockEncoder.on.mock.calls.find((c: any[]) => c[0] === 'video')?.[1];
    const audioCb = mockEncoder.on.mock.calls.find((c: any[]) => c[0] === 'audio')?.[1];

    // Push 30s of 60fps video (1800) + 50pps audio (1500) = 3300 frames (+ initial 1 = 3301)
    for (let i = 1; i <= 1800; i++) {
      const flags = i % 120 === 0 ? VIDEO_FLAGS.KEYFRAME : 0;
      videoCb({ flags, pts: 1_000_000n + BigInt(i) * 16667n, data: Buffer.alloc(64) });
    }
    for (let i = 1; i <= 1500; i++) {
      audioCb({
        flags: AUDIO_FLAGS.KEYFRAME,
        pts: 1_000_000n + BigInt(i) * 20000n,
        data: Buffer.alloc(32),
      });
    }

    expect(session.playbackQueue.length).toBeGreaterThanOrEqual(3300);

    handler.close();
    vi.useRealTimers();
  });

  it('should clear PlaybackBuffer when auto-sleep triggers', () => {
    vi.useFakeTimers();
    const playbackBuffer = new PlaybackBuffer({ bufferSeconds: 60 });
    playbackBuffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1_000_000n, Buffer.alloc(100));
    playbackBuffer.addAudio(AUDIO_FLAGS.KEYFRAME, 1_000_000n, Buffer.alloc(50));
    expect(playbackBuffer.getVideoCount()).toBe(1);

    const handler = new WebSocketHandler(
      mockAuth,
      mockBrowser,
      mockEncoder,
      mockInput,
      mockConfig,
      playbackBuffer,
    );

    // Default autoSleepMinutes in mockConfig (check: 3 mins = 180s)
    vi.advanceTimersByTime(4 * 60 * 1000);

    expect(mockEncoder.stop).toHaveBeenCalled();
    expect(mockBrowser.pause).toHaveBeenCalled();
    expect(playbackBuffer.getVideoCount()).toBe(0);
    expect(playbackBuffer.getAudioCount()).toBe(0);

    handler.close();
    vi.useRealTimers();
  });

  // ---- 2026-11-25 モバイル回線インシデント対応 (Issues #103/#104/#106/#107) ----

  it('Issue #106: BUFFER_FEEDBACK の audioBufferedMs を保存し In-Flight 窓計算に反映する（旧クライアント非送信時は従来動作）', async () => {
    const handler = new WebSocketHandler(mockAuth, mockBrowser, mockEncoder, mockInput, mockConfig);

    const mockSocket: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(mockSocket);
    const messageListener = mockSocket.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];

    const authBuf = Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]);
    await messageListener(authBuf);

    const session = (handler as any).clientSessions.get(mockSocket);

    const fbBuf = Buffer.concat([
      Buffer.from([WSS_CHANNEL.COMMAND]),
      Buffer.from(
        JSON.stringify({
          type: 'BUFFER_FEEDBACK',
          bufferedMs: 500,
          audioBufferedMs: 12000,
          targetBufferMs: 10000,
        }),
      ),
    ]);
    await messageListener(fbBuf);

    expect(session.audioBufferedMs).toBe(12000);
    // 映像経路の報告 (500ms) より音声滞留 (12000ms) の方が大きい → 実滞留として 12000 を採用
    expect((handler as any).getClientInFlightBufferMs(session)).toBe(12000);

    // 旧クライアント（フィールドなし）→ 0 にリセットされ従来動作へ戻る
    const legacyBuf = Buffer.concat([
      Buffer.from([WSS_CHANNEL.COMMAND]),
      Buffer.from(
        JSON.stringify({ type: 'BUFFER_FEEDBACK', bufferedMs: 700, targetBufferMs: 10000 }),
      ),
    ]);
    await messageListener(legacyBuf);
    expect(session.audioBufferedMs).toBe(0);
    expect((handler as any).getClientInFlightBufferMs(session)).toBe(700);

    handler.close();
  });

  it('Issue #104: ACK 進行度から実効排水レートを推定し、低速リンクでは CATCHUP 窓を縮め、健全リンクでは従来窓を維持する', () => {
    const handler = new WebSocketHandler(mockAuth, mockBrowser, mockEncoder, mockInput, mockConfig);

    const session: any = {
      socket: { readyState: 3 },
      playbackQueue: [],
      mode: 'CATCHUP',
      pacingTimer: null,
      lastAckPts: null,
      targetBufferMs: 10000,
    };

    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      (handler as any).observeAckProgress(session, 0n);
      // 実時間1秒でメディア500ms分しか再生進行しなかった = 0.5x 排水
      vi.advanceTimersByTime(1000);
      (handler as any).observeAckProgress(session, 500000n);
      expect(session.ackDrainRateEwma).toBeCloseTo(0.5);

      // 0.5x 排水 → 窓は target*rate = 5000ms へ縮小（中間バッファへの詰め込み抑制）
      expect((handler as any).effectiveCatchupWindowMs(session)).toBe(5000);

      // 下限 2500ms を割らない
      session.ackDrainRateEwma = 0.1;
      expect((handler as any).effectiveCatchupWindowMs(session)).toBe(2500);

      // 健全リンク (>= 0.85x) は従来窓のまま（非回帰）
      session.ackDrainRateEwma = 1.2;
      expect((handler as any).effectiveCatchupWindowMs(session)).toBe(10000);

      // サンプルなし（新機能導入直後・旧クライアント）も従来窓
      session.ackDrainRateEwma = undefined;
      expect((handler as any).effectiveCatchupWindowMs(session)).toBe(10000);
    } finally {
      vi.useRealTimers();
    }

    handler.close();
  });

  it('Issue #104: ストリーム再構築で PTS が再基準化されたら排水レートの基準と EWMA を再初期化する', () => {
    const handler = new WebSocketHandler(mockAuth, mockBrowser, mockEncoder, mockInput, mockConfig);

    const session: any = {
      socket: { readyState: 3 },
      playbackQueue: [],
      mode: 'CATCHUP',
      pacingTimer: null,
      lastAckPts: null,
      targetBufferMs: 10000,
    };

    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      (handler as any).observeAckProgress(session, 0n);
      vi.advanceTimersByTime(1000);
      (handler as any).observeAckProgress(session, 500000n); // 0.5x 排水
      expect((handler as any).effectiveCatchupWindowMs(session)).toBe(5000);

      // 再エンコード等で PTS が逆行 → 基準点と EWMA をクリアし、保守的に従来窓へ戻す
      vi.advanceTimersByTime(1000);
      (handler as any).observeAckProgress(session, 100000n);
      expect(session.ackDrainRateEwma).toBeUndefined();
      expect((handler as any).effectiveCatchupWindowMs(session)).toBe(10000);

      // 再基準化後も追従が再開されている（1秒で500ms分 = 0.5x）
      vi.advanceTimersByTime(1000);
      (handler as any).observeAckProgress(session, 600000n);
      expect(session.ackDrainRateEwma).toBeCloseTo(0.5);
      expect((handler as any).effectiveCatchupWindowMs(session)).toBe(5000);
    } finally {
      vi.useRealTimers();
    }

    handler.close();
  });

  it('Issue #104: 250ms 未満の短間隔サンプルと 5秒超の無通信ギャップは排水レートに混入しない', () => {
    const handler = new WebSocketHandler(mockAuth, mockBrowser, mockEncoder, mockInput, mockConfig);

    const session: any = {
      socket: { readyState: 3 },
      playbackQueue: [],
      mode: 'CATCHUP',
      pacingTimer: null,
      lastAckPts: null,
      targetBufferMs: 10000,
    };

    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      (handler as any).observeAckProgress(session, 0n);
      // ACK と BUFFER_FEEDBACK が 100ms 間隔で連続到着した状況（33ms 進行）
      vi.advanceTimersByTime(100);
      (handler as any).observeAckProgress(session, 33000n);
      expect(session.ackDrainRateEwma).toBeUndefined(); // 分母を 50ms 等に底上げして計測しない

      // 400ms の窓が溜まった時点で正しく 0.5x を推定する
      vi.advanceTimersByTime(300);
      (handler as any).observeAckProgress(session, 200000n);
      expect(session.ackDrainRateEwma).toBeCloseTo(0.5);

      // 10秒間の無通信・一時停止明けに1フレーム分だけ進んでも 0.003x で汚染しない
      vi.advanceTimersByTime(10000);
      (handler as any).observeAckProgress(session, 233000n);
      expect(session.ackDrainRateEwma).toBeCloseTo(0.5);
    } finally {
      vi.useRealTimers();
    }

    handler.close();
  });

  it('Issue #104: LIVE ジャンプによる PTS 不連続跳躍は排水レートを汚染しない（基準点のみ再初期化・EWMA 保持）', () => {
    const handler = new WebSocketHandler(mockAuth, mockBrowser, mockEncoder, mockInput, mockConfig);

    const session: any = {
      socket: { readyState: 3 },
      playbackQueue: [],
      mode: 'CATCHUP',
      pacingTimer: null,
      lastAckPts: null,
      targetBufferMs: 10000,
    };

    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      (handler as any).observeAckProgress(session, 0n);
      vi.advanceTimersByTime(1000);
      (handler as any).observeAckProgress(session, 500000n); // 0.5x 排水を学習
      expect(session.ackDrainRateEwma).toBeCloseTo(0.5);

      // LIVE ジャンプ（CATCHUP 中断経由）で基準点のみ再初期化され、学習値は保持される
      (handler as any).abortCatchupAndSwitchToLive(session);
      expect(session.lastAckProgressPts).toBeUndefined();
      expect(session.ackDrainRateEwma).toBeCloseTo(0.5);

      // ジャンプで再生位置が 30 秒先へ飛んでも、その跳躍自体はレートに混ぜない
      vi.advanceTimersByTime(100);
      (handler as any).observeAckProgress(session, 30_500_000n);
      expect(session.ackDrainRateEwma).toBeCloseTo(0.5);

      // 跳躍後の正常な低速進行（1秒で500ms分）は引き続き 0.5x のまま
      vi.advanceTimersByTime(1000);
      (handler as any).observeAckProgress(session, 31_000_000n);
      expect(session.ackDrainRateEwma).toBeCloseTo(0.5);
      expect((handler as any).effectiveCatchupWindowMs(session)).toBe(5000);
    } finally {
      vi.useRealTimers();
    }

    handler.close();
  });

  it('Issue #104 & Issue #26: 25秒トンネル復旧（MCU2 2秒バッファ含む）は無欠落で保護し、30秒超の無限バックログのみ間引く', () => {
    const handler = new WebSocketHandler(mockAuth, mockBrowser, mockEncoder, mockInput, mockConfig);

    // 1. Issue #26 非回帰: 25秒分の映像フレーム（2秒間隔キーフレーム、targetBufferMs=2000 の MCU2 設定）
    const tunnelFrames: any[] = [];
    for (let i = 0; i <= 250; i++) {
      tunnelFrames.push({
        type: 'video',
        flags: i % 20 === 0 ? VIDEO_FLAGS.KEYFRAME : 0,
        pts: BigInt(i * 100000),
        data: Buffer.alloc(16),
      });
    }
    const mcu2Session: any = {
      socket: { readyState: 3 },
      playbackQueue: tunnelFrames,
      mode: 'CATCHUP',
      pacingTimer: null,
      targetBufferMs: 2000, // cap = max(2*2000, 30000) = 30000ms → 25秒は一切間引かれない
    };
    (handler as any).enforceCatchupBacklogCap(mcu2Session);
    expect(mcu2Session.playbackQueue.length).toBe(251);

    // 2. 40秒分のバックログ（10秒地点に次のキーフレーム）→ cap 30秒を超過するため最古 GOP を間引く
    const frames: any[] = [];
    for (let i = 0; i <= 400; i++) {
      frames.push({
        type: 'video',
        flags: i === 100 ? VIDEO_FLAGS.KEYFRAME : 0,
        pts: BigInt(i * 100000),
        data: Buffer.alloc(16),
      });
    }
    const session: any = {
      socket: { readyState: 3 },
      playbackQueue: frames,
      mode: 'CATCHUP',
      pacingTimer: null,
      targetBufferMs: 10000, // cap = max(2*10000, 30000) = 30000ms
    };

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      (handler as any).enforceCatchupBacklogCap(session);
      // ギャップ間引き: キューは次キーフレーム (pts=10s) から開始 → 残存スパン 30秒 = 上限ちょうど
      expect(session.playbackQueue[0].flags & VIDEO_FLAGS.KEYFRAME).toBeTruthy();
      expect(session.playbackQueue[0].pts).toBe(10_000_000n);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Pruned oldest GOP'));

      // 上限内ではこれ以上間引かない
      const len = session.playbackQueue.length;
      (handler as any).enforceCatchupBacklogCap(session);
      expect(session.playbackQueue.length).toBe(len);

      // 3. 次キーフレーム不在で間引き不能のときは虚偽の Pruned ログを出さない
      logSpy.mockClear();
      const singleGopFrames = Array.from({ length: 350 }, (_, i) => ({
        type: 'video',
        flags: i === 0 ? VIDEO_FLAGS.KEYFRAME : 0,
        pts: BigInt(i * 100000),
        data: Buffer.alloc(16),
      }));
      const singleGopSession: any = {
        socket: { readyState: 3 },
        playbackQueue: singleGopFrames,
        mode: 'CATCHUP',
        pacingTimer: null,
        targetBufferMs: 10000,
      };
      (handler as any).enforceCatchupBacklogCap(singleGopSession);
      expect(singleGopSession.playbackQueue.length).toBe(350);
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Pruned oldest GOP'));
    } finally {
      logSpy.mockRestore();
    }

    handler.close();
  });

  it('Issue #104: 輻輳検知時は CATCHUP ソケットガードを 32〜64KB へ縮小しバースト間隔を 10ms へ緩和する（健全時は 128KB/2ms 維持）', () => {
    vi.useFakeTimers();
    const handler = new WebSocketHandler(mockAuth, mockBrowser, mockEncoder, mockInput, mockConfig);
    try {
      const mockSocket: any = { readyState: 1, bufferedAmount: 0, send: vi.fn() };
      const session: any = {
        socket: mockSocket,
        playbackQueue: [
          { type: 'video', flags: VIDEO_FLAGS.KEYFRAME, pts: 1_000_000n, data: Buffer.alloc(8) },
          { type: 'video', flags: 0, pts: 1_033_000n, data: Buffer.alloc(8) },
        ],
        mode: 'CATCHUP',
        pacingTimer: null,
        lastAckPts: 1_000_000n,
        lastSentVideoPts: 1_000_000n,
        targetBufferMs: 10000,
        isBurstMode: true,
      };

      // 健全時: 128KB ガード
      expect((handler as any).getEffectiveCatchupSocketGuardBytes(session)).toBe(128 * 1024);

      // 80KB 滞留は健全時ガード(128KB)未満だが、低排水レート学習後は縮小ガード(32KB)超過で一時停止する
      session.ackDrainRateEwma = 0.5;
      expect((handler as any).getEffectiveCatchupSocketGuardBytes(session)).toBe(32 * 1024);
      mockSocket.bufferedAmount = 80 * 1024;
      (handler as any).scheduleNextCatchupFrame(session);
      expect(session.isFlowPaused).toBe(true);
      expect(mockSocket.send).not.toHaveBeenCalled();

      // 滞留解消時は送信するが、輻輳モード中のバーストタイマーは 10ms に緩和されている
      if (session.pacingTimer) {
        clearTimeout(session.pacingTimer);
        session.pacingTimer = null;
      }
      mockSocket.bufferedAmount = 0;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      (handler as any).scheduleNextCatchupFrame(session);
      expect(mockSocket.send).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10);
      setTimeoutSpy.mockRestore();
    } finally {
      handler.close();
      vi.useRealTimers();
    }
  });

  it('Issue #103: JUMP_TO_LIVE は二重実行せず、TOUCH Auto-Hybrid でも LIVE_JUMPED(dropAudioBeforePts) を送出する', async () => {
    vi.useFakeTimers();
    const playbackBuffer = new PlaybackBuffer({ bufferSeconds: 10 });
    playbackBuffer.addVideo(VIDEO_FLAGS.KEYFRAME, 1_000_000n, Buffer.alloc(100));
    playbackBuffer.addVideo(0, 1_033_000n, Buffer.alloc(100));
    mockEncoder.getCurrentPts = vi.fn(() => 9_876_543n);

    const handler = new WebSocketHandler(
      mockAuth,
      mockBrowser,
      mockEncoder,
      mockInput,
      mockConfig,
      playbackBuffer,
    );
    handler.setLastInputAt(Date.now() - 10000);

    const socket1: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket1);
    const msg1 = socket1.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];
    const s1 = handler.getClientSession(socket1)!;
    s1.lastAckPts = 1_000_000n;
    await msg1(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));
    expect(s1.mode).toBe('CATCHUP');

    // 1. JUMP_TO_LIVE 実行時: sendCachedKeyframeAndConfig（VIDEO_FLAGS.CONFIG）が1回だけ送られる（二重実行なし）
    socket1.send.mockClear();
    await msg1(
      Buffer.concat([
        Buffer.from([WSS_CHANNEL.COMMAND]),
        Buffer.from(JSON.stringify({ type: 'JUMP_TO_LIVE' })),
      ]),
    );
    const configSends = socket1.send.mock.calls.filter(
      (c: any[]) =>
        Buffer.isBuffer(c[0]) &&
        c[0][0] === WSS_CHANNEL.VIDEO &&
        (c[0][1] & VIDEO_FLAGS.CONFIG) !== 0,
    );
    expect(configSends.length).toBe(1);

    // 2. TOUCH Auto-Hybrid 時も操作元クライアントへ LIVE_JUMPED (dropAudioBeforePts付き) を送出する
    s1.mode = 'CATCHUP';
    s1.playbackQueue = [{ type: 'video', flags: 0, pts: 1_066_000n, data: Buffer.alloc(16) }];
    socket1.send.mockClear();
    const touchBuf = Buffer.alloc(33);
    touchBuf[0] = WSS_CHANNEL.TOUCH;
    await msg1(touchBuf);

    const controlMsgs = socket1.send.mock.calls
      .filter((c: any[]) => Buffer.isBuffer(c[0]) && c[0][0] === WSS_CHANNEL.CONTROL_RESPONSE)
      .map((c: any[]) => JSON.parse(c[0].subarray(1).toString('utf-8')));
    expect(
      controlMsgs.some((m: any) => m.type === 'LIVE_JUMPED' && m.dropAudioBeforePts === 9876543),
    ).toBe(true);

    handler.close();
    vi.useRealTimers();
  });

  it('Issue #107: CATCHUP 開始ログに実効 targetBufferMs・effectiveWindowMs・socketGuardKB・バーストモードを併記する', () => {
    const handler = new WebSocketHandler(mockAuth, mockBrowser, mockEncoder, mockInput, mockConfig);

    const session: any = {
      socket: { readyState: 3 }, // CONFIG 送出とペーシングループはスキップし、ログのみ検証
      playbackQueue: [],
      mode: 'LIVE',
      pacingTimer: null,
      lastAckPts: null,
      targetBufferMs: 8000,
    };
    const frames = [
      { type: 'video', flags: VIDEO_FLAGS.KEYFRAME, pts: 1_000_000n, data: Buffer.alloc(8) },
    ];

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      (handler as any).startCatchup(session, { frames });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('CATCHUP pacing started'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('targetBufferMs=8000'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('effectiveWindowMs=8000'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('socketGuardKB=128'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('burst=true'));
    } finally {
      logSpy.mockRestore();
    }

    handler.close();
  });
});
