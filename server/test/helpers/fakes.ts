import path from "node:path";
import type { AlignedDimensions, EncoderBackend, SpecialKey, WsCloseCode } from "@tesroid/shared";
import type {
  BrowserPageInfo,
  CdpClientPort,
  PageNavigationEvent,
} from "../../src/domains/browser/ports.js";
import type { GpuHardwareProbePort } from "../../src/domains/encoder/ports.js";
import type { SessionConnectionId, SessionTransportPort } from "../../src/domains/session/ports.js";
import type {
  AtomicJsonStore,
  Clock,
  ExecResult,
  JsonlFileInfo,
  JsonlStore,
  ManagedProcess,
  ProcessEntry,
  ProcessExecOptions,
  ProcessExitPort,
  ProcessRunner,
  ProcessSignal,
  ProcessTreeController,
  SpawnOptions,
  TimerHandle,
} from "../../src/infra/index.js";

interface ScheduledTimer {
  readonly id: number;
  readonly callback: () => void;
  nextRunAtMs: number;
  readonly intervalMs: number | null;
}

export class FakeClock implements Clock {
  private currentNowMs: number;
  private currentMonotonicMs = 0;
  private nextId = 1;
  private readonly timers = new Map<TimerHandle, ScheduledTimer>();

  // Spec: docs/architecture.md#4.2
  constructor(initialNowMs = 1_700_000_000_000) {
    this.currentNowMs = initialNowMs;
  }

  // Spec: docs/architecture.md#4.2
  nowMs(): number {
    return this.currentNowMs;
  }

  // Spec: docs/architecture.md#4.2
  monotonicMs(): number {
    return this.currentMonotonicMs;
  }

  // Spec: docs/architecture.md#4.2
  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const handle: TimerHandle = { __brand: "TimerHandle" };
    this.timers.set(handle, {
      id: this.nextId++,
      callback,
      nextRunAtMs: this.currentNowMs + Math.max(0, delayMs),
      intervalMs: null,
    });
    return handle;
  }

  // Spec: docs/architecture.md#4.2
  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle);
  }

  // Spec: docs/architecture.md#4.2
  setInterval(callback: () => void, intervalMs: number): TimerHandle {
    const handle: TimerHandle = { __brand: "TimerHandle" };
    const safeInterval = Math.max(1, intervalMs);
    this.timers.set(handle, {
      id: this.nextId++,
      callback,
      nextRunAtMs: this.currentNowMs + safeInterval,
      intervalMs: safeInterval,
    });
    return handle;
  }

  // Spec: docs/architecture.md#4.2
  clearInterval(handle: TimerHandle): void {
    this.timers.delete(handle);
  }

  // Spec: docs/architecture.md#4.2
  advanceByMs(deltaMs: number): void {
    const step = Math.max(0, deltaMs);
    const targetNowMs = this.currentNowMs + step;

    while (true) {
      let nextHandle: TimerHandle | null = null;
      let nextEntry: ScheduledTimer | null = null;
      for (const [handle, entry] of this.timers) {
        if (entry.nextRunAtMs <= targetNowMs) {
          if (
            nextEntry === null ||
            entry.nextRunAtMs < nextEntry.nextRunAtMs ||
            (entry.nextRunAtMs === nextEntry.nextRunAtMs && entry.id < nextEntry.id)
          ) {
            nextHandle = handle;
            nextEntry = entry;
          }
        }
      }

      if (nextHandle === null || nextEntry === null) {
        break;
      }

      const elapsed = Math.max(0, nextEntry.nextRunAtMs - this.currentNowMs);
      this.currentNowMs = nextEntry.nextRunAtMs;
      this.currentMonotonicMs += elapsed;

      if (nextEntry.intervalMs === null) {
        this.timers.delete(nextHandle);
      } else {
        nextEntry.nextRunAtMs += nextEntry.intervalMs;
      }
      nextEntry.callback();
    }

    const remaining = Math.max(0, targetNowMs - this.currentNowMs);
    this.currentNowMs = targetNowMs;
    this.currentMonotonicMs += remaining;
  }

  // Spec: docs/architecture.md#4.2
  setNowMs(nowMs: number): void {
    this.currentNowMs = nowMs;
  }
}

