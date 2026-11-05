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
});
