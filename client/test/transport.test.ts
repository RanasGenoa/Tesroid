import { WS_CLOSE_CODE } from "@tesroid/shared";
import { describe, expect, it } from "vitest";
import {
  type ClientClock,
  type ClientTimerHandle,
  FetchRestApiClient,
  ReconnectingWsClient,
  type WebSocketCloseEventLike,
  type WebSocketLike,
  type WebSocketMessageEventLike,
  WS_READY_STATE,
} from "../src/transport/index.js";

class FakeClock implements ClientClock {
  private currentMs = 1_000;
  private nextId = 1;
  private readonly timers = new Set<{
    readonly id: number;
    readonly fireAtMs: number;
    readonly callback: () => void;
    cancelled: boolean;
  }>();

  nowMs(): number {
    return this.currentMs;
  }

  setTimeout(callback: () => void, delayMs: number): ClientTimerHandle {
    const entry = {
      id: this.nextId++,
      fireAtMs: this.currentMs + Math.max(0, delayMs),
      callback,
      cancelled: false,
    };
    this.timers.add(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
        this.timers.delete(entry);
      },
    };
  }

  clearTimeout(handle: ClientTimerHandle): void {
    handle.cancel();
  }

  advanceBy(ms: number): void {
    const targetMs = this.currentMs + ms;
    while (true) {
      let nextTimer: {
        readonly id: number;
        readonly fireAtMs: number;
        readonly callback: () => void;
        cancelled: boolean;
      } | null = null;
      for (const timer of this.timers) {
        if (!timer.cancelled && timer.fireAtMs <= targetMs) {
          if (
            nextTimer === null ||
            timer.fireAtMs < nextTimer.fireAtMs ||
            (timer.fireAtMs === nextTimer.fireAtMs && timer.id < nextTimer.id)
          ) {
            nextTimer = timer;
          }
        }
      }
      if (nextTimer === null) {
        break;
      }
      this.timers.delete(nextTimer);
      this.currentMs = Math.max(this.currentMs, nextTimer.fireAtMs);
      nextTimer.callback();
    }
    this.currentMs = targetMs;
  }
}

class FakeWebSocket implements WebSocketLike {
  binaryType = "blob";
  readyState: number = WS_READY_STATE.CONNECTING;
  readonly sent: Uint8Array[] = [];
  closedWith: { readonly code?: number; readonly reason?: string } | null = null;

  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: WebSocketMessageEventLike) => void) | null = null;
  onclose: ((event: WebSocketCloseEventLike) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: Uint8Array | ArrayBuffer): void {
    if (data instanceof Uint8Array) {
      this.sent.push(new Uint8Array(data));
      return;
    }
    this.sent.push(new Uint8Array(data));
  }

  close(code?: number, reason?: string): void {
    this.readyState = WS_READY_STATE.CLOSED;
    this.closedWith = { code, reason };
  }

  triggerOpen(): void {
    this.readyState = WS_READY_STATE.OPEN;
    this.onopen?.({});
  }

  triggerBinaryMessage(bytes: Uint8Array): void {
    const copy = new Uint8Array(bytes);
    this.onmessage?.({ data: copy.buffer });
  }

  triggerClose(code: number, reason = ""): void {
    this.readyState = WS_READY_STATE.CLOSED;
    this.onclose?.({ code, reason });
  }
}