export class FakeAtomicJsonStore implements AtomicJsonStore {
  private readonly files = new Map<string, string>();

  // Spec: docs/architecture.md#4.2
  async readJson<T>(filePath: string): Promise<T | null> {
    const raw = this.files.get(filePath);
    if (raw === undefined) {
      return null;
    }
    return JSON.parse(raw) as T;
  }

  // Spec: docs/architecture.md#4.2
  async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    this.files.set(filePath, JSON.stringify(data, null, 2));
  }

  // Spec: docs/architecture.md#4.2
  async exists(filePath: string): Promise<boolean> {
    return this.files.has(filePath);
  }

  // Spec: docs/architecture.md#4.2
  async remove(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }

  setRawText(filePath: string, raw: string): void {
    this.files.set(filePath, raw);
  }

  getRawText(filePath: string): string | null {
    return this.files.get(filePath) ?? null;
  }
}

export class FakeJsonlStore implements JsonlStore {
  private readonly clock: Clock | null;
  private readonly dirs = new Set<string>();
  private readonly files = new Map<
    string,
    { content: string; createdAtMs: number; updatedAtMs: number }
  >();
  ensureDirCalls = 0;
  appendCalls = 0;

  constructor(clock?: Clock) {
    this.clock = clock ?? null;
  }

  private nowMs(): number {
    return this.clock?.nowMs() ?? Date.now();
  }

  // Spec: docs/architecture.md#4.2
  async ensureDir(dirPath: string): Promise<void> {
    this.ensureDirCalls += 1;
    this.dirs.add(path.resolve(dirPath));
  }

  // Spec: docs/architecture.md#4.2
  async appendLine(filePath: string, line: string): Promise<number> {
    this.appendCalls += 1;
    const resolved = path.resolve(filePath);
    const payload = line.endsWith("\n") ? line : `${line}\n`;
    const now = this.nowMs();
    const existing = this.files.get(resolved);
    if (existing !== undefined) {
      existing.content += payload;
      existing.updatedAtMs = now;
    } else {
      this.files.set(resolved, {
        content: payload,
        createdAtMs: now,
        updatedAtMs: now,
      });
    }
    return Buffer.byteLength(payload, "utf8");
  }

  // Spec: docs/architecture.md#4.2
  async statFile(filePath: string): Promise<JsonlFileInfo | null> {
    const resolved = path.resolve(filePath);
    const entry = this.files.get(resolved);
    if (entry === undefined) {
      return null;
    }
    return {
      fileName: path.basename(resolved),
      sizeBytes: Buffer.byteLength(entry.content, "utf8"),
      lineCount: entry.content.split("\n").filter((item) => item.length > 0).length,
      createdAtMs: entry.createdAtMs,
      updatedAtMs: entry.updatedAtMs,
    };
  }

  // Spec: docs/architecture.md#4.2
  async listFiles(dirPath: string, extension: string): Promise<readonly JsonlFileInfo[]> {
    const resolvedDir = path.resolve(dirPath);
    const results: JsonlFileInfo[] = [];
    for (const [filePath, entry] of this.files) {
      if (path.dirname(filePath) === resolvedDir && filePath.endsWith(extension)) {
        results.push({
          fileName: path.basename(filePath),
          sizeBytes: Buffer.byteLength(entry.content, "utf8"),
          lineCount: entry.content.split("\n").filter((item) => item.length > 0).length,
          createdAtMs: entry.createdAtMs,
          updatedAtMs: entry.updatedAtMs,
        });
      }
    }
    return results;
  }

  // Spec: docs/architecture.md#4.2
  async readFileText(filePath: string): Promise<string | null> {
    return this.files.get(path.resolve(filePath))?.content ?? null;
  }

  // Spec: docs/architecture.md#4.2
  async deleteFile(filePath: string): Promise<void> {
    this.files.delete(path.resolve(filePath));
  }

