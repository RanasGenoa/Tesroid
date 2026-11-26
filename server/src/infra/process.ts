export type ProcessSignal = "SIGTERM" | "SIGKILL" | "SIGSTOP" | "SIGCONT";

export interface SpawnOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly detached?: boolean;
}

export interface ManagedProcess {
  readonly pid: number | null;
  onStdout(listener: (chunk: Uint8Array) => void): void;
  onStderr(listener: (chunk: Uint8Array) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onError(listener: (error: Error) => void): void;
  kill(signal?: ProcessSignal): boolean;
}

export interface ExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

export interface ProcessExecOptions {
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ProcessRunner {
  spawn(options: SpawnOptions): ManagedProcess;
  exec(command: string, args: readonly string[], options?: ProcessExecOptions): Promise<ExecResult>;
  sendSignal(pid: number, signal: ProcessSignal): boolean;
  listProcesses(): Promise<readonly ProcessEntry[]>;
  terminateWithEscalation(proc: ManagedProcess, graceMs: number): Promise<void>;
}

export interface ProcessTreeController {
  collectDescendants(rootPid: number): Promise<readonly number[]>;
  freezeTree(rootPid: number): Promise<void>;
  resumeTree(rootPid: number): Promise<void>;
}

export interface ProcessExitPort {
  exit(code: number): never;
}

export class NodeProcessRunner implements ProcessRunner {
  // Spec: docs/specs/05-encoder-gpu.md#2.1
  spawn(options: SpawnOptions): ManagedProcess {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.2
  exec(
    command: string,
    args: readonly string[],
    options?: ProcessExecOptions,
  ): Promise<ExecResult> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  sendSignal(pid: number, signal: ProcessSignal): boolean {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#4
  listProcesses(): Promise<readonly ProcessEntry[]> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  terminateWithEscalation(proc: ManagedProcess, graceMs: number): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
}

export interface NodeProcessTreeControllerDeps {
  readonly processRunner: ProcessRunner;
}

export class NodeProcessTreeController implements ProcessTreeController {
  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  constructor(deps: NodeProcessTreeControllerDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  collectDescendants(rootPid: number): Promise<readonly number[]> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  freezeTree(rootPid: number): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  resumeTree(rootPid: number): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
}

export class NodeProcessExit implements ProcessExitPort {
  // Spec: docs/specs/01-auth-security.md#2.2
  exit(code: number): never {
    process.exit(code);
  }
}
