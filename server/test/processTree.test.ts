import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import {
  getProcessMap,
  getProcessTree,
  getProcessState,
  sendSignal,
  sendSignalToTree,
  findProcessesByName,
} from '../src/utils/processTree.js';

const hasProcessTableAccess = (() => {
  const { allPids } = getProcessMap();
  return allPids.has(process.pid);
})();

describe('processTree helper tests', () => {
  const spawnedProcesses: ChildProcess[] = [];

  afterEach(() => {
    // Ensure all spawned test processes are cleanly terminated
    for (const proc of spawnedProcesses) {
      if (proc.pid) {
        try {
          process.kill(proc.pid, 'SIGKILL');
        } catch {}
      }
    }
    spawnedProcesses.length = 0;
  });

  it.skipIf(!hasProcessTableAccess)('should detect a two-level process tree (child -> grandchild) via spawn', async () => {
    // Child process spawns a grandchild process directly using spawn (not via sh -c)
    const childScript = `
      const { spawn } = require('node:child_process');
      const grandchild = spawn('sleep', ['300']);
      console.log(JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }));
      setInterval(() => {}, 1000);
    `;

    const child = spawn(process.execPath, ['-e', childScript], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    spawnedProcesses.push(child);

    // Wait for child to output grandchild PID
    const pids = await new Promise<{ childPid: number; grandchildPid: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for child ready')), 5000);
      child.stdout?.once('data', (data) => {
        clearTimeout(timeout);
        try {
          const parsed = JSON.parse(data.toString().trim());
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
      child.once('error', reject);
    });

    expect(pids.childPid).toBe(child.pid);
    expect(pids.grandchildPid).toBeGreaterThan(0);

    // Allow procfs a moment to settle
    await new Promise((r) => setTimeout(r, 100));

    // Discover process tree rooted at child.pid
    const tree = getProcessTree(child.pid!);

    expect(tree).toContain(pids.childPid);
    expect(tree).toContain(pids.grandchildPid);

    // Check parent is before grandchild in top-down BFS order
    const parentIndex = tree.indexOf(pids.childPid);
    const grandchildIndex = tree.indexOf(pids.grandchildPid);
    expect(parentIndex).toBeLessThan(grandchildIndex);

    // With includeRoot: false, only descendants should be returned
    const descendantsOnly = getProcessTree(child.pid!, { includeRoot: false });
    expect(descendantsOnly).not.toContain(pids.childPid);
    expect(descendantsOnly).toContain(pids.grandchildPid);

    // Clean up grandchild explicitly
    try {
      process.kill(pids.grandchildPid, 'SIGKILL');
    } catch {}
  });

  it.skipIf(!hasProcessTableAccess)('should verify /proc/<pid>/stat state changes to T on SIGSTOP and resumes on SIGCONT', async () => {
    const proc = spawn('sleep', ['300']);
    spawnedProcesses.push(proc);
    const pid = proc.pid!;
    expect(pid).toBeGreaterThan(0);

    // Verify initial state is running or sleeping (not T)
    const initialState = getProcessState(pid);
    expect(initialState).not.toBeNull();
    expect(initialState).not.toBe('T');

    // Send SIGSTOP
    sendSignal(pid, 'SIGSTOP');

    // Poll until state becomes 'T' (stopped)
    let stateAfterStop: string | null = null;
    for (let i = 0; i < 20; i++) {
      stateAfterStop = getProcessState(pid);
      if (stateAfterStop === 'T') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(stateAfterStop).toBe('T');

    // Also verify directly reading /proc/<pid>/stat on Linux
    if (fs.existsSync(`/proc/${pid}/stat`)) {
      const statContent = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const lastParen = statContent.lastIndexOf(')');
      const stateDirect = statContent.slice(lastParen + 2).trimStart().split(/\s+/)[0];
      expect(stateDirect).toBe('T');
    }

    // Send SIGCONT
    sendSignal(pid, 'SIGCONT');

    // Poll until state resumes (no longer 'T')
    let stateAfterResume: string | null = null;
    for (let i = 0; i < 20; i++) {
      stateAfterResume = getProcessState(pid);
      if (stateAfterResume !== 'T') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(stateAfterResume).not.toBe('T');
    expect(['S', 'R']).toContain(stateAfterResume);
  });

  it('should safely ignore ESRCH when sending signals to a non-existent PID', () => {
    const nonExistentPid = 99999999;

    // sendSignal should return false and NOT throw on ESRCH
    expect(() => {
      const result = sendSignal(nonExistentPid, 'SIGSTOP');
      expect(result).toBe(false);
    }).not.toThrow();

    expect(() => {
      const result = sendSignal(nonExistentPid, 'SIGCONT');
      expect(result).toBe(false);
    }).not.toThrow();

    // sendSignalToTree should handle non-existent root without throwing
    expect(() => {
      sendSignalToTree(nonExistentPid, 'SIGSTOP');
    }).not.toThrow();

    // Direct process.kill with try/catch ESRCH guard pattern
    expect(() => {
      try {
        process.kill(nonExistentPid, 'SIGSTOP');
      } catch (err: any) {
        if (err?.code !== 'ESRCH') {
          throw err;
        }
      }
    }).not.toThrow();
  });

  it.skipIf(!hasProcessTableAccess)('should find processes by executable name without matching unintended commands', () => {
    const proc = spawn('sleep', ['300']);
    spawnedProcesses.push(proc);

    const matches = findProcessesByName(['sleep']);
    expect(matches).toContain(proc.pid);

    const nonMatches = findProcessesByName(['nonexistent_process_xyz_123']);
    expect(nonMatches).toHaveLength(0);
  });
});
