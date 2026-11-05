import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browserRestart, encoderRestart, resume, sleep } from '../src/views/power-actions.js';

describe('power-actions REST functions & error handling', () => {
  const token = 'sample-token-123';
  let createdToasts: Array<{ innerHTML: string }>;
  let dispatchedEvents: string[];

  beforeEach(() => {
    createdToasts = [];
    dispatchedEvents = [];

    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    (globalThis as any).confirm = vi.fn().mockReturnValue(true);
    (globalThis as any).requestAnimationFrame = vi.fn((cb: any) => setTimeout(cb, 0));
    (globalThis as any).CustomEvent = class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    };
    (globalThis as any).window = {
      dispatchEvent: vi.fn((ev: any) => {
        dispatchedEvents.push(ev.type);
      }),
    };
    (globalThis as any).document = {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => {
        const el: any = {
          style: {},
          innerHTML: '',
          remove: vi.fn(),
          appendChild: vi.fn((child: any) => {
            if (child && typeof child.innerHTML === 'string') {
              createdToasts.push(child);
            }
          }),
        };
        return el;
      }),
      body: {
        appendChild: vi.fn(),
      },
    };
  });

  it('sleep calls /api/system/sleep with POST and Bearer token and reports HTTP errors cleanly', async () => {
    await sleep(token);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/system/sleep', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(createdToasts.some((t) => t.innerHTML.includes('省電力一時停止'))).toBe(true);

    // Non-200 HTTP response must show error toast instead of false success
    createdToasts = [];
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    await sleep(token);
    expect(createdToasts.some((t) => t.innerHTML.includes('HTTP 401'))).toBe(true);
  });

  it('resume calls /api/system/resume and reports HTTP or network failures cleanly', async () => {
    await resume(token);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/system/resume', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(createdToasts.some((t) => t.innerHTML.includes('再開しました'))).toBe(true);

    createdToasts = [];
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await resume(token);
    expect(createdToasts.some((t) => t.innerHTML.includes('HTTP 500'))).toBe(true);

    createdToasts = [];
    (globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('Network offline'));
    await resume(token);
    expect(createdToasts.some((t) => t.innerHTML.includes('Network offline'))).toBe(true);
  });

  it('encoderRestart dispatches tesroid:stream-reset on 200 OK and suppresses it on HTTP failure', async () => {
    await encoderRestart(token);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/encoder/restart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(dispatchedEvents).toEqual(['tesroid:stream-reset']);

    dispatchedEvents = [];
    createdToasts = [];
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await encoderRestart(token);
    expect(dispatchedEvents).toEqual([]);
    expect(createdToasts.some((t) => t.innerHTML.includes('HTTP 503'))).toBe(true);
  });

  it('browserRestart prompts confirm, calls /api/system/restart-browser, and checks res.ok', async () => {
    await browserRestart(token);
    expect(globalThis.confirm).toHaveBeenCalledWith('ブラウザプロセスを再起動しますか？');
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/system/restart-browser', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    createdToasts = [];
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    await browserRestart(token);
    expect(createdToasts.some((t) => t.innerHTML.includes('HTTP 401'))).toBe(true);
  });

  it('browserRestart does not call fetch when confirm is canceled', async () => {
    (globalThis as any).confirm = vi.fn().mockReturnValue(false);
    await browserRestart(token);
    expect(globalThis.confirm).toHaveBeenCalledWith('ブラウザプロセスを再起動しますか？');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
