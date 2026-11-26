import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackBuffer } from '../src/encoder/playback-buffer.js';
import { WebSocketHandler } from '../src/ws/handler.js';
import { VIDEO_FLAGS, WSS_CHANNEL } from '../src/ws/protocol.js';

/**
 * Issue #111 Buffer-Hold Pause Phase 1 の回帰ガード。
 * - 不変条件: holdTrigger − resume ≥ 7.2s / target=0 は Hold 無効 / CATCHUP 実効窓下限 400ms
 * - ケースB (CATCHUP 滞留・切断中蓄積) での自動一時停止 → ack 追い上げで自動再開
 * - 割り込み意味: JUMP_TO_LIVE / 手動 PAUSE_BROWSER / holdExpire → スリープへの排他変換
 * - 再接続 resumeFromPts クランプ (ack 陳腐化による backlog 恒久化の防止)
 */
describe('WebSocketHandler Buffer-Hold Pause (Issue #111)', () => {
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
      pauseForBufferHold: vi.fn(),
      resumeFromBufferHold: vi.fn(),
      isBufferHoldPaused: vi.fn(() => false),
      navigate: vi.fn().mockResolvedValue(undefined),
      isChromeAlive: () => true,
    };

    let videoRunning = true;
    let audioRunning = true;
    mockEncoder = {
      isRunning: vi.fn(() => videoRunning || audioRunning),
      isFullyRunning: vi.fn(() => videoRunning && audioRunning),
      start: vi.fn(() => {
        videoRunning = true;
        audioRunning = true;
      }),
      stop: vi.fn(() => {
        videoRunning = false;
        audioRunning = false;
      }),
      restart: vi.fn().mockImplementation(async () => {
        // Video のみ再起動する実挙動を再現 (Audio は起動しない)
        videoRunning = true;
      }),
      restartAll: vi.fn().mockImplementation(async () => {
        videoRunning = true;
        audioRunning = true;
      }),
      noteHoldPause: vi.fn(),
      noteHoldResume: vi.fn(),
      resetHoldCompensation: vi.fn(),
      isHoldPaused: vi.fn(() => false),
      armResumeGate: vi.fn(),
      // Issue #111 F-4: JUMP 系の LIVE 境界で音声破棄境界を権威 PTS に設定する配線を検証する
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

    delete process.env.BUFFER_HOLD_EXPIRE_MINUTES;
  });

  const connectAuthenticated = async (handler: WebSocketHandler) => {
    const socket: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(socket);
    const msgListener = socket.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];
    await msgListener(Buffer.concat([Buffer.from([WSS_CHANNEL.AUTH]), Buffer.from('1234')]));
    return { socket, msgListener };
  };

  const sendAck = async (msgListener: any, pts: number) => {
    await msgListener(
      Buffer.concat([
        Buffer.from([WSS_CHANNEL.COMMAND]),
        Buffer.from(JSON.stringify({ type: 'ACK', pts })),
      ]),
    );
  };

  const sentControls = (socket: any): any[] =>
    socket.send.mock.calls
      .map((call: any[]) => call[0] as Buffer)
      .filter((buf: Buffer) => buf[0] === WSS_CHANNEL.CONTROL_RESPONSE)
      .map((buf: Buffer) => JSON.parse(buf.subarray(1).toString('utf-8')));

  const sentVideoPts = (socket: any): bigint[] =>
    socket.send.mock.calls
      .map((call: any[]) => call[0] as Buffer)
      .filter((buf: Buffer) => buf[0] === WSS_CHANNEL.VIDEO)
      .map((buf: Buffer) => buf.readBigInt64BE(2));

  const buildHandler = (playbackBuffer: PlaybackBuffer, videoEvents: any[] = []) => {
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
    for (const ev of videoEvents) {
      videoListener!(ev);
    }
    return { handler, emitVideo: (ev: any) => videoListener!(ev) };
  };

  it('should keep hold threshold invariants and disable hold when targetBufferMs=0', () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 60 });
    const { handler } = buildHandler(buffer);

    // 既定 (target=10s, VAAPI HEADROOM=2s): holdTrigger=10s, resume=500ms → 幅 9.5s ≥ 7.2s
    const cfgDefault = (handler as any).computeHoldConfig();
    expect(cfgDefault).toEqual({ holdTriggerMs: 10000, resumeTriggerServerMs: 500 });
    expect(cfgDefault.holdTriggerMs - cfgDefault.resumeTriggerServerMs).toBeGreaterThanOrEqual(
      7200,
    );

    // target=30s (最大): holdTrigger=30s、resume は 500ms 下限へクランプされ不変条件を維持
    (handler as any).lastKnownTargetBufferMs = 30000;
    const cfgMax = (handler as any).computeHoldConfig();
    expect(cfgMax.holdTriggerMs).toBe(30000);
    expect(cfgMax.resumeTriggerServerMs).toBeGreaterThanOrEqual(500);
    expect(cfgMax.holdTriggerMs - cfgMax.resumeTriggerServerMs).toBeGreaterThanOrEqual(7200);

    // target=0 (バッファオフ): Hold 無効 + CATCHUP 実効窓は 400ms 下限で永久閉鎖しない
    (handler as any).lastKnownTargetBufferMs = 0;
    expect((handler as any).computeHoldConfig()).toBeNull();
    const session: any = {};
    expect((handler as any).effectiveCatchupWindowMs(session)).toBeGreaterThanOrEqual(400);

    handler.close();
  });

  it('should pause generation when server-held backlog exceeds holdTrigger and auto-resume when ack drains it', async () => {
    vi.useFakeTimers();
    try {
      const buffer = new PlaybackBuffer({ bufferSeconds: 60 });
      buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 0n, Buffer.from('v0'));

      const { handler, emitVideo } = buildHandler(buffer);
      const { socket, msgListener } = await connectAuthenticated(handler);
      await sendAck(msgListener, 0);

      // 生成を進めるが ack は 0 のまま → serverHeldMs 15s ≥ holdTrigger 10s で Hold 発動
      // (評価フックは1秒間隔のスロットルを持つため、単一の生成イベントで十分)
      emitVideo({ flags: 0, pts: 15_033_000n, data: Buffer.from('v') });

      expect(mockEncoder.noteHoldPause).toHaveBeenCalledTimes(1);
      expect(mockEncoder.stop).toHaveBeenCalled();
      expect(mockBrowser.pauseForBufferHold).toHaveBeenCalledTimes(1);
      expect(mockBrowser.pause).not.toHaveBeenCalled(); // スリープ (SLEEP_PAUSED) とは別状態
      const holdOn = sentControls(socket).filter(
        (c) => c.type === 'BUFFER_HOLD' && c.paused === true,
      );
      expect(holdOn.length).toBe(1);
      expect(holdOn[0].holdTriggerMs).toBe(10000);

      // 消費 (ack) が追い付かない限り polls では再開しない
      vi.advanceTimersByTime(3000);
      expect(mockEncoder.noteHoldResume).not.toHaveBeenCalled();

      // ack が resumeTrigger (500ms) 内まで到達 → 自動再開 (SIGCONT + FFmpeg restart + A/Vゲート)
      await sendAck(msgListener, 14_600_000);
      vi.advanceTimersByTime(600);

      expect(mockEncoder.noteHoldResume).toHaveBeenCalledTimes(1);
      expect(mockEncoder.armResumeGate).toHaveBeenCalledWith(8000);
      expect(mockEncoder.start).toHaveBeenCalled();
      expect(mockBrowser.resumeFromBufferHold).toHaveBeenCalledTimes(1);
      const holdOff = sentControls(socket).filter(
        (c) => c.type === 'BUFFER_HOLD' && c.paused === false,
      );
      expect(holdOff.length).toBe(1);

      handler.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should clamp stale reconnect ack to resumeFromPts = latestBuffered - holdTriggerMs (F-3)', async () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 60 });
    // GOP1: key@2s, GOP2: key@10s, delta...20s。切断中に ack=2s が陳腐化した状態を再現
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 2_000_000n, Buffer.from('k2'));
    buffer.addVideo(0, 5_000_000n, Buffer.from('d5'));
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 10_000_000n, Buffer.from('k10'));
    buffer.addVideo(0, 20_000_000n, Buffer.from('d20'));

    const { handler } = buildHandler(buffer);

    // socket1: ack=2s で接続→切断
    const { socket: socket1, msgListener: msg1 } = await connectAuthenticated(handler);
    await sendAck(msg1, 2_000_000);
    const close1 = socket1.on.mock.calls.find((c: any[]) => c[0] === 'close')?.[1];
    close1();

    // idle (>5s) 後に再接続 → CATCHUP だが resumeFromPts = 20s − 10s = 10s へクランプ
    handler.setLastInputAt(Date.now() - 10_000);
    const { socket: socket2 } = await connectAuthenticated(handler);

    const session2 = handler.getClientSession(socket2);
    expect(session2).toBeDefined();
    expect(session2!.mode).toBe('CATCHUP');

    // F-3 非回帰: 再生開始 backlog は holdTrigger (10s) 以下。先頭映像フレームは key@10s
    const videoPts = sentVideoPts(socket2).filter((p) => p !== 0n);
    expect(videoPts.length).toBeGreaterThan(0);
    expect(videoPts[0]).toBe(10_000_000n);

    handler.close();
  });

  it('should not resume browser/encoder on reconnect while BUFFER_HOLD_PAUSED', async () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 60 });
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 2_000_000n, Buffer.from('k2'));
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 10_000_000n, Buffer.from('k10'));
    buffer.addVideo(0, 20_000_000n, Buffer.from('d20'));

    let videoListener: ((data: any) => void) | null = null;
    mockEncoder.on = vi.fn((event: string, cb: any) => {
      if (event === 'video') videoListener = cb;
    });
    mockBrowser.getState = () => 'paused'; // Hold 復帰処理が呼ばれていないことの検出用 sentinel
    const handler = new WebSocketHandler(
      mockAuth,
      mockBrowser,
      mockEncoder,
      mockInput,
      mockConfig,
      buffer,
    );

    const { socket, msgListener } = await connectAuthenticated(handler);
    await sendAck(msgListener, 2_000_000);
    videoListener!({ flags: 0, pts: 15_033_000n, data: Buffer.from('v') });
    expect(mockEncoder.noteHoldPause).toHaveBeenCalledTimes(1);

    // Hold 中の再接続 (idle → CATCHUP): browser.resume / encoder.start を呼ばない
    const closeListener = socket.on.mock.calls.find((c: any[]) => c[0] === 'close')?.[1];
    closeListener();
    void msgListener;
    const before = {
      resume: mockBrowser.resume.mock.calls.length,
      start: mockEncoder.start.mock.calls.length,
    };
    handler.setLastInputAt(Date.now() - 10_000);
    const { socket: socket2 } = await connectAuthenticated(handler);
    expect(mockBrowser.resume.mock.calls.length).toBe(before.resume);
    expect(mockEncoder.start.mock.calls.length).toBe(before.start);
    expect(handler.getClientSession(socket2)!.mode).toBe('CATCHUP');

    // JUMP_TO_LIVE 割り込みで即時解除 → その経路でのみ再開される
    const msgListener2 = socket2.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];
    await msgListener2(
      Buffer.concat([
        Buffer.from([WSS_CHANNEL.COMMAND]),
        Buffer.from(JSON.stringify({ type: 'JUMP_TO_LIVE' })),
      ]),
    );
    expect(mockEncoder.noteHoldResume).toHaveBeenCalledTimes(1);
    expect(mockBrowser.resumeFromBufferHold).toHaveBeenCalledTimes(1);
    // Issue #111 F-4: JUMP 解除でも音声破棄境界をライブエッジへ張り直す (straggler 音声の残留防止)
    expect(mockEncoder.setResumeBoundary).toHaveBeenCalledWith(7000000n);

    handler.close();
  });

  it('should merge hold expiry into the common sleep flow (SLEEP_PAUSED) without resume churn', async () => {
    vi.useFakeTimers();
    try {
      process.env.BUFFER_HOLD_EXPIRE_MINUTES = '1';
      const buffer = new PlaybackBuffer({ bufferSeconds: 60 });
      buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 0n, Buffer.from('v0'));

      const { handler, emitVideo } = buildHandler(buffer);
      const { msgListener } = await connectAuthenticated(handler);
      await sendAck(msgListener, 0);
      emitVideo({ flags: 0, pts: 15_033_000n, data: Buffer.from('v') });
      expect(mockEncoder.noteHoldPause).toHaveBeenCalledTimes(1);

      // holdExpire (1分) まで追い上げなし → 共通スリープフローへ統合 (再開チャーンを経由しない)
      vi.advanceTimersByTime(61_000);
      expect(mockEncoder.noteHoldResume).not.toHaveBeenCalled();
      expect(mockBrowser.resumeFromBufferHold).not.toHaveBeenCalled();
      expect(mockBrowser.pauseForBufferHold).toHaveBeenCalledTimes(1);
      expect(mockBrowser.pause).toHaveBeenCalledTimes(1); // SLEEP_PAUSED 側 pause
      expect(buffer.getVideoCount()).toBe(0); // enterSleepPaused で playback buffer もクリア

      handler.close();
    } finally {
      delete process.env.BUFFER_HOLD_EXPIRE_MINUTES;
      vi.useRealTimers();
    }
  });

  it('should convert a manual PAUSE_BROWSER during hold to sleep without resume churn', async () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 60 });
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 0n, Buffer.from('v0'));

    const { handler, emitVideo } = buildHandler(buffer);
    const { socket, msgListener } = await connectAuthenticated(handler);

    // ack を保持したまま生成を進め Hold 発動 (ケースB)
    await sendAck(msgListener, 5_000_000);
    buffer.addVideo(0, 5_000_000n, Buffer.from('a5'));
    emitVideo({ flags: 0, pts: 20_033_000n, data: Buffer.from('v') });
    expect(mockEncoder.noteHoldPause).toHaveBeenCalledTimes(1);

    const startBefore = mockEncoder.start.mock.calls.length;
    await msgListener(
      Buffer.concat([
        Buffer.from([WSS_CHANNEL.COMMAND]),
        Buffer.from(JSON.stringify({ type: 'PAUSE_BROWSER' })),
      ]),
    );

    // 手動停止 = Hold→スリープの排他変換。SIGCONT + encoder.start の無駄なチャーンを挟まない
    expect(mockBrowser.resumeFromBufferHold).not.toHaveBeenCalled();
    expect(mockEncoder.noteHoldResume).not.toHaveBeenCalled();
    expect(mockEncoder.resetHoldCompensation).toHaveBeenCalledTimes(1);
    expect(mockEncoder.start.mock.calls.length).toBe(startBefore);
    expect(mockBrowser.pause).toHaveBeenCalledTimes(1);

    handler.close();
  });

  it('should release hold and start both video & audio when a new session connects during buffer-hold (prevent silent reconnect)', async () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 60 });
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 0n, Buffer.from('v0'));

    const { handler, emitVideo } = buildHandler(buffer);
    const { socket, msgListener } = await connectAuthenticated(handler);

    // 切断→10秒以上経過で Buffer-Hold Pause 発動 (Video/Audio 両停止 + Chrome SIGSTOP)
    await sendAck(msgListener, 0);
    const closeListener = socket.on.mock.calls.find((c: any[]) => c[0] === 'close')?.[1];
    closeListener();
    emitVideo({ flags: 0, pts: 15_000_000n, data: Buffer.from('v') });
    expect(mockEncoder.stop).toHaveBeenCalledTimes(1);
    expect(mockEncoder.isRunning()).toBe(false);
    expect(mockEncoder.isFullyRunning()).toBe(false);

    // 新セッション (別トークン) で再接続 → Hold 解除 & Video/Audio 両方起動されること (片肺無音にならない)
    mockAuth.verifyPin.mockResolvedValue({ success: true, token: 'new-session-token' });
    mockEncoder.start.mockClear();
    mockEncoder.restart.mockClear();
    await connectAuthenticated(handler);

    expect(mockBrowser.resumeFromBufferHold).toHaveBeenCalledTimes(1);
    expect(mockEncoder.resetHoldCompensation).toHaveBeenCalledTimes(1);
    expect(mockEncoder.start).toHaveBeenCalledTimes(1);
    expect(mockEncoder.isFullyRunning()).toBe(true);
    expect(mockEncoder.restart).not.toHaveBeenCalled(); // Video の二重起動なし

    handler.close();
  });

  it('should exit hold and start both video & audio when primary reconnect falls back to startLive (not idle)', async () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 60 });
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 0n, Buffer.from('v0'));

    const { handler, emitVideo } = buildHandler(buffer);
    const { socket, msgListener } = await connectAuthenticated(handler);

    await sendAck(msgListener, 0);
    const closeListener = socket.on.mock.calls.find((c: any[]) => c[0] === 'close')?.[1];
    closeListener();
    emitVideo({ flags: 0, pts: 15_000_000n, data: Buffer.from('v') });
    expect(mockEncoder.isFullyRunning()).toBe(false);

    // 操作直後 (isIdle=false) に同一トークンで再接続 → CATCHUP ではなく startLive 経路へ落ちる
    handler.setLastInputAt(Date.now());
    mockEncoder.start.mockClear();
    mockEncoder.restart.mockClear();
    await connectAuthenticated(handler);

    expect(mockBrowser.resumeFromBufferHold).toHaveBeenCalledTimes(1);
    expect(mockEncoder.noteHoldResume).toHaveBeenCalledTimes(1);
    expect(mockEncoder.start).toHaveBeenCalledTimes(1);
    expect(mockEncoder.isFullyRunning()).toBe(true);
    expect(mockEncoder.restart).not.toHaveBeenCalled();

    handler.close();
  });

  it('should release hold state and resume browser on explicit restartStream()', async () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 60 });
    buffer.addVideo(VIDEO_FLAGS.KEYFRAME, 0n, Buffer.from('v0'));

    const { handler, emitVideo } = buildHandler(buffer);
    const { msgListener } = await connectAuthenticated(handler);

    await sendAck(msgListener, 0);
    emitVideo({ flags: 0, pts: 15_000_000n, data: Buffer.from('v') });
    expect((handler as any).pipelineHoldState).toBe('BUFFER_HOLD_PAUSED');

    await handler.restartStream();
    expect((handler as any).pipelineHoldState).toBe('ACTIVE');
    expect(mockBrowser.resumeFromBufferHold).toHaveBeenCalledTimes(1);
    expect(mockEncoder.resetHoldCompensation).toHaveBeenCalledTimes(1);
    expect(mockEncoder.restartAll).toHaveBeenCalledTimes(1);

    handler.close();
  });
});
