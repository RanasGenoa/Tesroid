import type { AlignedDimensions, SpecialKey } from "@tesroid/shared";

// 仕様 06 §2.2: CDP（127.0.0.1:9222）専用経路のクライアントアダプタ。
// WebSocket とターゲット一覧 HTTP は外部 I/O 境界であり、テストでは Fake に差し替える。

export interface CdpSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
}

export interface NodeCdpClientDeps {
  readonly openSocket?: (url: string) => CdpSocketLike;
  readonly fetchJson?: (url: string) => Promise<unknown>;
}

interface PendingCommand {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

interface CdpNavigationHistory {
  readonly currentIndex: number;
  readonly entries: readonly { readonly id: string }[];
}

interface CdpEvaluateResponse {
  readonly result?: { readonly value?: unknown };
  readonly exceptionDetails?: unknown;
}

interface SpecialKeyDefinition {
  readonly key: string;
  readonly code: string;
  readonly windowsVirtualKeyCode: number;
}

const SPECIAL_KEY_DEFINITIONS: Readonly<Record<SpecialKey, SpecialKeyDefinition>> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
};

const PAGE_INFO_EXPRESSION =
  "({ url: String(location.href ?? ''), title: String(document.title ?? '') })";

function openGlobalWebSocket(url: string): CdpSocketLike {
  // Node グローバル WebSocket の DOM イベント型ハンドラに対し、open/close/message のみを使う境界適配。
  return new WebSocket(url) as unknown as CdpSocketLike;
}

