import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findProcessesByName,
  getProcessMap,
  getProcessState,
  getProcessTree,
  type ProcessTreeDeps,
  sendSignal,
  sendSignalToTree,
} from '../src/utils/processTree.js';

const hasProcessTableAccess = (() => {
  const { allPids } = getProcessMap();
  return allPids.has(process.pid);
})();

describe('processTree deterministic unit tests (Linux /proc & Darwin ps)', () => {
  it('parses Linux /proc/<pid>/stat accurately including spaces and nested parentheses in comm', () => {
    const procStats: Record<string, string> = {
      '/proc/100/stat': '100 (chrome) S 1 100 100 0 -1 4194560 123 0 0 0 10 5 0 0 20 0 10 0',
      '/proc/101/stat': '101 (chrome (gpu)) T 100 100 100 0 -1 4194560 45 0 0 0 2 1 0 0 20 0 4 0',
      '/proc/102/stat': '102 (Web Content) R 100 100 100 0 -1 4194560 12 0 0 0 1 0 0 0 20 0 2 0',
      '/proc/103/stat': '103 (zygote_child) S 101 100 100 0 -1 4194560 5 0 0 0 0 0 0 0 20 0 1 0',
      '/proc/999/stat': 'malformed_stat_without_parens',
    };

    const deps: ProcessTreeDeps = {
      readdirSync: () => ['100', '101', '102', '103', '999', 'self', 'cpuinfo'],
      readFileSync: (p) => {
        if (procStats[p]) return procStats[p];
        throw new Error('ENOENT');
      },
    };

    const { processInfoMap, allPids } = getProcessMap(deps);
    expect(allPids.has(100)).toBe(true);
    expect(processInfoMap.get(101)).toEqual({
      pid: 101,
      comm: 'chrome (gpu)',
      state: 'T',
      ppid: 100,
    });
    expect(processInfoMap.get(102)?.comm).toBe('Web Content');
    expect(processInfoMap.has(999)).toBe(false);

    // Top-down BFS order: root (100) -> children (101, 102) -> grandchild (103)
    expect(getProcessTree(100, { deps })).toEqual([100, 101, 102, 103]);
    expect(getProcessTree(100, { includeRoot: false, deps })).toEqual([101, 102, 103]);

    // Direct state lookup via /proc/<pid>/stat
    expect(getProcessState(101, deps)).toBe('T');
    expect(getProcessState(102, deps)).toBe('R');
    expect(getProcessState(999, deps)).toBeNull();
  });

  it('handles PPID cycle anomalies without infinite loops', () => {
    const deps: ProcessTreeDeps = {
      readdirSync: () => ['200', '201'],
      readFileSync: (p) =>
        p === '/proc/200/stat' ? '200 (procA) S 201 0 0' : '201 (procB) S 200 0 0',
    };

    expect(getProcessTree(200, { deps })).toEqual([200, 201]);
  });

  it('falls back to ps output when /proc is unavailable', () => {
    const psTable = [
      '  500     1 S+   /Applications/Google Chrome',
      '  501   500 T    /Applications/Google Chrome Helper',
      '  502   501 R    renderer_worker',
    ].join('\n');

    const deps: ProcessTreeDeps = {
      readdirSync: () => {
        throw new Error('ENOENT: no /proc');
      },
      readFileSync: () => {
        throw new Error('ENOENT: no /proc');
      },
      execPs: (args) => {
        if (args[0] === '-axo') return psTable;
        if (args[0] === '-o' && args[3] === '501') return 'T+\n';
        return '';
      },
    };

    expect(getProcessTree(500, { deps })).toEqual([500, 501, 502]);
    expect(getProcessState(501, deps)).toBe('T');
    expect(getProcessState(8888, deps)).toBeNull();
  });

  it('matches Linux 15-character truncated comm names in findProcessesByName', () => {
    const deps: ProcessTreeDeps = {
      readdirSync: () => ['301', '302', '303'],
      readFileSync: (p) => {
        if (p === '/proc/301/stat') return '301 (google-chrome-s) S 1 0 0'; // 15-char truncated "google-chrome-stable"
        if (p === '/proc/302/stat') return '302 (chrome_crashpad) S 1 0 0'; // 15-char truncated "chrome_crashpad_handler"
        return '303 (pulseaudio) S 1 0 0';
      },
    };

    const matches = findProcessesByName(['google-chrome-stable', 'chrome_crashpad_handler'], deps);
    expect(matches).toEqual([301, 302]);
  });

  it('orders signals bottom-up for SIGSTOP and top-down for SIGCONT, and rethrows EPERM', () => {
    const sent: Array<{ pid: number; sig: NodeJS.Signals | number }> = [];
    const deps: ProcessTreeDeps = {
      readdirSync: () => ['10', '20', '30'],
      readFileSync: (p) => {
        if (p === '/proc/10/stat') return '10 (root) S 1 0 0';
        if (p === '/proc/20/stat') return '20 (child) S 10 0 0';
        return '30 (leaf) S 20 0 0';
      },
      kill: (pid, sig) => {
        sent.push({ pid, sig });
      },
    };

    sendSignalToTree(10, 'SIGSTOP', 'bottom-up', deps);
    expect(sent.map((s) => s.pid)).toEqual([30, 20, 10]);

    sent.length = 0;
    sendSignalToTree(10, 'SIGCONT', 'top-down', deps);
    expect(sent.map((s) => s.pid)).toEqual([10, 20, 30]);

    // Rethrow EPERM while ignoring ESRCH
    expect(() =>
      sendSignal(10, 'SIGKILL', {
        kill: () => {
          const err: any = new Error('Operation not permitted');
          err.code = 'EPERM';
          throw err;
        },
      }),
    ).toThrow('Operation not permitted');
  });

  it('safely ignores ESRCH when sending signals to a non-existent PID', () => {
    const nonExistentPid = 99999999;

    expect(sendSignal(nonExistentPid, 'SIGSTOP')).toBe(false);
    expect(sendSignal(nonExistentPid, 'SIGCONT')).toBe(false);
    expect(() => sendSignalToTree(nonExistentPid, 'SIGSTOP')).not.toThrow();
  });
});

