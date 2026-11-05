import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserManager, isSafeHttpUrl } from '../src/browser/manager.js';
import * as processTree from '../src/utils/processTree.js';

describe('BrowserManager Core Lifecycle, Profile Lock Cleanup & Security', () => {
  let tmpDir: string;
  let profileDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesroid-bm-test-'));
    profileDir = path.join(tmpDir, 'browser-profile');
    fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('validates HTTP/HTTPS navigation URLs strictly via isSafeHttpUrl and BrowserManager.navigate', async () => {
    expect(isSafeHttpUrl('https://www.youtube.com')).toBe(true);
    expect(isSafeHttpUrl('http://localhost:8080/test')).toBe(true);
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('chrome://gpu')).toBe(false);
    expect(isSafeHttpUrl('')).toBe(false);
    expect(isSafeHttpUrl(null)).toBe(false);

    const bm = new BrowserManager({ profileDir });
    await expect(bm.navigate('file:///etc/shadow')).rejects.toThrow(
      /Only http:\/\/ and https:\/\//,
    );
  });

  it('sends SIGSTOP leaf-to-root on pause() and SIGCONT root-to-leaf on resume()', () => {
    const bm = new BrowserManager({ profileDir });
    (bm as any).state = 'running';
    (bm as any).chromeProcess = { pid: 1000, exitCode: null };

    vi.spyOn(processTree, 'getProcessTree').mockReturnValue([1000, 1001, 1002]);
    const sentSignals: Array<{ pid: number; sig: any }> = [];
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig: any) => {
      sentSignals.push({ pid, sig });
      return true;
    }) as any);

    // Pause -> leaf-to-root SIGSTOP (1002 -> 1001 -> 1000)
    bm.pause();
    expect(bm.getState()).toBe('paused');
    expect(sentSignals).toEqual([
      { pid: 1002, sig: 'SIGSTOP' },
      { pid: 1001, sig: 'SIGSTOP' },
      { pid: 1000, sig: 'SIGSTOP' },
    ]);

    // Resume -> root-to-leaf SIGCONT (1000 -> 1001 -> 1002)
    sentSignals.length = 0;
    bm.resume();
    expect(bm.getState()).toBe('running');
    expect(sentSignals).toEqual([
      { pid: 1000, sig: 'SIGCONT' },
      { pid: 1001, sig: 'SIGCONT' },
      { pid: 1002, sig: 'SIGCONT' },
    ]);
  });

  it('cleans stale Singleton locks and rewrites Crashed exit_type to Normal in Chrome Preferences', () => {
    const bm = new BrowserManager({ profileDir });

    const lockFile = path.join(profileDir, 'SingletonLock');
    const cookieFile = path.join(profileDir, 'SingletonCookie');
    const prefsFile = path.join(profileDir, 'Default', 'Preferences');

    fs.writeFileSync(lockFile, 'stale-lock', 'utf-8');
    fs.writeFileSync(cookieFile, 'stale-cookie', 'utf-8');
    fs.writeFileSync(
      prefsFile,
      JSON.stringify({ profile: { exit_type: 'Crashed', exited_cleanly: false } }),
      'utf-8',
    );

    (bm as any).cleanProfileLocks();

    expect(fs.existsSync(lockFile)).toBe(false);
    expect(fs.existsSync(cookieFile)).toBe(false);

    const updatedPrefs = fs.readFileSync(prefsFile, 'utf-8');
    expect(updatedPrefs).toContain('"exit_type":"Normal"');
    expect(updatedPrefs).toContain('"exited_cleanly":true');
  });

  it('clamps and even-aligns resize() dimensions and returns false when unchanged', async () => {
    const bm = new BrowserManager({ profileDir, width: 1280, height: 720 });

    // Unchanged resolution -> returns false immediately
    expect(await bm.resize(1280, 720)).toBe(false);

    // Clamps below minimum (100x100 -> 640x360) and above maximum (4000x3000 -> 1920x1080)
    await bm.resize(100, 100);
    expect(bm.getDimensions()).toEqual({ width: 640, height: 360 });

    await bm.resize(4001, 3001);
    expect(bm.getDimensions()).toEqual({ width: 1920, height: 1080 });
  });

  it('generates borderless non-fullscreen Openbox rc.xml configuration for Xvfb window framing', () => {
    const prevHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const bm = new BrowserManager({ profileDir });
      (bm as any).ensureOpenboxConfig();

      const rcXmlPath = path.join(tmpDir, '.config', 'openbox', 'rc.xml');
      expect(fs.existsSync(rcXmlPath)).toBe(true);
      const xml = fs.readFileSync(rcXmlPath, 'utf-8');
      expect(xml).toContain('<decor>no</decor>');
      expect(xml).toContain('<fullscreen>no</fullscreen>');
    } finally {
      process.env.HOME = prevHome;
    }
  });

  it('validates Tesroid Chrome MV3 extension (zoom [50..250] clamping & Web Fullscreen interception)', () => {
    const extDir = path.resolve(__dirname, '../extension');
    const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf-8'));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.content_scripts[0].world).toBe('MAIN');
    expect(manifest.content_scripts[0].run_at).toBe('document_start');

    const contentJs = fs.readFileSync(path.join(extDir, 'content.js'), 'utf-8');
    const cssVars = new Map<string, string>();
    const bodyClasses = new Set<string>();
    const rootClasses = new Set<string>();
    const makeClassList = (set: Set<string>) => ({
      add: (c: string) => set.add(c),
      remove: (c: string) => set.delete(c),
      contains: (c: string) => set.has(c),
    });

    class FakeElement {
      public classList = makeClassList(new Set());
      public style: any = {};
      public removeAttribute() {}
      public dispatchEvent() {
        return true;
      }
    }

    const mockDoc: any = {
      cookie: '',
      head: { appendChild: vi.fn() },
      documentElement: {
        style: {
          setProperty: (k: string, v: string) => cssVars.set(k, v),
          getPropertyValue: (k: string) => cssVars.get(k) || '',
        },
        classList: makeClassList(rootClasses),
      },
      body: {
        classList: makeClassList(bodyClasses),
      },
      getElementById: () => null,
      querySelector: () => null,
      createElement: () => ({ id: '', textContent: '', style: {} }),
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
    };

    const mockWin: any = {
      document: mockDoc,
      Element: FakeElement,
      Event: class {
        type: string;
        constructor(t: string) {
          this.type = t;
        }
      },
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      setInterval: vi.fn(() => 1),
    };

    const ctx = vm.createContext({
      window: mockWin,
      document: mockDoc,
      Element: FakeElement,
      Event: mockWin.Event,
      setInterval: mockWin.setInterval,
      Promise,
      Object,
      Number,
      String,
      isNaN,
    });

    vm.runInContext(contentJs, ctx);

    // Default scale is 120%; out-of-range values fall back to 120%, valid [50..250] set --tesroid-zoom
    expect(mockWin.__tesroidDisplayScale).toBe(120);
    mockWin.tesroidSetZoom(150);
    expect(cssVars.get('--tesroid-zoom')).toBe('1.5');
    mockWin.tesroidSetZoom(999);
    expect(mockWin.__tesroidDisplayScale).toBe(120);

    // Element.prototype.requestFullscreen enters CSS Web Fullscreen without OS X11 fullscreen
    const videoContainer = new FakeElement();
    (videoContainer as any).requestFullscreen();
    expect(bodyClasses.has('tesroid-web-fs-active')).toBe(true);
    expect(mockDoc.fullscreen).toBe(true);
    expect(mockDoc.fullscreenElement).toBe(videoContainer);

    mockDoc.exitFullscreen();
    expect(bodyClasses.has('tesroid-web-fs-active')).toBe(false);
    expect(mockDoc.fullscreen).toBe(false);
  });
});