  // Spec: docs/architecture.md#4.2
  async deleteAllFiles(dirPath: string, extension: string): Promise<void> {
    const resolvedDir = path.resolve(dirPath);
    for (const filePath of [...this.files.keys()]) {
      if (path.dirname(filePath) === resolvedDir && filePath.endsWith(extension)) {
        this.files.delete(filePath);
      }
    }
  }

  hasDir(dirPath: string): boolean {
    return this.dirs.has(path.resolve(dirPath));
  }
}

export class FakeManagedProcess implements ManagedProcess {
  readonly pid: number | null;
  readonly spawnOptions: SpawnOptions;
  readonly killedSignals: ProcessSignal[] = [];
  ignoreSigterm = false;
  private exited = false;
  private readonly stdoutListeners: ((chunk: Uint8Array) => void)[] = [];
  private readonly stderrListeners: ((chunk: Uint8Array) => void)[] = [];
  private readonly exitListeners: ((code: number | null, signal: string | null) => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];

  constructor(pid: number | null, spawnOptions: SpawnOptions) {
    this.pid = pid;
    this.spawnOptions = spawnOptions;
  }

  onStdout(listener: (chunk: Uint8Array) => void): void {
    this.stdoutListeners.push(listener);
  }

  onStderr(listener: (chunk: Uint8Array) => void): void {
    this.stderrListeners.push(listener);
  }

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  kill(signal: ProcessSignal = "SIGTERM"): boolean {
    if (this.exited || this.pid === null) {
      return false;
    }
    this.killedSignals.push(signal);
    if (signal === "SIGKILL" || (signal === "SIGTERM" && !this.ignoreSigterm)) {
      this.emitExit(null, signal);
    }
    return true;
  }

  emitStdout(chunk: Uint8Array): void {
    for (const listener of this.stdoutListeners) {
      listener(chunk);
    }
  }

  emitStderr(chunk: Uint8Array): void {
    for (const listener of this.stderrListeners) {
      listener(chunk);
    }
  }

  emitExit(code: number | null, signal: string | null = null): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    for (const listener of this.exitListeners) {
      listener(code, signal);
    }
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }
}

export class FakeProcessRunner implements ProcessRunner {
  readonly spawnCalls: SpawnOptions[] = [];
  readonly spawnedProcesses: FakeManagedProcess[] = [];
  readonly execCalls: {
    readonly command: string;
    readonly args: readonly string[];
    readonly options?: ProcessExecOptions;
  }[] = [];
  readonly signalCalls: { readonly pid: number; readonly signal: ProcessSignal }[] = [];
  readonly terminatedProcesses: { readonly proc: ManagedProcess; readonly graceMs: number }[] = [];

  nextPid = 1000;
  processList: readonly ProcessEntry[] = [];
  readonly deadPids = new Set<number>();
  execHandler:
    | ((
        command: string,
        args: readonly string[],
        options?: ProcessExecOptions,
      ) => ExecResult | Promise<ExecResult>)
    | null = null;

  // Spec: docs/architecture.md#4.2
  spawn(options: SpawnOptions): ManagedProcess {
    this.spawnCalls.push(options);
    const proc = new FakeManagedProcess(this.nextPid, options);
    this.nextPid += 100;
    this.spawnedProcesses.push(proc);
    return proc;
  }

  // Spec: docs/architecture.md#4.2
  async exec(
    command: string,
    args: readonly string[],
    options?: ProcessExecOptions,
  ): Promise<ExecResult> {
    this.execCalls.push({ command, args, options });
    if (this.execHandler !== null) {
      return this.execHandler(command, args, options);
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }

  // Spec: docs/architecture.md#4.2
  sendSignal(pid: number, signal: ProcessSignal): boolean {
    this.signalCalls.push({ pid, signal });
    return !this.deadPids.has(pid);
  }

  // Spec: docs/architecture.md#4.2
  async listProcesses(): Promise<readonly ProcessEntry[]> {
    return [...this.processList];
  }

  // Spec: docs/architecture.md#4.2
  async terminateWithEscalation(proc: ManagedProcess, graceMs: number): Promise<void> {
    this.terminatedProcesses.push({ proc, graceMs });
    proc.kill("SIGTERM");
  }
}

export class FakeProcessTreeController implements ProcessTreeController {
  readonly freezeCalls: number[] = [];
  readonly resumeCalls: number[] = [];
  readonly descendantsByRoot = new Map<number, readonly number[]>();

