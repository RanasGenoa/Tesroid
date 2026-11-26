import { describe, expect, it, vi } from 'vitest';
import { PlaybackBuffer } from '../src/encoder/playback-buffer.js';
import { WebSocketHandler } from '../src/ws/handler.js';

/**
 * Issue #112 F-6: 健康な LIVE 状態での LIVE tap 由来の全体再起動 (FFmpeg Video/Audio +
 * バッファ + セッション) をスキップし、スロットル非依存の FPS dip (生成断→復帰バースト) を防ぐ。
 * - canSkipFullRestart: Hold 非発動 / エンコーダ稼働 / CATCHUP セッション無し / サーバー保持量
 *   (serverHeldMs) とリングバッファ滞留が小さい場合のみ true
 * - 明示再起動 (?force=1) と WS 明示コマンド (RESTART_ENCODER / CLEAN_RESTART_STREAM) は常に restartStream()
 */

const buildHandler = (running: boolean, playbackBuffer: PlaybackBuffer): WebSocketHandler => {
  const mockAuth: any = {
    validateSession: vi.fn().mockReturnValue(true),
    verifyPin: vi.fn().mockResolvedValue({ success: true }),
  };
  const mockBrowser: any = {
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
  const mockEncoder: any = {
    isRunning: vi.fn(() => running),
    isFullyRunning: vi.fn(() => running),
    stop: vi.fn(),
    start: vi.fn(),
    noteHoldPause: vi.fn(),
    noteHoldResume: vi.fn(),
    resetHoldCompensation: vi.fn(),
    isHoldPaused: vi.fn(() => false),
    armResumeGate: vi.fn(),
    getCurrentPts: vi.fn(() => 0n),
    setResumeBoundary: vi.fn(),
    getActiveBackend: vi.fn(() => 'vaapi'),
    getCachedKeyframe: vi.fn(() => null),
    getCachedSpsPps: vi.fn(() => null),
    getCachedOpusHead: vi.fn(() => null),
    on: vi.fn(),
    restart: vi.fn().mockResolvedValue(undefined),
    restartAll: vi.fn(),
  };
  const mockInput: any = {
    handleTouchEvent: vi.fn(),
    sendKey: vi.fn(),
    navigateBack: vi.fn(),
    updateDimensions: vi.fn(),
  };
  const mockConfig: any = {
    getConfig: () => ({ isSetupCompleted: true, stream: { bitrate: 2000000 } }),
  };
  delete process.env.BUFFER_HOLD_EXPIRE_MINUTES;
  return new WebSocketHandler(
    mockAuth,
    mockBrowser,
    mockEncoder,
    mockInput,
    mockConfig,
    playbackBuffer,
  );
};

describe('WebSocketHandler.canSkipFullRestart (Issue #112 F-6)', () => {
  it('returns true for a healthy LIVE pipeline (encoder running, no backlog)', () => {
    const handler = buildHandler(true, new PlaybackBuffer({ bufferSeconds: 60 })) as any;
    expect(handler.canSkipFullRestart()).toBe(true);
  });

  it('refuses skip while encoder is not running', () => {
    const handler = buildHandler(false, new PlaybackBuffer({ bufferSeconds: 60 })) as any;
    expect(handler.canSkipFullRestart()).toBe(false);
  });

  it('refuses skip while any session is in CATCHUP', () => {
    const handler = buildHandler(true, new PlaybackBuffer({ bufferSeconds: 60 })) as any;
    handler.clientSessions.set('s1', { mode: 'CATCHUP' });
    expect(handler.canSkipFullRestart()).toBe(false);
  });

  it('refuses skip while buffer hold is engaged (not ACTIVE)', () => {
    const handler = buildHandler(true, new PlaybackBuffer({ bufferSeconds: 60 })) as any;
    handler.pipelineHoldState = 'BUFFER_HOLD_PAUSED';
    expect(handler.canSkipFullRestart()).toBe(false);
  });

  it('allows skip even when PlaybackBuffer holds 30s+ of ring history during healthy LIVE streaming', () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 60 });
    const handler = buildHandler(true, buffer) as any;

    // 通常配信 30 秒分がリングバッファに履歴保持されている状態
    buffer.addVideo(1, 0n, Buffer.from('kf0'));
    buffer.addVideo(0, 30_000_000n, Buffer.from('f30'));
    handler.lastKnownAckPts = 29_800_000n; // serverHeldMs = 200ms <= 1000ms
    expect(buffer.getBufferedDurationMs()).toBe(30000);
    expect(handler.canSkipFullRestart()).toBe(true);
  });

  it('refuses skip when encoder is only half-running (video alive, audio stopped) or socket is dropping GOP', () => {
    const handler = buildHandler(true, new PlaybackBuffer({ bufferSeconds: 60 })) as any;
    handler.encoder.isFullyRunning.mockReturnValue(false);
    expect(handler.canSkipFullRestart()).toBe(false);

    handler.encoder.isFullyRunning.mockReturnValue(true);
    const sock: any = { _droppingGop: true };
    handler.clientSessions.set(sock, { socket: sock, mode: 'LIVE' });
    expect(handler.canSkipFullRestart()).toBe(false);
  });

  it('refuses skip when server-held backlog exceeds the live-tap bound, allows small lag', () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 60 });
    const handler = buildHandler(true, buffer) as any;

    // 生成アンカー 20.033s、ack 19.000s → held ≈ 1033ms > 1000ms → スキップ不可 (真の追いつき処理)
    buffer.addVideo(0, 19_000_000n, Buffer.from('a'));
    buffer.addVideo(0, 20_033_000n, Buffer.from('b'));
    handler.lastKnownAckPts = 19_000_000n;
    expect(handler.canSkipFullRestart()).toBe(false);

    // ack 19.700s → held ≈ 333ms ≤ 1000ms → 健康な LIVE。スキップ可
    handler.lastKnownAckPts = 19_700_000n;
    expect(handler.canSkipFullRestart()).toBe(true);
  });

  it('does not restart video encoder or resend stale keyframe on JUMP_TO_LIVE when session is already healthy LIVE', async () => {
    const buffer = new PlaybackBuffer({ bufferSeconds: 60 });
    const handler = buildHandler(true, buffer) as any;
    const sock: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    handler.handleConnection(sock);
    const msgListener = sock.on.mock.calls.find((c: any[]) => c[0] === 'message')?.[1];
    await msgListener(Buffer.concat([Buffer.from([0x04]), Buffer.from('1234')]));
    handler.encoder.restart.mockClear();
    sock.send.mockClear();

    await msgListener(
      Buffer.concat([Buffer.from([0x06]), Buffer.from(JSON.stringify({ type: 'JUMP_TO_LIVE' }))]),
    );

    expect(handler.encoder.restart).not.toHaveBeenCalled();
    const sentVideo = sock.send.mock.calls.filter(
      (c: any[]) => Buffer.isBuffer(c[0]) && c[0][0] === 0x01,
    );
    expect(sentVideo).toHaveLength(0);
    handler.close();
  });
});
