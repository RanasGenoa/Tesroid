import { describe, expect, it } from "vitest";
import { type CdpSocketLike, NodeCdpClient } from "../../src/infra/cdp-client.js";

interface SentCommand {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

class FakeCdpSocket implements CdpSocketLike {
  readonly sent: SentCommand[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentCommand);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  respondTo(result: unknown, index = this.sent.length - 1): number {
    const command = this.sent[index];
    if (command === undefined) {
      throw new Error(`no CDP command at index ${index}`);
    }
    this.onmessage?.({ data: JSON.stringify({ id: command.id, result }) });
    return command.id;
  }

  respondError(message: string, index = this.sent.length - 1): void {
    const command = this.sent[index];
    if (command === undefined) {
      throw new Error(`no CDP command at index ${index}`);
    }
    this.onmessage?.({ data: JSON.stringify({ id: command.id, error: { message } }) });
  }

  emitEvent(method: string): void {
    this.onmessage?.({ data: JSON.stringify({ method }) });
  }
}

const PAGE_TARGETS = [
  { type: "service_worker", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/WORKER" },
  { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/MAIN" },
];

interface AdapterFixture {
  readonly client: NodeCdpClient;
  readonly sockets: FakeCdpSocket[];
  readonly fetchUrls: string[];
}

function createAdapterFixture(options?: {
  targets?: unknown;
  fetchThrows?: boolean;
  openMode?: "open" | "close-before-open";
}): AdapterFixture {
  const sockets: FakeCdpSocket[] = [];
  const fetchUrls: string[] = [];
  const client = new NodeCdpClient({
    openSocket: (url) => {
      const socket = new FakeCdpSocket();
      sockets.push(socket);
      queueMicrotask(() => {
        if ((options?.openMode ?? "open") === "open") {
          socket.onopen?.();
        } else {
          socket.onclose?.();
        }
      });
      return socket;
    },
    fetchJson: async (url) => {
      fetchUrls.push(url);
      if (options?.fetchThrows === true) {
        throw new Error("chrome not reachable");
      }
      return options?.targets ?? PAGE_TARGETS;
    },
  });
  return { client, sockets, fetchUrls };
}

async function connectFixture(fixture: AdapterFixture): Promise<FakeCdpSocket> {
  await fixture.client.connect(9222);
  const socket = fixture.sockets[fixture.sockets.length - 1];
  if (socket === undefined) {
    throw new Error("expected opened CDP socket");
  }
  return socket;
}

describe("仕様 06 AC-02 CDP クライアントアダプタ: ページターゲット接続とコマンド送出", () => {
  it("connect は指定ポートの /json/list から page ターゲットの WS を開き接続状態になる", async () => {
    const fixture = createAdapterFixture();
    const socket = await connectFixture(fixture);

    expect(fixture.fetchUrls).toEqual(["http://127.0.0.1:9222/json/list"]);
    expect(socket.closed).toBe(false);
    expect(fixture.client.isConnected()).toBe(true);
  });

  it("connect はページターゲットが無い場合と HTTP 失敗時に例外となり未接続のまま（再接続経路用）", async () => {
    const noPage = createAdapterFixture({ targets: [{ type: "service_worker" }] });
    await expect(noPage.client.connect(9222)).rejects.toThrow();
    expect(noPage.client.isConnected()).toBe(false);

    const unreachable = createAdapterFixture({ fetchThrows: true });
    await expect(unreachable.client.connect(9222)).rejects.toThrow("chrome not reachable");
    expect(unreachable.client.isConnected()).toBe(false);
  });

  it("connect は WS が open されずに close された場合例外となる", async () => {
    const fixture = createAdapterFixture({ openMode: "close-before-open" });
    await expect(fixture.client.connect(9222)).rejects.toThrow();
    expect(fixture.client.isConnected()).toBe(false);
  });

  it("タッチ・文字・特殊キーは対応する CDP 入力コマンドとして 1 回だけ送出される", async () => {
    const fixture = createAdapterFixture();
    const socket = await connectFixture(fixture);

    await fixture.client.dispatchTouchEvent("touchStart", [{ x: 10, y: 20, id: 1 }]);
    expect(socket.sent[0]).toEqual({
      id: expect.any(Number),
      method: "Input.dispatchTouchEvent",
      params: { type: "touchStart", touchPoints: [{ x: 10, y: 20, id: 1 }] },
    });

    await fixture.client.insertText("tesroid");
    expect(socket.sent[1]).toEqual({
      id: expect.any(Number),
      method: "Input.insertText",
      params: { text: "tesroid" },
    });

    await fixture.client.dispatchKey("Enter");
    expect(socket.sent.slice(2, 4).map((command) => command.params)).toEqual([
      { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
      { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    ]);

    await fixture.client.dispatchKey("ArrowDown");
    expect(socket.sent[4]?.params).toMatchObject({
      type: "keyDown",
      key: "ArrowDown",
      windowsVirtualKeyCode: 40,
    });
    expect(socket.sent[5]?.params).toMatchObject({ type: "keyUp", key: "ArrowDown" });
  });

  it("ナビゲーション・リロード・履歴は Page ドメインコマンドで実行される", async () => {
    const fixture = createAdapterFixture();
    const socket = await connectFixture(fixture);

    const nav = fixture.client.navigate("https://example.com/");
    expect(socket.sent[0]?.method).toBe("Page.navigate");
    expect(socket.sent[0]?.params).toEqual({ url: "https://example.com/" });
    socket.respondTo({ frameId: "F1" }, 0);
    await nav;

    const reload = fixture.client.reload();
    expect(socket.sent[1]?.method).toBe("Page.reload");
    socket.respondTo({}, 1);
    await reload;

    const goBack = fixture.client.goBack();
    expect(socket.sent[2]?.method).toBe("Page.getNavigationHistory");
    socket.respondTo(
      {
        currentIndex: 2,
        entries: [{ id: "e0" }, { id: "e1" }, { id: "e2" }],
      },
      2,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.sent[3]).toEqual({
      id: expect.any(Number),
      method: "Page.navigateToHistoryEntry",
      params: { entryId: "e1" },
    });
    socket.respondTo({}, 3);
    await goBack;

    const goForward = fixture.client.goForward();
    socket.respondTo(
      {
        currentIndex: 1,
        entries: [{ id: "e0" }, { id: "e1" }, { id: "e2" }],
      },
      4,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.sent[5]).toEqual({
      id: expect.any(Number),
      method: "Page.navigateToHistoryEntry",
      params: { entryId: "e2" },
    });
    socket.respondTo({}, 5);
    await goForward;
  });

  it("履歴境界（戻る先無し / 進む先無し）は例外なく no-op で完了する", async () => {
    const fixture = createAdapterFixture();
    const socket = await connectFixture(fixture);

    const goBack = fixture.client.goBack();
    socket.respondTo({ currentIndex: 0, entries: [{ id: "e0" }] }, socket.sent.length - 1);
    await goBack;

    const goForward = fixture.client.goForward();
    socket.respondTo({ currentIndex: 0, entries: [{ id: "e0" }] }, socket.sent.length - 1);
    await goForward;

    expect(socket.sent.map((command) => command.method)).toEqual([
      "Page.getNavigationHistory",
      "Page.getNavigationHistory",
    ]);
  });

  it("setViewportSize は Emulation.setDeviceMetricsOverride、addScriptToEvaluateOnNewDocument は Page 注入コマンドになる", async () => {
    const fixture = createAdapterFixture();
    const socket = await connectFixture(fixture);

    const resize = fixture.client.setViewportSize({ width: 1008, height: 878 });
    expect(socket.sent[0]?.method).toBe("Emulation.setDeviceMetricsOverride");
    expect(socket.sent[0]?.params).toMatchObject({ width: 1008, height: 878 });
    socket.respondTo({}, 0);
    await resize;

    const inject = fixture.client.addScriptToEvaluateOnNewDocument("globalThis.x=1;");
    expect(socket.sent[1]).toEqual({
      id: expect.any(Number),
      method: "Page.addScriptToEvaluateOnNewDocument",
      params: { source: "globalThis.x=1;" },
    });
    socket.respondTo({ identifier: "script-1" }, 1);
    await inject;
  });

  it("evaluate と getPageInfo は応答値を返し、例外詳細と error 応答は reject する", async () => {
    const fixture = createAdapterFixture();
    const socket = await connectFixture(fixture);

    const evaluated = fixture.client.evaluate<number>("1 + 1");
    const evaluateCommand = socket.sent[0];
    expect(evaluateCommand?.method).toBe("Runtime.evaluate");
    expect(evaluateCommand?.params).toMatchObject({ expression: "1 + 1", returnByValue: true });
    socket.respondTo({ result: { value: 2 } }, 0);
    await expect(evaluated).resolves.toBe(2);

    const pageInfo = fixture.client.getPageInfo();
    socket.respondTo({ result: { value: { url: "https://example.com/", title: "Example" } } }, 1);
    await expect(pageInfo).resolves.toEqual({
      url: "https://example.com/",
      title: "Example",
    });

    const thrown = fixture.client.evaluate("throw new Error('x')");
    socket.respondTo({ exceptionDetails: { text: "Uncaught" } }, 2);
    await expect(thrown).rejects.toThrow();

    const errored = fixture.client.evaluate("1");
    socket.respondError("Runtime domain is not available", 3);
    await expect(errored).rejects.toThrow();
  });

  it("未応答コマンドが並列でも id で正しく対応付けられ、イベント通知は応答を消費しない", async () => {
    const fixture = createAdapterFixture();
    const socket = await connectFixture(fixture);

    const first = fixture.client.evaluate<string>("'a'");
    const second = fixture.client.evaluate<string>("'b'");
    const idFirst = socket.sent[0]?.id;
    const idSecond = socket.sent[1]?.id;
    socket.emitEvent("Page.loadEventFired");
    socket.onmessage?.({
      data: JSON.stringify({ id: idSecond, result: { result: { value: "B" } } }),
    });
    socket.onmessage?.({
      data: JSON.stringify({ id: idFirst, result: { result: { value: "A" } } }),
    });

    await expect(first).resolves.toBe("A");
    await expect(second).resolves.toBe("B");
  });
});

describe("仕様 06 AC-02 CDP クライアントアダプタ: 切断時の安全破棄と復帰", () => {
  it("disconnect 後は未接続となり、入力コマンドは送出されず例外なく破棄される", async () => {
    const fixture = createAdapterFixture();
    const socket = await connectFixture(fixture);

    await fixture.client.disconnect();
    expect(socket.closed).toBe(true);
    expect(fixture.client.isConnected()).toBe(false);

    const sentCount = socket.sent.length;
    await fixture.client.dispatchTouchEvent("touchStart", [{ x: 1, y: 2, id: 3 }]);
    await fixture.client.insertText("ignored");
    await fixture.client.dispatchKey("Escape");
    expect(socket.sent.length).toBe(sentCount);
  });

  it("切断後の非入力コマンドは例外となり、connect 再実行で正常注入へ復帰する", async () => {
    const fixture = createAdapterFixture();
    const firstSocket = await connectFixture(fixture);
    await fixture.client.disconnect();
    expect(firstSocket.closed).toBe(true);

    await expect(fixture.client.navigate("https://example.com/")).rejects.toThrow();

    const secondSocket = await connectFixture(fixture);
    await fixture.client.dispatchTouchEvent("touchEnd", [{ x: 4, y: 5, id: 6 }]);
    expect(secondSocket.sent[0]?.method).toBe("Input.dispatchTouchEvent");
    secondSocket.respondTo({}, 0);
  });

  it("接続中のソケット close で未応答コマンドは reject され、入力経路は例外を投げず破棄される", async () => {
    const fixture = createAdapterFixture();
    const socket = await connectFixture(fixture);

    const pending = fixture.client.evaluate("1");
    const inputPath = fixture.client.dispatchKey("Tab");
    socket.onclose?.();

    await expect(pending).rejects.toThrow();
    await expect(inputPath).resolves.toBeUndefined();
    expect(fixture.client.isConnected()).toBe(false);
  });

  it("connect 失敗後も再接続として再 connect すると接続が確立する", async () => {
    const fixture = createAdapterFixture({ fetchThrows: true });
    await expect(fixture.client.connect(9222)).rejects.toThrow();

    const retryClient = new NodeCdpClient({
      openSocket: (url) => {
        const socket = new FakeCdpSocket();
        queueMicrotask(() => socket.onopen?.());
        return socket;
      },
      fetchJson: async () => PAGE_TARGETS,
    });
    await retryClient.connect(9222);
    expect(retryClient.isConnected()).toBe(true);
  });
});
