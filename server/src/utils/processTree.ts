import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface ProcessTreeOptions {
  includeRoot?: boolean;
}

export interface ProcessInfo {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
}

/**
 * Reads /proc to discover all processes, their command names, states, and parent PIDs.
 */
export function getProcessMap(): {
  childrenMap: Map<number, number[]>;
  allPids: Set<number>;
  processInfoMap: Map<number, ProcessInfo>;
} {
  const childrenMap = new Map<number, number[]>();
  const allPids = new Set<number>();
  const processInfoMap = new Map<number, ProcessInfo>();

  let entries: string[] = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    // Fallback for macOS / Darwin / environments without /proc
    try {
      const out = execFileSync('ps', ['-axo', 'pid=,ppid=,state=,comm='], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (!match) continue;
        const pid = parseInt(match[1], 10);
        const ppid = parseInt(match[2], 10);
        const rawState = match[3];
        const state = rawState.charAt(0).toUpperCase();
        const fullComm = match[4].trim();
        const comm = fullComm.split('/').pop() || fullComm;

        allPids.add(pid);
        processInfoMap.set(pid, { pid, comm, state, ppid });
        if (!isNaN(ppid)) {
          let children = childrenMap.get(ppid);
          if (!children) {
            children = [];
            childrenMap.set(ppid, children);
          }
          children.push(pid);
        }
      }
    } catch {
      // Ignore ps failure
    }
    return { childrenMap, allPids, processInfoMap };
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = parseInt(entry, 10);
    allPids.add(pid);

    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf-8');
      const firstParen = stat.indexOf('(');
      const lastParen = stat.lastIndexOf(')');
      if (firstParen === -1 || lastParen === -1 || lastParen <= firstParen) continue;

      const comm = stat.slice(firstParen + 1, lastParen);
      const rest = stat.slice(lastParen + 2).trimStart();
      const parts = rest.split(/\s+/);
      const state = parts[0];
      const ppid = parseInt(parts[1], 10);

      processInfoMap.set(pid, { pid, comm, state, ppid });

      if (!isNaN(ppid)) {
        let children = childrenMap.get(ppid);
        if (!children) {
          children = [];
          childrenMap.set(ppid, children);
        }
        children.push(pid);
      }
    } catch {
      // Process could exit or be inaccessible, ignore
    }
  }

  return { childrenMap, allPids, processInfoMap };
}

/**
 * Returns all process IDs in the process tree rooted at rootPid.
 * Ordered top-down (rootPid first, then children, then grandchildren).
 * To traverse leaf-to-root, iterate or reverse the returned array.
 *
 * @param rootPid - Root process PID
 * @param options - Options (e.g. includeRoot, defaults to true)
 */
export function getProcessTree(rootPid: number, options: ProcessTreeOptions = {}): number[] {
  const includeRoot = options.includeRoot ?? true;
  const { childrenMap, allPids } = getProcessMap();

  const isRootAlive = allPids.has(rootPid);
  const hasChildren = childrenMap.has(rootPid);

  if (!isRootAlive && !hasChildren) {
    return [];
  }

  const result: number[] = [];
  const queue: number[] = [rootPid];
  const visited = new Set<number>([rootPid]);

  if (includeRoot && isRootAlive) {
    result.push(rootPid);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = childrenMap.get(current);
    if (children) {
      for (const child of children) {
        if (!visited.has(child)) {
          visited.add(child);
          result.push(child);
          queue.push(child);
        }
      }
    }
  }

  return result;
}

/**
 * Reads /proc/<pid>/stat to get process state (e.g. 'T' for stopped, 'S' for sleeping, 'R' for running).
 * Returns null if process does not exist or stat cannot be read.
 */
export function getProcessState(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const lastParen = stat.lastIndexOf(')');
    if (lastParen === -1) return null;
    const rest = stat.slice(lastParen + 2).trimStart();
    const parts = rest.split(/\s+/);
    return parts[0] || null;
  } catch {
    try {
      const out = execFileSync('ps', ['-o', 'state=', '-p', String(pid)], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!out) return null;
      return out.charAt(0).toUpperCase() || null;
    } catch {
      return null;
    }
  }
}

/**
 * Sends a signal to a process, ignoring ESRCH (No such process).
 * Returns true if signal was successfully sent, false if ESRCH.
 * Throws other errors (e.g. EPERM).
 */
export function sendSignal(pid: number, signal: NodeJS.Signals | number): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err: any) {
    if (err && err.code === 'ESRCH') {
      return false;
    }
    throw err;
  }
}

/**
 * Sends a signal to all processes in a tree rooted at rootPid.
 * Default order: 'bottom-up' (children/leaves first, then parent).
 */
export function sendSignalToTree(
  rootPid: number,
  signal: NodeJS.Signals | number,
  order: 'bottom-up' | 'top-down' = 'bottom-up'
): void {
  const pids = getProcessTree(rootPid);
  const targets = order === 'bottom-up' ? [...pids].reverse() : pids;
  for (const pid of targets) {
    sendSignal(pid, signal);
  }
}

/**
 * Finds all processes matching any of the specified executable names (comm field in /proc/<pid>/stat).
 * Handles Linux comm 15-character truncation automatically.
 */
export function findProcessesByName(names: string[]): number[] {
  const { processInfoMap } = getProcessMap();
  const matchedPids: number[] = [];
  const normalizedTargets = new Set(
    names.flatMap((n) => {
      const lower = n.toLowerCase();
      return lower.length > 15 ? [lower, lower.slice(0, 15)] : [lower];
    })
  );

  for (const [pid, info] of processInfoMap.entries()) {
    const commLower = info.comm.toLowerCase();
    if (normalizedTargets.has(commLower)) {
      matchedPids.push(pid);
    }
  }

  return matchedPids;
}
