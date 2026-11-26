import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackBuffer } from '../src/encoder/playback-buffer.js';
import { WebSocketHandler } from '../src/ws/handler.js';
import { WSS_CHANNEL } from '../src/ws/protocol.js';

/**
 * Issue #115 実機続報: HOLD 復帰後の音声先行 ~1965ms 平衡に対し、クライアント局所
 * トリムは GOP 格子 (2.0s) の手前までしか切れず no-op 率 98% を実測。検知時にサーバーへ
 * FORCE_VIDEO_IDR を要求し、**映像のみ**のクローズド再起動 (ライブエッジ新規 IDR、
 * resize と同一の実証済み経路 / 音声プロセスは完全不変) を行うサーバー側の受け入れ基準。
 */
describe('WebSocketHandler FORCE_VIDEO_IDR (Issue #115)', () => {
  let mockAuth: any;
  let mockBrowser: any;
  let mockEncoder: any;
  let mockInput: any;
  let mockConfig: any;

  beforeEach(() => {
    vi.useFakeTimers();
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
      pauseForBufferHold: vi.fn(),
      resumeFromBufferHold: vi.fn(),
      isBufferHoldPaused: vi.fn(() => false),
      navigate: vi.fn().mockResolvedValue(undefined),
      isChromeAlive: () => true,
    };

    mockEncoder = {
      isRunning: vi.fn(() => true),
      isFullyRunning: vi.fn(() => true),
      start: vi.fn(),
      stop: vi.fn(),
      // 映像のみ再起動する実挙動 (音声は完全不変)。resize と同一の restart() 経路。
      restart: vi.fn().mockResolvedValue(undefined),
      restartAll: vi.fn().mockResolvedValue(undefined),
      noteHoldPause: vi.fn(),
      noteHoldResume: vi.fn(),
      resetHoldCompensation: vi.fn(),
      isHoldPaused: vi.fn(() => false),
      armResumeGate: vi.fn(),
      getCurrentPts: vi.fn(() => 7_000_000n),
      setResumeBoundary: vi.fn(),
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

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const connectAuthenticated = async (handler: WebSocketHandler) => {
    const socket: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket);
    const msgListener = socket.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];
    await msgListener(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));
    return { socket, msgListener };
  };

  const sendCommand = async (msgListener: any, payload: any) => {
    await msgListener(
      Buffer.concat([Buffer.from([WSS_CHANNEL.COMMAND]), Buffer.from(JSON.stringify(payload))]),
    );
  };

  const buildHandler = () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 60 });
    return new WebSocketHandler(mockAuth, mockBrowser, mockEncoder, mockInput, mockConfig, buffer);
  };

  it('restarts the video encoder only (audio untouched) and arms the audio boundary gate', async () => {
    const handler = buildHandler();
    const { socket, msgListener } = await connectAuthenticated(handler);

    // セッション送信キューに古いフレームを意図的に残した状態で要求する
    const session: any = (handler as any).clientSessions.get(socket);
    expect(session).toBeTruthy();
    session.playbackQueue.push({ data: Buffer.from([1]), pts: 1000n, flags: 0 });

    await sendCommand(msgListener, { type: 'FORCE_VIDEO_IDR' });

    // 映像のみ: restart() は呼ばれるが restartAll() (音声込み全再起動) は呼ばれない
    expect(mockEncoder.restart).toHaveBeenCalledTimes(1);
    expect(mockEncoder.restartAll).not.toHaveBeenCalled();
    // 新 IDR より古い音声 straggler をサーバー側で破棄する境界ゲートが武装される
    expect(mockEncoder.armResumeGate).toHaveBeenCalledTimes(1);
    // 送信待ちの古い映像キューはクリアされ、ライブエッジからの再送になる
    expect(session.playbackQueue.length).toBe(0);
  });

  it('rate-limits forced restarts to one per cooldown window (5s)', async () => {
    const handler = buildHandler();
    const { socket, msgListener } = await connectAuthenticated(handler);

    await sendCommand(msgListener, { type: 'FORCE_VIDEO_IDR' });
    await sendCommand(msgListener, { type: 'FORCE_VIDEO_IDR' });
    expect(mockEncoder.restart).toHaveBeenCalledTimes(1);

    // クーダウン経過後は再度要求できる (ペーサー側の 1回/秒 レート制限と二重に守る)
    vi.advanceTimersByTime(WebSocketHandler.FORCED_IDR_COOLDOWN_MS + 1_000);
    await sendCommand(msgListener, { type: 'FORCE_VIDEO_IDR' });
    expect(mockEncoder.restart).toHaveBeenCalledTimes(2);
  });

  it('during BUFFER_HOLD_PAUSED releases the hold instead of double-restarting encoders', async () => {
    const handler = buildHandler();
    const { socket, msgListener } = await connectAuthenticated(handler);

    // Hold 中は exitBufferHold 自体が FFmpeg 両系統の新規起動 (= ライブエッジ IDR) を伴う。
    // そこへ restart() を重ねると二重起動になるため、Hold 解除のみを行う。
    (handler as any).pipelineHoldState = 'BUFFER_HOLD_PAUSED';
    (handler as any).holdStartedAtMs = Date.now();

    await sendCommand(msgListener, { type: 'FORCE_VIDEO_IDR' });

    expect(mockEncoder.noteHoldResume).toHaveBeenCalledTimes(1); // exitBufferHold の再開経路
    expect(mockEncoder.restart).not.toHaveBeenCalled();
    expect((handler as any).pipelineHoldState).toBe('ACTIVE');
  });
});