if (hasProcessTableAccess) {
  describe('processTree live OS integration tests', () => {
    const spawnedProcesses: ChildProcess[] = [];

    afterEach(() => {
      for (const proc of spawnedProcesses) {
        if (proc.pid) {
          try {
            process.kill(proc.pid, 'SIGKILL');
          } catch {}
        }
      }
      spawnedProcesses.length = 0;
    });

    it('detects a live two-level process tree (child -> grandchild) via spawn', async () => {
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

      const pids = await new Promise<{ childPid: number; grandchildPid: number }>(
        (resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Timeout waiting for child ready')),
            5000,
          );
          child.stdout?.once('data', (data) => {
            clearTimeout(timeout);
            try {
              resolve(JSON.parse(data.toString().trim()));
            } catch (e) {
              reject(e);
            }
          });
          child.once('error', reject);
        },
      );

      await new Promise((r) => setTimeout(r, 100));

      const tree = getProcessTree(child.pid!);
      expect(tree).toContain(pids.childPid);
      expect(tree).toContain(pids.grandchildPid);
      expect(tree.indexOf(pids.childPid)).toBeLessThan(tree.indexOf(pids.grandchildPid));

      const descendantsOnly = getProcessTree(child.pid!, { includeRoot: false });
      expect(descendantsOnly).not.toContain(pids.childPid);
      expect(descendantsOnly).toContain(pids.grandchildPid);

      try {
        process.kill(pids.grandchildPid, 'SIGKILL');
      } catch {}
    });

    it('verifies process state transitions to T on SIGSTOP and resumes on SIGCONT', async () => {
      const proc = spawn('sleep', ['300']);
      spawnedProcesses.push(proc);
      const pid = proc.pid!;

      expect(getProcessState(pid)).not.toBe('T');
      sendSignal(pid, 'SIGSTOP');

      let stateAfterStop: string | null = null;
      for (let i = 0; i < 20; i++) {
        stateAfterStop = getProcessState(pid);
        if (stateAfterStop === 'T') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(stateAfterStop).toBe('T');

      if (fs.existsSync(`/proc/${pid}/stat`)) {
        const statContent = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
        const lastParen = statContent.lastIndexOf(')');
        const stateDirect = statContent
          .slice(lastParen + 2)
          .trimStart()
          .split(/\s+/)[0];
        expect(stateDirect).toBe('T');
      }

      sendSignal(pid, 'SIGCONT');

      let stateAfterResume: string | null = null;
      for (let i = 0; i < 20; i++) {
        stateAfterResume = getProcessState(pid);
        if (stateAfterResume !== 'T') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(['S', 'R']).toContain(stateAfterResume);
    });

    it('finds live processes by executable name without matching unintended commands', () => {
      const proc = spawn('sleep', ['300']);
      spawnedProcesses.push(proc);

      expect(findProcessesByName(['sleep'])).toContain(proc.pid);
      expect(findProcessesByName(['nonexistent_process_xyz_123'])).toHaveLength(0);
    });
  });
}