describe("client/transport (Spec 01, 02, 03)", () => {
  it("Spec 02 §3 & Spec 03 §2.1: sends/receives binary ArrayBuffer frames, applies exponential backoff up to 30s, resets attempt on open, and halts on terminal close codes 1008/4000/4009", () => {
    const clock = new FakeClock();
    const sockets: FakeWebSocket[] = [];
    const client = new ReconnectingWsClient({
      clock,
      createSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
    });

    const received: Uint8Array[] = [];
    const closes: { code: number; terminal: boolean }[] = [];
    let opens = 0;

    client.connect("wss://example.test/ws", {
      onOpen: () => {
        opens += 1;
      },
      onBinaryMessage: (data) => {
        received.push(data);
      },
      onClose: (info) => {
        closes.push({ code: info.code, terminal: info.terminal });
      },
    });

    expect(sockets).toHaveLength(1);
    const ws0 = sockets[0];
    expect(ws0?.binaryType).toBe("arraybuffer");
    expect(client.getStatus()).toBe("CONNECTING");
    expect(client.sendBinary(new Uint8Array([0x12]))).toBe(false);

    ws0?.triggerOpen();
    expect(client.getStatus()).toBe("CONNECTED");
    expect(opens).toBe(1);
    expect(client.sendBinary(new Uint8Array([0x12, 0x31, 0x32]))).toBe(true);
    expect(ws0?.sent).toEqual([new Uint8Array([0x12, 0x31, 0x32])]);

    ws0?.triggerBinaryMessage(new Uint8Array([0x03, 0x7b, 0x7d]));
    expect(received).toEqual([new Uint8Array([0x03, 0x7b, 0x7d])]);

    // Verify backoff progression: 1s -> 2s -> 4s -> 8s -> 16s -> 30s -> 30s
    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const delay of expectedDelays) {
      const current = sockets.at(-1);
      const countBefore = sockets.length;
      current?.triggerClose(1006, "drop");
      expect(client.getStatus()).toBe("DISCONNECTED");

      clock.advanceBy(delay - 1);
      expect(sockets).toHaveLength(countBefore);
      clock.advanceBy(1);
      expect(sockets).toHaveLength(countBefore + 1);
    }

    // Opening resets backoff back to 1,000 ms.
    const recoveredSocket = sockets.at(-1);
    recoveredSocket?.triggerOpen();
    expect(opens).toBe(2);
    recoveredSocket?.triggerClose(1006, "drop_again");
    const countBeforeResetCheck = sockets.length;
    clock.advanceBy(1_000);
    expect(sockets).toHaveLength(countBeforeResetCheck + 1);

    // Terminal close codes (1008, 4000, 4009) transition to TERMINAL_CLOSED and never reconnect.
    for (const terminalCode of [
      WS_CLOSE_CODE.POLICY_VIOLATION,
      WS_CLOSE_CODE.SESSION_SUPERSEDED,
      WS_CLOSE_CODE.SESSION_CONFLICT,
    ]) {
      const terminalClient = new ReconnectingWsClient({
        clock,
        createSocket: () => {
          const ws = new FakeWebSocket();
          sockets.push(ws);
          return ws;
        },
      });
      const terminalCloses: boolean[] = [];
      terminalClient.connect("wss://example.test/ws", {
        onBinaryMessage: () => {},
        onClose: (info) => {
          terminalCloses.push(info.terminal);
        },
      });
      const countBefore = sockets.length;
      sockets.at(-1)?.triggerClose(terminalCode, "terminal");
      expect(terminalClient.getStatus()).toBe("TERMINAL_CLOSED");
      expect(terminalCloses).toEqual([true]);
      clock.advanceBy(60_000);
      expect(sockets).toHaveLength(countBefore);
    }

    // Explicit disconnect stops reconnects cleanly.
    const countAtDisconnect = sockets.length;
    client.disconnect(WS_CLOSE_CODE.NORMAL, "bye");
    expect(client.getStatus()).toBe("DISCONNECTED");
    clock.advanceBy(60_000);
    expect(sockets).toHaveLength(countAtDisconnect);
  });

  it("Spec 01, 03, 08, 10: maps all REST endpoints, applies Bearer auth in-memory without localStorage, and returns structured errors", async () => {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] =
      [];

    let nextStatus = 200;
    let nextBody = JSON.stringify({ ok: true });
    let throwNetworkError = false;

    const rest = new FetchRestApiClient("https://tesroid.local/", {
      fetchImpl: async (input, init) => {
        if (throwNetworkError) {
          throw new Error("ECONNREFUSED");
        }
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({
          url: input,
          method: init?.method ?? "GET",
          headers,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return new Response(nextBody, {
          status: nextStatus,
          headers: { "content-type": "application/json" },
        });
      },
    });

    // Public endpoints omit Bearer header even if token is set later.
    await rest.getStatus();
    await rest.getHealth();
    await rest.getPowerStatus();
    await rest.completeSetup({ pin: "1234", timezone: "Asia/Tokyo", qualityPreset: "standard" });

    rest.setToken("abc123token");
    await rest.getSettings();
    await rest.updateSettings({ stream: { fps: 60 } });
    await rest.sleepPower();
    await rest.resumePower();
    await rest.restartBrowser();
    await rest.resetStream();
    await rest.getMetricsSummary();
    await rest.getMetricsHistory(25);
    await rest.listTelemetrySessions();
    await rest.deleteTelemetrySessions();

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://tesroid.local/api/status",
      "GET https://tesroid.local/api/health",
      "GET https://tesroid.local/api/power/status",
      "POST https://tesroid.local/api/setup",
      "GET https://tesroid.local/api/settings",
      "PUT https://tesroid.local/api/settings",
      "POST https://tesroid.local/api/power/sleep",
      "POST https://tesroid.local/api/power/resume",
      "POST https://tesroid.local/api/power/restart-browser",
      "POST https://tesroid.local/api/stream/reset",
      "GET https://tesroid.local/api/metrics/summary",
      "GET https://tesroid.local/api/metrics/history?limit=25",
      "GET https://tesroid.local/api/telemetry/sessions",
      "DELETE https://tesroid.local/api/telemetry/sessions",
    ]);

    expect(calls[0]?.headers.Authorization).toBeUndefined();
    expect(calls[4]?.headers.Authorization).toBe("Bearer abc123token");
    expect(calls[9]?.headers.Authorization).toBe("Bearer abc123token");
    expect(calls[11]?.headers.Authorization).toBe("Bearer abc123token");

    // 401 verifyPin preserves error code & remainingAttempts data.
    nextStatus = 401;
    nextBody = JSON.stringify({
      ok: false,
      code: "INVALID_PIN",
      error: "Invalid PIN",
      remainingAttempts: 4,
    });
    const pinFail = await rest.verifyPin("9999");
    expect(pinFail.ok).toBe(false);
    if (!pinFail.ok) {
      expect(pinFail.status).toBe(401);
      expect(pinFail.code).toBe("INVALID_PIN");
      expect(pinFail.data?.remainingAttempts).toBe(4);
    }

    // Network failure returns structured NETWORK_ERROR without throwing.
    throwNetworkError = true;
    const netFail = await rest.getStatus();
    expect(netFail).toEqual({
      ok: false,
      status: 0,
      error: "ECONNREFUSED",
      code: "NETWORK_ERROR",
    });
  });
});
