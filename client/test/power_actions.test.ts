import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sleep, resume, encoderRestart, browserRestart } from '../src/views/power-actions.js';

describe('power-actions REST functions', () => {
  const token = 'sample-token-123';

  beforeEach(() => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    (globalThis as any).confirm = vi.fn().mockReturnValue(true);
    (globalThis as any).requestAnimationFrame = vi.fn((cb: any) => setTimeout(cb, 0));
    (globalThis as any).document = {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => ({
        style: {},
        appendChild: vi.fn(),
      })),
      body: {
        appendChild: vi.fn(),
      },
    };
  });

  it('sleep calls /api/system/sleep with POST and Bearer token', async () => {
    await sleep(token);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/system/sleep', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  it('resume calls /api/system/resume with POST and Bearer token', async () => {
    await resume(token);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/system/resume', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  it('encoderRestart calls /api/encoder/restart with POST and Bearer token', async () => {
    await encoderRestart(token);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/encoder/restart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  it('browserRestart prompts confirm and calls /api/system/restart-browser when confirmed', async () => {
    await browserRestart(token);
    expect(globalThis.confirm).toHaveBeenCalledWith('ブラウザプロセスを再起動しますか？');
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/system/restart-browser', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  it('browserRestart does not call fetch when confirm is canceled', async () => {
    (globalThis as any).confirm = vi.fn().mockReturnValue(false);
    await browserRestart(token);
    expect(globalThis.confirm).toHaveBeenCalledWith('ブラウザプロセスを再起動しますか？');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
