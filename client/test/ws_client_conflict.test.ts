import { afterEach, describe, expect, it, vi } from 'vitest';
import { WsClient } from '../src/transport/ws-client.js';

describe('WsClient terminal close codes (Issue #58)', () => {
  const origWebSocket = (globalThis as any).WebSocket;

  afterEach(() => {
    (globalThis as any).WebSocket = origWebSocket;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setupMockWebSocket() {
    let instance: any = null;
    class MockWebSocket {
      static OPEN = 1;
      readyState = 1;
      binaryType = 'arraybuffer';
      onopen: (() => void) | null = null;
      onclose: ((ev: { code: number; reason: string }) => void) | null = null;
      onerror: ((ev: any) => void) | null = null;
      onmessage: ((ev: any) => void) | null = null;
      send = vi.fn();
      close = vi.fn();
      constructor() {
        instance = this;
      }
    }
    (globalThis as any).WebSocket = MockWebSocket;
    return () => instance;
  }

  it('does not schedule auto-reconnect when closed with code 4009 (SESSION_CONFLICT)', () => {
    vi.useFakeTimers();
    const getWs = setupMockWebSocket();
    const client = new WsClient('wss://example.com/ws');
    client.connect();

    const ws = getWs();
    expect(ws).not.toBeNull();
    ws.onclose?.({ code: 4009, reason: 'Another session is active' });

    // Advance timers well beyond maxReconnectDelay; no new WebSocket should be created
    const prevWs = ws;
    vi.advanceTimersByTime(60_000);
    expect(getWs()).toBe(prevWs);
  });

  it('does not schedule auto-reconnect when closed with code 4000 (Replaced by reconnect)', () => {
    vi.useFakeTimers();
    const getWs = setupMockWebSocket();
    const client = new WsClient('wss://example.com/ws');
    client.connect();

    const ws = getWs();
    expect(ws).not.toBeNull();
    ws.onclose?.({ code: 4000, reason: 'Replaced by reconnect' });

    const prevWs = ws;
    vi.advanceTimersByTime(60_000);
    expect(getWs()).toBe(prevWs);
  });

  it('ignores stale close events from a superseded socket instance', () => {
    vi.useFakeTimers();
    const getWs = setupMockWebSocket();
    const client = new WsClient('wss://example.com/ws');
    const closeSpy = vi.fn();
    client.on('close', closeSpy);

    client.connect();
    const staleWs = getWs();

    // New connection supersedes staleWs
    client.connect();
    const activeWs = getWs();
    expect(activeWs).not.toBe(staleWs);

    // Late close from staleWs must not trigger close event or stop activeWs
    staleWs.onclose?.({ code: 4000, reason: 'Replaced by reconnect' });
    expect(closeSpy).not.toHaveBeenCalled();
    client.close();
  });

  it('schedules auto-reconnect for normal transient close codes (e.g., 1006)', () => {
    vi.useFakeTimers();
    const getWs = setupMockWebSocket();
    const client = new WsClient('wss://example.com/ws');
    client.connect();

    const firstWs = getWs();
    firstWs.onclose?.({ code: 1006, reason: 'Abnormal closure' });

    vi.advanceTimersByTime(1500);
    expect(getWs()).not.toBe(firstWs);
    client.close();
  });
});
