import type {
  AlignedDimensions,
  EncoderBackend,
  SpecialKey,
  TouchFrame,
  WsCloseCode,
} from "@tesroid/shared";
import type {
  BrowserPageInfo,
  CdpClientPort,
  X11InputPort,
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

export class FakeClock implements Clock {
  // Spec: docs/architecture.md#4.2
  constructor(initialNowMs?: number) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  nowMs(): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  monotonicMs(): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  clearTimeout(handle: TimerHandle): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  setInterval(callback: () => void, intervalMs: number): TimerHandle {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  clearInterval(handle: TimerHandle): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  advanceByMs(deltaMs: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  setNowMs(nowMs: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}

export class FakeAtomicJsonStore implements AtomicJsonStore {
  // Spec: docs/architecture.md#4.2
  readJson<T>(filePath: string): Promise<T | null> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  exists(filePath: string): Promise<boolean> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  remove(filePath: string): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
}

export class FakeJsonlStore implements JsonlStore {
  // Spec: docs/architecture.md#4.2
  ensureDir(dirPath: string): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  appendLine(filePath: string, line: string): Promise<number> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  statFile(filePath: string): Promise<JsonlFileInfo | null> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  listFiles(dirPath: string, extension: string): Promise<readonly JsonlFileInfo[]> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  readFileText(filePath: string): Promise<string | null> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  deleteFile(filePath: string): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  deleteAllFiles(dirPath: string, extension: string): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
}

export class FakeProcessRunner implements ProcessRunner {
  // Spec: docs/architecture.md#4.2
  spawn(options: SpawnOptions): ManagedProcess {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  exec(
    command: string,
    args: readonly string[],
    options?: ProcessExecOptions,
  ): Promise<ExecResult> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  sendSignal(pid: number, signal: ProcessSignal): boolean {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  listProcesses(): Promise<readonly ProcessEntry[]> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  terminateWithEscalation(proc: ManagedProcess, graceMs: number): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
}

export class FakeProcessTreeController implements ProcessTreeController {
  // Spec: docs/architecture.md#4.2
  collectDescendants(rootPid: number): Promise<readonly number[]> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  freezeTree(rootPid: number): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  resumeTree(rootPid: number): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
}

export class FakeProcessExit implements ProcessExitPort {
  // Spec: docs/architecture.md#4.2
  exit(code: number): never {
    throw new Error("NOT_IMPLEMENTED");
  }
}

export class FakeCdpClient implements CdpClientPort {
  // Spec: docs/architecture.md#4.2
  connect(port: number): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  disconnect(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  isConnected(): boolean {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  dispatchTouchEvent(
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    touchPoints: readonly { readonly x: number; readonly y: number; readonly id: number }[],
  ): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  insertText(text: string): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  dispatchKey(key: SpecialKey): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  navigate(url: string): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  goBack(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  goForward(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  reload(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  evaluate<T = unknown>(expression: string): Promise<T> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  addScriptToEvaluateOnNewDocument(source: string): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  getPageInfo(): Promise<BrowserPageInfo> {
    throw new Error("NOT_IMPLEMENTED");
  }
}

export class FakeX11Input implements X11InputPort {
  // Spec: docs/architecture.md#4.2
  dispatchMouseOrWheel(frame: TouchFrame): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  typeText(text: string): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  pressKey(key: SpecialKey): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  goBack(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  goForward(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  reload(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
}

export class FakeGpuHardwareProbe implements GpuHardwareProbePort {
  // Spec: docs/architecture.md#4.2
  hasNvidiaDevice(): Promise<boolean> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  probeNvenc(): Promise<boolean> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  findDriRenderNodes(): Promise<readonly { readonly path: string; readonly vendorId: string }[]> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  probeVaapiEncode(devicePath: string, driverName: string): Promise<boolean> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  hasWslDxgDevice(): Promise<boolean> {
    throw new Error("NOT_IMPLEMENTED");
  }
}

export class FakeSessionTransport implements SessionTransportPort {
  readonly id: SessionConnectionId;

  // Spec: docs/architecture.md#4.2
  constructor(id: SessionConnectionId) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  sendBinary(data: Uint8Array): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  getBufferedAmount(): number {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  close(code: WsCloseCode, reason?: string): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#4.2
  setBufferedAmount(bytes: number): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}

export type FakeHelperPlaceholder = AlignedDimensions | EncoderBackend;