  // Spec: docs/architecture.md#4.2
  async collectDescendants(rootPid: number): Promise<readonly number[]> {
    return this.descendantsByRoot.get(rootPid) ?? [];
  }

  // Spec: docs/architecture.md#4.2
  async freezeTree(rootPid: number): Promise<void> {
    this.freezeCalls.push(rootPid);
  }

  // Spec: docs/architecture.md#4.2
  async resumeTree(rootPid: number): Promise<void> {
    this.resumeCalls.push(rootPid);
  }
}

export class FakeProcessExitError extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`Process exited with code ${code}`);
    this.name = "FakeProcessExitError";
    this.code = code;
  }
}

export class FakeProcessExit implements ProcessExitPort {
  readonly exitCodes: number[] = [];

  // Spec: docs/architecture.md#4.2
  exit(code: number): never {
    this.exitCodes.push(code);
    throw new FakeProcessExitError(code);
  }
}

export class FakeCdpClient implements CdpClientPort {
  connected = false;
  connectedPort: number | null = null;
  connectAttempts = 0;
  disconnectCount = 0;
  shouldFailConnect = false;
  shouldThrowOnGetPageInfo = false;
  pageInfo: BrowserPageInfo = { url: "https://www.youtube.com", title: "YouTube" };
  getPageInfoCalls = 0;

  readonly touchEvents: {
    readonly type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel";
    readonly touchPoints: readonly {
      readonly x: number;
      readonly y: number;
      readonly id: number;
    }[];
  }[] = [];
  readonly insertedTexts: string[] = [];
  readonly dispatchedKeys: SpecialKey[] = [];
  readonly navigatedUrls: string[] = [];
  backCount = 0;
  forwardCount = 0;
  reloadCount = 0;
  readonly viewportSizes: AlignedDimensions[] = [];
  readonly evaluatedExpressions: string[] = [];
  readonly initScripts: string[] = [];
  evaluateHandler: ((expression: string) => unknown) | null = null;
  pageEventListener: ((event: PageNavigationEvent) => void) | null = null;

  // Spec: docs/architecture.md#4.2
  async connect(port: number): Promise<void> {
    this.connectAttempts += 1;
    if (this.shouldFailConnect) {
      throw new Error(`Failed to connect to CDP port ${port}`);
    }
    this.connected = true;
    this.connectedPort = port;
  }

  // Spec: docs/architecture.md#4.2
  async disconnect(): Promise<void> {
    this.disconnectCount += 1;
    this.connected = false;
  }

  // Spec: docs/architecture.md#4.2
  isConnected(): boolean {
    return this.connected;
  }

  // Spec: docs/architecture.md#4.2
  async dispatchTouchEvent(
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    touchPoints: readonly { readonly x: number; readonly y: number; readonly id: number }[],
  ): Promise<void> {
    this.touchEvents.push({
      type,
      touchPoints: touchPoints.map((pt) => ({ ...pt })),
    });
  }

  // Spec: docs/architecture.md#4.2
  async insertText(text: string): Promise<void> {
    this.insertedTexts.push(text);
  }

  // Spec: docs/architecture.md#4.2
  async dispatchKey(key: SpecialKey): Promise<void> {
    this.dispatchedKeys.push(key);
  }

  // Spec: docs/architecture.md#4.2
  async navigate(url: string): Promise<void> {
    this.navigatedUrls.push(url);
  }

  // Spec: docs/architecture.md#4.2
  async goBack(): Promise<void> {
    this.backCount += 1;
  }

  // Spec: docs/architecture.md#4.2
  async goForward(): Promise<void> {
    this.forwardCount += 1;
  }