async function fetchJsonViaHttp(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CDP target list request failed with status ${response.status}`);
  }
  return await response.json();
}

function findPageTargetSocketUrl(targets: unknown): string | null {
  if (!Array.isArray(targets)) {
    return null;
  }
  for (const target of targets) {
    if (
      typeof target === "object" &&
      target !== null &&
      (target as { type?: unknown }).type === "page" &&
      typeof (target as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl === "string"
    ) {
      return (target as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
    }
  }
  return null;
}

export class NodeCdpClient {
  private readonly openSocket: (url: string) => CdpSocketLike;
  private readonly fetchJson: (url: string) => Promise<unknown>;

  private socket: CdpSocketLike | null = null;
  private connecting: Promise<void> | null = null;
  private nextCommandId = 1;
  private readonly pending = new Map<number, PendingCommand>();

  constructor(deps: NodeCdpClientDeps = {}) {
    this.openSocket = deps.openSocket ?? openGlobalWebSocket;
    this.fetchJson = deps.fetchJson ?? fetchJsonViaHttp;
  }

  async connect(port: number): Promise<void> {
    if (this.socket !== null) {
      return;
    }
    if (this.connecting !== null) {
      await this.connecting;
      return;
    }
    const attempt = this.openPageTarget(port);
    this.connecting = attempt;
    try {
      await attempt;
    } finally {
      if (this.connecting === attempt) {
        this.connecting = null;
      }
    }
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    this.detachSocket(socket);
    socket?.close();
  }

  isConnected(): boolean {
    return this.socket !== null;
  }

  // 仕様 06 §2.2: 未接続・切断時の入力はフォールバックせず安全に破棄する。
  // 応答を待たない送出専用経路とし、失敗時の例外は上位の再接続ループ（BrowserService 2,000 ms）へ波及させない。
  async dispatchTouchEvent(
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    touchPoints: readonly { readonly x: number; readonly y: number; readonly id: number }[],
  ): Promise<void> {
    this.sendInputCommand("Input.dispatchTouchEvent", { type, touchPoints });
  }

  async insertText(text: string): Promise<void> {
    this.sendInputCommand("Input.insertText", { text });
  }

  async dispatchKey(key: SpecialKey): Promise<void> {
    const definition = SPECIAL_KEY_DEFINITIONS[key];
    this.sendInputCommand("Input.dispatchKeyEvent", { type: "keyDown", ...definition });
    this.sendInputCommand("Input.dispatchKeyEvent", { type: "keyUp", ...definition });
  }

  async navigate(url: string): Promise<void> {
    await this.command("Page.navigate", { url });
  }

  async goBack(): Promise<void> {
    await this.navigateToHistoryOffset(-1);
  }

  async goForward(): Promise<void> {
    await this.navigateToHistoryOffset(1);
  }

  async reload(): Promise<void> {
    await this.command("Page.reload", {});
  }

  async setViewportSize(dimensions: AlignedDimensions): Promise<void> {
    // deviceScaleFactor 0 は既存の縮尺を上書きしない（Xvfb 環境は 1 固定だが環境依存に依存しない）。
    await this.command("Emulation.setDeviceMetricsOverride", {
      width: dimensions.width,
      height: dimensions.height,
      deviceScaleFactor: 0,
      mobile: false,
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const response = (await this.command("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    })) as CdpEvaluateResponse;
    if (response.exceptionDetails !== undefined) {
      throw new Error(`CDP evaluate raised an exception: ${expression.slice(0, 80)}`);
    }
    return response.result?.value as T;
  }

  async addScriptToEvaluateOnNewDocument(source: string): Promise<void> {
    await this.command("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  async getPageInfo(): Promise<{ readonly url: string | null; readonly title: string | null }> {
    const value = await this.evaluate<{ url?: unknown; title?: unknown }>(PAGE_INFO_EXPRESSION);
    return {
      url: typeof value?.url === "string" ? value.url : null,
      title: typeof value?.title === "string" ? value.title : null,
    };
  }

  private async openPageTarget(port: number): Promise<void> {
    const targets = await this.fetchJson(`http://127.0.0.1:${port}/json/list`);
    const targetUrl = findPageTargetSocketUrl(targets);
    if (targetUrl === null) {
      throw new Error(`No CDP page target found on port ${port}`);
    }
    await this.openAndAttach(targetUrl);
  }

  private openAndAttach(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.openSocket(url);
      let settled = false;
      socket.onopen = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.socket = socket;
        resolve();
      };
      socket.onclose = () => {
        if (!settled) {
          settled = true;
          reject(new Error("CDP socket closed before open"));
          return;
        }
        if (this.socket === socket) {
          this.detachSocket(socket);
          socket.close();
        }
      };
      socket.onmessage = (event) => {
        if (this.socket === socket) {
          this.handleMessage(event.data);
        }
      };
    });
  }

  private detachSocket(socket: CdpSocketLike | null): void {
    if (socket !== null && this.socket === socket) {
      this.socket = null;
    }
    for (const pending of this.pending.values()) {
      pending.reject(new Error("CDP connection closed"));
    }
    this.pending.clear();
  }

  private sendInputCommand(method: string, params: Record<string, unknown>): void {
    const socket = this.socket;
    if (socket === null) {
      return;
    }
    try {
      socket.send(JSON.stringify({ id: this.nextCommandId++, method, params }));
    } catch {
      // 送出直後の切断は安全に破棄する（仕様 06 §2.2）。
    }
  }

  private command(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (socket === null) {
      return Promise.reject(new Error("CDP client is not connected"));
    }
    const id = this.nextCommandId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch {
        this.pending.delete(id);
        reject(new Error("CDP command send failed"));
      }
    });
  }

  private handleMessage(data: string): void {
    let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
    try {
      message = JSON.parse(data) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      const detail =
        typeof message.error.message === "string" ? message.error.message : "unknown error";
      pending.reject(new Error(`CDP command failed: ${detail}`));
      return;
    }
    pending.resolve(message.result);
  }

  private async navigateToHistoryOffset(offset: number): Promise<void> {
    const history = (await this.command("Page.getNavigationHistory", {})) as CdpNavigationHistory;
    const targetIndex = history.currentIndex + offset;
    if (targetIndex < 0 || targetIndex >= history.entries.length) {
      return;
    }
    const entry = history.entries[targetIndex];
    if (entry === undefined) {
      return;
    }
    await this.command("Page.navigateToHistoryEntry", { entryId: entry.id });
  }
}
