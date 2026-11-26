import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";

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

const DEFAULT_LIST_PROCESSES_TIMEOUT_MS = 5_000;
const EXEC_KILL_ESCALATION_MS = 200;

function toUint8Array(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) {
    return new Uint8Array(chunk);
  }
  return new TextEncoder().encode(String(chunk));
}

function wrapChildProcess(child: ChildProcess): ManagedProcess {
  return {
    get pid(): number | null {
      return typeof child.pid === "number" ? child.pid : null;
    },
    onStdout(listener: (chunk: Uint8Array) => void): void {
      child.stdout?.on("data", (chunk: unknown) => {
        listener(toUint8Array(chunk));
      });
    },
    onStderr(listener: (chunk: Uint8Array) => void): void {
      child.stderr?.on("data", (chunk: unknown) => {
        listener(toUint8Array(chunk));
      });
    },
    onExit(listener: (code: number | null, signal: string | null) => void): void {
      child.once("exit", (code, signal) => {
        listener(code, signal);
      });
    },
    onError(listener: (error: Error) => void): void {
      child.on("error", listener);
    },
    kill(signal: ProcessSignal = "SIGTERM"): boolean {
      if (child.pid === undefined || child.killed || child.exitCode !== null) {
        return false;
      }
      try {
        return child.kill(signal);
      } catch {
        return false;
      }
    },
  };
}

// Spec: docs/specs/06-browser-input-cdp.md#4
export function parseProcessListOutput(stdout: string): readonly ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3] ?? "";
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) {
      continue;
    }
    entries.push({ pid, ppid, command });
  }
  return entries;
}

export class NodeProcessRunner implements ProcessRunner {
  // Spec: docs/specs/05-encoder-gpu.md#2.1
  spawn(options: SpawnOptions): ManagedProcess {
    const child = nodeSpawn(options.command, [...options.args], {
      env: options.env,
      cwd: options.cwd,
      detached: options.detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return wrapChildProcess(child);
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.2
  exec(
    command: string,
    args: readonly string[],
    options?: ProcessExecOptions,
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = nodeSpawn(command, [...args], {
        env: options?.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let settled = false;
      let timeoutTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
      let escalationTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

      const finish = (exitCode: number | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutTimer !== undefined) {
          globalThis.clearTimeout(timeoutTimer);
        }
        if (escalationTimer !== undefined) {
          globalThis.clearTimeout(escalationTimer);
        }
        resolve({
          exitCode,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          timedOut,
        });
      };

      child.stdout?.on("data", (chunk: unknown) => {
        stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      });
      child.stderr?.on("data", (chunk: unknown) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      });

      if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
        timeoutTimer = globalThis.setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGTERM");
          } catch {
            // Process may have already exited.
          }
          escalationTimer = globalThis.setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // Ignore already-exited process.
            }
            finish(null);
          }, EXEC_KILL_ESCALATION_MS);
        }, options.timeoutMs);
      }

      child.once("error", (error) => {
        stderrChunks.push(Buffer.from(error.message));
        finish(null);
      });
      child.once("close", (code) => {
        finish(code);
      });
    });
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  sendSignal(pid: number, signal: ProcessSignal): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  // Spec: docs/specs/06-browser-input-cdp.md#4
  async listProcesses(): Promise<readonly ProcessEntry[]> {
    const result = await this.exec("ps", ["-eo", "pid=,ppid=,comm="], {
      timeoutMs: DEFAULT_LIST_PROCESSES_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 && result.stdout.length === 0) {
      return [];
    }
    return parseProcessListOutput(result.stdout);
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  terminateWithEscalation(proc: ManagedProcess, graceMs: number): Promise<void> {
    if (proc.pid === null) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      let escalationTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (escalationTimer !== undefined) {
          globalThis.clearTimeout(escalationTimer);
        }
        resolve();
      };

      proc.onExit(() => {
        finish();
      });

      if (!proc.kill("SIGTERM")) {
        finish();
        return;
      }

      escalationTimer = globalThis.setTimeout(
        () => {
          proc.kill("SIGKILL");
          finish();
        },
        Math.max(0, graceMs),
      );
    });
  }
}

export interface NodeProcessTreeControllerDeps {
  readonly processRunner: ProcessRunner;
}

export class NodeProcessTreeController implements ProcessTreeController {
  private readonly processRunner: ProcessRunner;

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  constructor(deps: NodeProcessTreeControllerDeps) {
    this.processRunner = deps.processRunner;
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  async collectDescendants(rootPid: number): Promise<readonly number[]> {
    if (!Number.isInteger(rootPid) || rootPid <= 0) {
      return [];
    }

    const entries = await this.processRunner.listProcesses();
    const childrenByParent = new Map<number, number[]>();
    for (const entry of entries) {
      const list = childrenByParent.get(entry.ppid);
      if (list === undefined) {
        childrenByParent.set(entry.ppid, [entry.pid]);
      } else {
        list.push(entry.pid);
      }
    }

    // Track visited PIDs so cyclic PPID entries cannot cause infinite traversal.
    const visited = new Set<number>([rootPid]);
    const queue: number[] = [rootPid];
    const descendants: number[] = [];

    for (let index = 0; index < queue.length; index += 1) {
      const currentPid = queue[index];
      if (currentPid === undefined) {
        continue;
      }
      const children = childrenByParent.get(currentPid);
      if (children === undefined) {
        continue;
      }
      for (const childPid of children) {
        if (visited.has(childPid)) {
          continue;
        }
        visited.add(childPid);
        descendants.push(childPid);
        queue.push(childPid);
      }
    }

    return descendants;
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  async freezeTree(rootPid: number): Promise<void> {
    if (!Number.isInteger(rootPid) || rootPid <= 0) {
      return;
    }
    const descendants = await this.collectDescendants(rootPid);
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      const pid = descendants[index];
      if (pid !== undefined) {
        this.processRunner.sendSignal(pid, "SIGSTOP");
      }
    }
    this.processRunner.sendSignal(rootPid, "SIGSTOP");
  }

  // Spec: docs/specs/06-browser-input-cdp.md#2.5
  async resumeTree(rootPid: number): Promise<void> {
    if (!Number.isInteger(rootPid) || rootPid <= 0) {
      return;
    }
    const descendants = await this.collectDescendants(rootPid);
    this.processRunner.sendSignal(rootPid, "SIGCONT");
    for (const pid of descendants) {
      this.processRunner.sendSignal(pid, "SIGCONT");
    }
  }
}

export class NodeProcessExit implements ProcessExitPort {
  // Spec: docs/specs/01-auth-security.md#2.2
  exit(code: number): never {
    process.exit(code);
  }
}