  // Spec: docs/architecture.md#4.2
  async reload(): Promise<void> {
    this.reloadCount += 1;
  }

  // Spec: docs/architecture.md#4.2
  async setViewportSize(dimensions: AlignedDimensions): Promise<void> {
    this.viewportSizes.push({ ...dimensions });
  }

  // Spec: docs/architecture.md#4.2
  async evaluate<T = unknown>(expression: string): Promise<T> {
    this.evaluatedExpressions.push(expression);
    if (this.evaluateHandler !== null) {
      return this.evaluateHandler(expression) as T;
    }
    return undefined as T;
  }

  // Spec: docs/architecture.md#4.2
  async setPageInitScript(source: string): Promise<void> {
    this.initScripts.push(source);
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.4
  setPageEventListener(listener: ((event: PageNavigationEvent) => void) | null): void {
    this.pageEventListener = listener;
  }

  emitPageEvent(event: PageNavigationEvent): void {
    this.pageEventListener?.(event);
  }

  // Spec: docs/architecture.md#4.2
  async getPageInfo(): Promise<BrowserPageInfo> {
    this.getPageInfoCalls += 1;
    if (this.shouldThrowOnGetPageInfo) {
      throw new Error("CDP disconnected");
    }
    return { ...this.pageInfo };
  }
}

export class FakeGpuHardwareProbe implements GpuHardwareProbePort {
  nvidiaDevice = false;
  nvencAvailable = false;
  driRenderNodes: readonly { readonly path: string; readonly vendorId: string }[] = [];
  wslDxgDevice = false;
  nvencProbeCalls = 0;
  readonly probedVaapiCalls: { readonly devicePath: string; readonly driverName: string }[] = [];
  vaapiProbeHandler:
    | ((devicePath: string, driverName: string) => boolean | Promise<boolean>)
    | null = null;

  // Spec: docs/architecture.md#4.2
  async hasNvidiaDevice(): Promise<boolean> {
    return this.nvidiaDevice;
  }

  // Spec: docs/architecture.md#4.2
  async probeNvenc(): Promise<boolean> {
    this.nvencProbeCalls += 1;
    return this.nvencAvailable;
  }

  // Spec: docs/architecture.md#4.2
  async findDriRenderNodes(): Promise<
    readonly { readonly path: string; readonly vendorId: string }[]
  > {
    return [...this.driRenderNodes];
  }

  // Spec: docs/architecture.md#4.2
  async probeVaapiEncode(devicePath: string, driverName: string): Promise<boolean> {
    this.probedVaapiCalls.push({ devicePath, driverName });
    if (this.vaapiProbeHandler !== null) {
      return this.vaapiProbeHandler(devicePath, driverName);
    }
    return false;
  }

  // Spec: docs/architecture.md#4.2
  // Spec: docs/architecture.md#4.2
  async hasWslDxgDevice(): Promise<boolean> {
    return this.wslDxgDevice;
  }
}

export class FakeSessionTransport implements SessionTransportPort {
  readonly id: SessionConnectionId;
  readonly sentFrames: Uint8Array[] = [];
  bufferedAmount = 0;
  closedCode: WsCloseCode | null = null;
  closedReason: string | undefined;
  isClosed = false;

  // Spec: docs/architecture.md#4.2
  constructor(id: SessionConnectionId) {
    this.id = id;
  }

  // Spec: docs/architecture.md#4.2
  sendBinary(data: Uint8Array): void {
    this.sentFrames.push(new Uint8Array(data));
  }

  // Spec: docs/architecture.md#4.2
  getBufferedAmount(): number {
    return this.bufferedAmount;
  }

  // Spec: docs/architecture.md#4.2
  close(code: WsCloseCode, reason?: string): void {
    this.closedCode = code;
    this.closedReason = reason;
    this.isClosed = true;
  }

  // Spec: docs/architecture.md#4.2
  setBufferedAmount(bytes: number): void {
    this.bufferedAmount = bytes;
  }
}

export type FakeHelperPlaceholder = AlignedDimensions | EncoderBackend;
