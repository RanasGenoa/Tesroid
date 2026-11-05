import { type ChildProcess, execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { findProcessesByName, getProcessTree } from '../utils/processTree.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface BrowserManagerOptions {
  displayNum?: string; // e.g. ':99'
  width?: number; // e.g. 1280
  height?: number; // e.g. 720
  profileDir?: string; // e.g. '/data/browser-profile'
  defaultUrl?: string; // e.g. 'https://www.youtube.com'
  vaapiDevice?: string; // e.g. '/dev/dri/renderD128'
  displayScale?: number; // e.g. 120 = 120%
}

export type BrowserState = 'stopped' | 'starting' | 'running' | 'paused' | 'error';

/**
 * Validates that a navigation target uses a safe HTTP/HTTPS scheme (prevents file://, chrome://, javascript:).
 */
export function isSafeHttpUrl(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export class BrowserManager {
  private displayNum: string;
  private width: number;
  private height: number;
  private profileDir: string;
  private defaultUrl: string;
  private vaapiDevice: string;
  private displayScale: number;

  private xvfbProcess: ChildProcess | null = null;
  private openboxProcess: ChildProcess | null = null;
  private chromeProcess: ChildProcess | null = null;

  private state: BrowserState = 'stopped';
  private currentUrl: string;

  private isStartingChrome = false;
  private isIntentionalChromeStop = false;
  private chromeRestartTimer: NodeJS.Timeout | null = null;

  constructor(options: BrowserManagerOptions = {}) {
    this.displayNum = options.displayNum || process.env.DISPLAY_NUM || ':99';
    this.width = options.width || Number(process.env.DISPLAY_WIDTH) || 1280;
    this.height = options.height || Number(process.env.DISPLAY_HEIGHT) || 720;
    this.profileDir =
      options.profileDir ||
      process.env.BROWSER_PROFILE_DIR ||
      path.join(process.env.DATA_DIR || '/data', 'browser-profile');
    this.defaultUrl = options.defaultUrl || process.env.BROWSER_URL || 'https://www.youtube.com';
    this.vaapiDevice = options.vaapiDevice || process.env.VAAPI_DEVICE || '/dev/dri/renderD128';
    this.displayScale = options.displayScale || Number(process.env.DISPLAY_SCALE) || 120;
    this.currentUrl = this.defaultUrl;
  }

  public getDisplayScale(): number {
    return this.displayScale;
  }

  public async setDisplayScale(scale: number): Promise<boolean> {
    const clamped = Math.max(50, Math.min(250, Math.round(Number(scale) || 120)));
    this.displayScale = clamped;
    console.log(`[BrowserManager] Setting browser display scale to ${clamped}%...`);

    if (!this.isChromeAlive()) {
      return true;
    }

    try {
      const res = await fetch('http://127.0.0.1:9222/json/list');
      const targets = (await res.json()) as any[];
      const page = targets.find((t: any) => t.type === 'page');
      if (!page || !page.webSocketDebuggerUrl) return false;

      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('CDP timeout')), 2000);
        ws.on('open', () => {
          clearTimeout(to);
          resolve(null);
        });
        ws.on('error', reject);
      });

      const zoomScript = `
        (() => {
          window.__tesroidDisplayScale = ${clamped};
          if (typeof window.tesroidSetZoom === 'function') {
            window.tesroidSetZoom(${clamped});
          } else if (document.documentElement) {
            document.documentElement.style.setProperty('--tesroid-zoom', '${clamped / 100}');
          }
        })()
      `;

      let msgId = 500;
      const send = (method: string, params: any) =>
        new Promise<any>((resolve) => {
          const id = msgId++;
          const to = setTimeout(() => resolve(null), 1500);
          const h = (d: any) => {
            try {
              const p = JSON.parse(d.toString());
              if (p.id === id) {
                clearTimeout(to);
                ws.off('message', h);
                resolve(p.result);
              }
            } catch {}
          };
          ws.on('message', h);
          ws.send(JSON.stringify({ id, method, params }));
        });

      await send('Page.enable', {});
      await send('Page.addScriptToEvaluateOnNewDocument', { source: zoomScript });
      await send('Runtime.evaluate', { expression: zoomScript });
      try {
        ws.close();
      } catch {}
      return true;
    } catch (err) {
      console.warn('[BrowserManager] Failed to dynamically apply displayScale via CDP:', err);
      return false;
    }
  }

  public getState(): BrowserState {
    return this.state;
  }

  public getCurrentUrl(): string {
    return this.currentUrl;
  }

  public getDisplay(): string {
    return this.displayNum;
  }

  public getDimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  public isChromeAlive(): boolean {
    return this.chromeProcess !== null && this.chromeProcess.exitCode === null;
  }

  /**
   * Start PulseAudio, Xvfb, Openbox, and Chrome
   */
  public async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      return;
    }
    this.state = 'starting';
    console.log(
      `[BrowserManager] Starting browser stack (Display: ${this.displayNum}, Resolution: ${this.width}x${this.height})...`,
    );

    try {
      this.ensureDirectories();
      await this.initPulseAudio();
      await this.startXvfb();
      await this.startOpenbox();
      await this.startChrome();
      this.state = 'running';
      console.log('[BrowserManager] Browser stack successfully started.');
    } catch (err) {
      console.error('[BrowserManager] Failed to start browser stack:', err);
      this.state = 'error';
      this.stop();
      throw err;
    }
  }

  /**
   * Pause Chrome processes to conserve CPU/GPU when no clients connected
   */
  public pause(): void {
    if (this.state !== 'running' || !this.chromeProcess || !this.chromeProcess.pid) {
      return;
    }
    console.log('[BrowserManager] Pausing Chrome process tree (SIGSTOP)...');
    try {
      const pids = getProcessTree(this.chromeProcess.pid);
      // 末端（子孫）から親の順に SIGSTOP
      for (let i = pids.length - 1; i >= 0; i--) {
        const pid = pids[i];
        try {
          process.kill(pid, 'SIGSTOP');
        } catch (err: any) {
          if (err?.code !== 'ESRCH') {
            console.warn(`[BrowserManager] Warning sending SIGSTOP to pid ${pid}:`, err);
          }
        }
      }
      this.state = 'paused';
      console.log('[BrowserManager] Chrome paused.');
    } catch (err) {
      console.warn('[BrowserManager] Error pausing Chrome:', err);
    }
  }

  /**
   * Resume Chrome processes
   */
  public resume(): void {
    if (this.state !== 'paused' || !this.chromeProcess || !this.chromeProcess.pid) {
      return;
    }
    console.log('[BrowserManager] Resuming Chrome process tree (SIGCONT)...');
    try {
      const pids = getProcessTree(this.chromeProcess.pid);
      // 親から子孫の順に SIGCONT
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGCONT');
        } catch (err: any) {
          if (err?.code !== 'ESRCH') {
            console.warn(`[BrowserManager] Warning sending SIGCONT to pid ${pid}:`, err);
          }
        }
      }
      this.state = 'running';
      console.log('[BrowserManager] Chrome resumed.');
    } catch (err) {
      console.warn('[BrowserManager] Error resuming Chrome:', err);
    }
  }

  /**
   * Navigate to a new URL
   */
  public async navigate(url: string): Promise<void> {
    if (!isSafeHttpUrl(url)) {
      throw new Error('Invalid URL: Only http:// and https:// URLs are permitted.');
    }
    this.currentUrl = url;
    if (this.state === 'paused') {
      this.resume();
    }
    console.log(`[BrowserManager] Navigating to: ${url}`);
    const navigated = await this.navigateViaCdp(url);
    if (!navigated) {
      await this.restartChrome(url);
    }
  }

  private async navigateViaCdp(url: string): Promise<boolean> {
    if (!this.isChromeAlive()) return false;
    try {
      const res = await fetch('http://127.0.0.1:9222/json/list');
      const targets = (await res.json()) as any[];
      const page = targets.find((t: any) => t.type === 'page');
      if (!page || !page.webSocketDebuggerUrl) return false;

      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('CDP timeout')), 2000);
        ws.on('open', () => {
          clearTimeout(to);
          resolve(null);
        });
        ws.on('error', reject);
      });

      const id = 999;
      await new Promise<void>((resolve) => {
        const to = setTimeout(() => {
          try {
            ws.close();
          } catch {}
          resolve();
        }, 2000);
        ws.on('message', (data: any) => {
          try {
            const parsed = JSON.parse(data.toString());
            if (parsed.id === id) {
              clearTimeout(to);
              try {
                ws.close();
              } catch {}
              resolve();
            }
          } catch {}
        });
        ws.send(JSON.stringify({ id, method: 'Page.navigate', params: { url } }));
      });
      console.log(`[BrowserManager] Successfully navigated via CDP to ${url}`);
      return true;
    } catch (err) {
      console.warn('[BrowserManager] navigateViaCdp failed, falling back to restart:', err);
      return false;
    }
  }

  /**
   * Restart Chrome instance (e.g. for recovery or URL reload)
   */
  public async restartChrome(url?: string): Promise<void> {
    const targetUrl = url || this.currentUrl;
    console.log(`[BrowserManager] Restarting Chrome with URL: ${targetUrl}`);
    this.stopChrome();
    await new Promise((r) => setTimeout(r, 600));
    await this.startChrome(targetUrl);
    this.state = 'running';
  }

  /**
   * Stop all processes and clean up
   */
  public stop(): void {
    console.log('[BrowserManager] Stopping all browser stack processes...');
    this.stopChrome();
    this.stopOpenbox();
    this.stopXvfb();
    this.state = 'stopped';
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.profileDir)) {
      fs.mkdirSync(this.profileDir, { recursive: true });
    }
  }

  private async initPulseAudio(): Promise<void> {
    try {
      console.log('[BrowserManager] Initializing PulseAudio daemon...');

      // 1. Ensure config directory and tesroid.pa exist
      const pulseConfig =
        [
          'load-module module-native-protocol-unix socket=/tmp/pulse-socket auth-anonymous=1',
          'load-module module-native-protocol-tcp auth-anonymous=1 port=4713',
          'load-module module-null-sink sink_name=virtual_sink rate=48000 channels=2 format=s16le sink_properties=device.description=Virtual_Sink',
          'set-default-sink virtual_sink',
        ].join('\n') + '\n';

      try {
        fs.mkdirSync('/etc/pulse', { recursive: true });
        if (!fs.existsSync('/etc/pulse/tesroid.pa')) {
          fs.writeFileSync('/etc/pulse/tesroid.pa', pulseConfig, 'utf-8');
        }
        // Ensure flat-volumes = no to prevent stream volume changes from attenuating sink volume
        if (!fs.existsSync('/etc/pulse/daemon.conf')) {
          fs.writeFileSync('/etc/pulse/daemon.conf', 'flat-volumes = no\n', 'utf-8');
        } else {
          const daemonConf = fs.readFileSync('/etc/pulse/daemon.conf', 'utf-8');
          if (!daemonConf.includes('flat-volumes')) {
            fs.appendFileSync('/etc/pulse/daemon.conf', '\nflat-volumes = no\n', 'utf-8');
          }
        }
      } catch {}

      // 2. Clean up stale pid/runtime files and old socket
      try {
        execSync('rm -rf /tmp/pulse* /root/.config/pulse/*runtime* 2>/dev/null || true');
        execSync('pulseaudio -k 2>/dev/null || true');
      } catch {}

      await new Promise((r) => setTimeout(r, 200));

      // 3. Start PulseAudio with dedicated tesroid.pa configuration
      execSync(
        'pulseaudio -n -F /etc/pulse/tesroid.pa --exit-idle-time=-1 --disallow-exit -D 2>/dev/null || ' +
          'pulseaudio -D --exit-idle-time=-1 2>/dev/null || true',
      );

      // 4. Wait for socket to become available
      await this.waitForSocket('/tmp/pulse-socket', 3000).catch(() => {});

      // 5. Ensure virtual_sink exists and is default
      try {
        const sinks = execSync(
          'pactl -s unix:/tmp/pulse-socket list short sinks 2>/dev/null || pactl list short sinks 2>/dev/null || true',
        ).toString();
        if (!sinks.includes('virtual_sink')) {
          execSync(
            'pactl -s unix:/tmp/pulse-socket load-module module-null-sink sink_name=virtual_sink rate=48000 channels=2 format=s16le sink_properties=device.description=Virtual_Sink 2>/dev/null || true',
          );
        }
        execSync(
          'pactl -s unix:/tmp/pulse-socket set-default-sink virtual_sink 2>/dev/null || true',
        );
        // Lock virtual_sink to full volume (100% / 0dB) and unmuted to prevent attenuation
        execSync(
          'pactl -s unix:/tmp/pulse-socket set-sink-volume virtual_sink 100% 2>/dev/null || true',
        );
        execSync(
          'pactl -s unix:/tmp/pulse-socket set-sink-mute virtual_sink 0 2>/dev/null || true',
        );
      } catch {}

      console.log('[BrowserManager] PulseAudio virtual sink ready (unix:/tmp/pulse-socket).');
    } catch (err) {
      console.warn('[BrowserManager] PulseAudio init warning (will continue):', err);
    }
  }

  private async startXvfb(): Promise<void> {
    // Ensure /tmp/.X11-unix directory exists
    try {
      if (!fs.existsSync('/tmp/.X11-unix')) {
        fs.mkdirSync('/tmp/.X11-unix', { recursive: true, mode: 0o1777 });
      }
    } catch {}

    // Remove old X lock if exists
    const lockFile = `/tmp/.X${this.displayNum.replace(':', '')}-lock`;
    const socketFile = `/tmp/.X11-unix/X${this.displayNum.replace(':', '')}`;
    try {
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
      if (fs.existsSync(socketFile)) fs.unlinkSync(socketFile);
    } catch {}

    // Start Xvfb with at least 1920x1080 so any client resolution up to 1080p fits perfectly
    const xvfbW = Math.max(1920, this.width);
    const xvfbH = Math.max(1080, this.height);
    const args = [
      this.displayNum,
      '-screen',
      '0',
      `${xvfbW}x${xvfbH}x24`,
      '-ac',
      '+extension',
      'GLX',
      '+extension',
      'RANDR',
      '+render',
      '-noreset',
    ];

    console.log(`[BrowserManager] Spawning Xvfb: Xvfb ${args.join(' ')}`);
    this.xvfbProcess = spawn('Xvfb', args, {
      stdio: 'ignore',
      detached: true,
    });
    this.xvfbProcess.unref();

    // Wait for X server socket to appear
    await this.waitForSocket(socketFile, 3000);
  }

  /**
   * Dynamically resize the browser window to match client viewport
   */
  public async resize(width: number, height: number): Promise<boolean> {
    // Clamp to valid range (even numbers required for H.264 encoding)
    const w = Math.max(640, Math.min(1920, width)) & ~1;
    const h = Math.max(360, Math.min(1080, height)) & ~1;

    if (w === this.width && h === this.height) {
      return false; // No change needed
    }

    console.log(
      `[BrowserManager] Resizing browser window from ${this.width}x${this.height} to ${w}x${h}...`,
    );
    this.width = w;
    this.height = h;

    try {
      // Unset any stuck OS-level fullscreen state before resizing
      execSync(
        `DISPLAY=${this.displayNum} wmctrl -r :ACTIVE: -b remove,fullscreen 2>/dev/null || true; ` +
          `DISPLAY=${this.displayNum} xdotool search --class google-chrome windowsize %@ ${w} ${h} windowmove %@ 0 0 2>/dev/null || ` +
          `DISPLAY=${this.displayNum} xdotool search --class chrome windowsize %@ ${w} ${h} windowmove %@ 0 0 2>/dev/null || true`,
      );
      console.log(`[BrowserManager] Chrome resized to ${w}x${h}.`);
      return true;
    } catch (err) {
      console.warn('[BrowserManager] Error resizing Chrome window:', err);
      return false;
    }
  }

  /**
   * Toggle Web Fullscreen on active video or YouTube player via CDP
   */
  public async toggleVideoFullscreen(): Promise<boolean> {
    try {
      const res = await fetch('http://127.0.0.1:9222/json/list');
      const targets = (await res.json()) as any[];
      const page = targets.find((t: any) => t.type === 'page');
      if (!page || !page.webSocketDebuggerUrl) {
        console.warn('[BrowserManager] No CDP page target found for toggleVideoFullscreen');
        return false;
      }

      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('CDP timeout')), 2000);
        ws.on('open', () => {
          clearTimeout(to);
          resolve(null);
        });
        ws.on('error', reject);
      });

      const script = `
        (() => {
          if (window.tesroidToggleFs) {
            window.tesroidToggleFs();
            return 'toggled_via_tesroid';
          }
          const fsBtn = document.querySelector('.ytp-fullscreen-button');
          if (fsBtn) {
            fsBtn.click();
            return 'clicked_fs_btn';
          }
          const video = document.querySelector('video');
          if (video && video.requestFullscreen) {
            video.requestFullscreen();
            return 'requested_video_fs';
          }
          return 'no_action';
        })()
      `;

      const id = 888;
      await new Promise<void>((resolve) => {
        const to = setTimeout(() => {
          try {
            ws.close();
          } catch {}
          resolve();
        }, 1500);
        ws.on('message', (d: any) => {
          try {
            const p = JSON.parse(d.toString());
            if (p.id === id) {
              clearTimeout(to);
              try {
                ws.close();
              } catch {}
              resolve();
            }
          } catch {}
        });
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: script } }));
      });
      console.log('[BrowserManager] Successfully toggled video fullscreen via CDP.');
      return true;
    } catch (err) {
      console.warn('[BrowserManager] Failed to toggle video fullscreen via CDP:', err);
      return false;
    }
  }

  /**
   * Inject text directly into active element (or YouTube search box) via CDP
   * Supports full UTF-8 (Japanese kanji, hiragana, katakana, emojis) without xdotool encoding bugs
   */
  public async typeText(text: string, enter = true): Promise<boolean> {
    if (!text) return false;
    try {
      const res = await fetch('http://127.0.0.1:9222/json/list');
      const targets = (await res.json()) as any[];
      const page = targets.find((t: any) => t.type === 'page');
      if (!page || !page.webSocketDebuggerUrl) {
        console.warn('[BrowserManager] No CDP page target found for typeText');
        return false;
      }

      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('CDP WS timeout')), 2500);
        ws.on('open', () => {
          clearTimeout(to);
          resolve(null);
        });
        ws.on('error', reject);
      });

      let msgId = 1;
      const sendCdp = (method: string, params: Record<string, any> = {}) =>
        new Promise<any>((resolve) => {
          const id = msgId++;
          const handler = (data: any) => {
            try {
              const parsed = JSON.parse(data.toString());
              if (parsed.id === id) {
                ws.off('message', handler);
                resolve(parsed.result);
              }
            } catch {}
          };
          ws.on('message', handler);
          ws.send(JSON.stringify({ id, method, params }));
        });

      // Ensure focus on an input: if activeElement is body or not an input, focus YouTube search box
      await sendCdp('Runtime.evaluate', {
        expression: `(() => {
          const active = document.activeElement;
          const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
          if (!isInput) {
            const search = document.querySelector('input#search') ||
                           document.querySelector('input[name="search_query"]') ||
                           document.querySelector('input[type="text"]') ||
                           document.querySelector('input[type="search"]');
            if (search) {
              search.focus();
              search.value = '';
            }
          }
        })()`,
      });

      // Insert text cleanly via CDP Input domain
      await sendCdp('Input.insertText', { text });

      if (enter) {
        await sendCdp('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
        });
        await sendCdp('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
        });
      }

      ws.close();
      console.log(`[BrowserManager] Successfully typed text via CDP: "${text}" (enter=${enter})`);
      return true;
    } catch (err) {
      console.error('[BrowserManager] Failed to type text via CDP:', err);
      return false;
    }
  }

  private ensureOpenboxConfig(): void {
    const homeDir = process.env.HOME || '/root';
    const configDir = path.join(homeDir, '.config', 'openbox');
    const configFile = path.join(configDir, 'rc.xml');
    try {
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      let config = fs.existsSync('/etc/xdg/openbox/rc.xml')
        ? fs.readFileSync('/etc/xdg/openbox/rc.xml', 'utf-8')
        : '<?xml version="1.0" encoding="UTF-8"?><openbox_config><applications></applications></openbox_config>';

      if (fs.existsSync(configFile)) {
        config = fs.readFileSync(configFile, 'utf-8');
      }

      if (!config.includes('<fullscreen>no</fullscreen>')) {
        const rules = `  <application class="*">\n    <decor>no</decor>\n    <position force="yes">\n      <x>0</x>\n      <y>0</y>\n    </position>\n    <fullscreen>no</fullscreen>\n    <maximized>no</maximized>\n  </application>\n</applications>`;
        const modified = config.includes('</applications>')
          ? config.replace('</applications>', rules)
          : config.replace('</openbox_config>', `<applications>\n${rules}\n</openbox_config>`);
        fs.writeFileSync(configFile, modified, 'utf-8');
        console.log(
          '[BrowserManager] Configured Openbox with borderless decor and disabled OS-level fullscreen (fullscreen=no).',
        );
      }
    } catch (err) {
      console.warn('[BrowserManager] Failed to write Openbox rc.xml:', err);
    }
  }

  private async startOpenbox(): Promise<void> {
    this.ensureOpenboxConfig();
    console.log('[BrowserManager] Spawning Openbox window manager...');
    this.openboxProcess = spawn('openbox', ['--sm-disable'], {
      env: { ...process.env, DISPLAY: this.displayNum },
      stdio: 'ignore',
      detached: true,
    });
    this.openboxProcess.unref();
    await new Promise((r) => setTimeout(r, 300));
  }

  private async applyCdpCarOptimizations(): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await new Promise((r) => setTimeout(r, 600));
        const res = await fetch('http://127.0.0.1:9222/json/list');
        const targets = (await res.json()) as any[];
        const page = targets.find((t: any) => t.type === 'page');
        if (!page || !page.webSocketDebuggerUrl) continue;

        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          const to = setTimeout(() => reject(new Error('CDP timeout')), 2500);
          ws.on('open', () => {
            clearTimeout(to);
            resolve(null);
          });
          ws.on('error', reject);
        });

        const script = `
(() => {
  try {
    // Set YouTube Dark Theme & Theater mode cookies natively (no DOM hacks)
    document.cookie = "PREF=f6=400&wide=1; domain=.youtube.com; path=/; max-age=31536000";

    window.__tesroidDisplayScale = ${this.displayScale};
    window.tesroidSetZoom = (scalePercent) => {
      const num = Number(scalePercent);
      const clamped = !isNaN(num) && num >= 50 && num <= 250 ? num : 120;
      window.__tesroidDisplayScale = clamped;
      if (document.documentElement) {
        document.documentElement.style.setProperty('--tesroid-zoom', String(clamped / 100));
      }
      applyStyles();
      window.dispatchEvent(new Event('resize'));
    };

    const applyStyles = () => {
      if (document.documentElement) {
        document.documentElement.style.setProperty('--tesroid-zoom', String((window.__tesroidDisplayScale || ${this.displayScale}) / 100));
      }
      let el = document.getElementById('tesroid-car-style');
      if (!el) {
        el = document.createElement('style');
        el.id = 'tesroid-car-style';
        el.textContent = \`
          /* Car display readable zoom (default 120%), disabled during video fullscreen */
          html:not(.tesroid-web-fs-root) {
            zoom: var(--tesroid-zoom, ${this.displayScale / 100}) !important;
          }
          html.tesroid-web-fs-root {
            zoom: 1 !important;
          }

          /* Subtle minimalist scrollbar */
          ::-webkit-scrollbar { width: 4px !important; height: 4px !important; }
          ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2) !important; border-radius: 2px !important; }

          /* Web Fullscreen in Tesla window */
          body.tesroid-web-fs-active {
            overflow: hidden !important;
            background: #000 !important;
            zoom: 1 !important;
          }
          body.tesroid-web-fs-active ytd-masthead,
          body.tesroid-web-fs-active #masthead-container,
          body.tesroid-web-fs-active #guide-wrapper,
          body.tesroid-web-fs-active #secondary,
          body.tesroid-web-fs-active #below {
            display: none !important;
          }
          body.tesroid-web-fs-active #movie_player,
          body.tesroid-web-fs-active .html5-video-player {
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            max-width: 100vw !important;
            max-height: 100vh !important;
            z-index: 2147483647 !important;
          }
          body.tesroid-web-fs-active #movie_player video,
          body.tesroid-web-fs-active .html5-video-player video {
            width: 100% !important;
            height: 100% !important;
            top: 0 !important;
            left: 0 !important;
            object-fit: contain !important;
          }
          body.tesroid-web-fs-active .tesroid-generic-fs-target {
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            z-index: 2147483647 !important;
            background: #000 !important;
            object-fit: contain !important;
          }
        \`;
        (document.head || document.documentElement).appendChild(el);
      }
    };

    applyStyles();
    document.addEventListener('DOMContentLoaded', applyStyles);

    // Install Web Fullscreen Interceptor to prevent OS-level X11 window overflow
    if (!window._tesroidFullscreenInstalled) {
      window._tesroidFullscreenInstalled = true;

      let activeFsEl = null;

      window.tesroidEnterFs = (el) => {
        activeFsEl = el || document.getElementById('movie_player') || document.querySelector('video');
        document.documentElement?.classList.add('tesroid-web-fs-root');
        document.body.classList.add('tesroid-web-fs-active');

        const flexy = document.querySelector('ytd-watch-flexy');
        if (flexy) {
          flexy.setAttribute('fullscreen', '');
        }

        const player = document.getElementById('movie_player') || (activeFsEl?.closest?.('#movie_player'));
        if (player) {
          player.classList.add('ytp-fullscreen');
          try { player.setFauxFullscreen?.(true); } catch {}
        } else if (activeFsEl) {
          activeFsEl.classList.add('tesroid-generic-fs-target');
        }

        const fsEvent = new Event('fullscreenchange', { bubbles: true });
        document.dispatchEvent(fsEvent);
        activeFsEl?.dispatchEvent(fsEvent);
        window.dispatchEvent(new Event('resize'));
      };

      window.tesroidExitFs = () => {
        document.documentElement?.classList.remove('tesroid-web-fs-root');
        document.body.classList.remove('tesroid-web-fs-active');

        const flexy = document.querySelector('ytd-watch-flexy');
        if (flexy) {
          flexy.removeAttribute('fullscreen');
        }

        const player = document.getElementById('movie_player');
        if (player) {
          player.classList.remove('ytp-fullscreen');
          try { player.setFauxFullscreen?.(false); } catch {}
        }

        if (activeFsEl) {
          activeFsEl.classList.remove('tesroid-generic-fs-target');
          activeFsEl = null;
        }

        const fsEvent = new Event('fullscreenchange', { bubbles: true });
        document.dispatchEvent(fsEvent);
        window.dispatchEvent(new Event('resize'));
      };

      window.tesroidToggleFs = () => {
        if (activeFsEl || document.body.classList.contains('tesroid-web-fs-active')) {
          window.tesroidExitFs();
        } else {
          window.tesroidEnterFs();
        }
      };

      // Override DOM Fullscreen APIs to stay strictly within browser window
      Element.prototype.requestFullscreen = function() {
        window.tesroidEnterFs(this);
        return Promise.resolve();
      };
      Element.prototype.webkitRequestFullscreen = function() {
        window.tesroidEnterFs(this);
      };
      Element.prototype.webkitRequestFullScreen = function() {
        window.tesroidEnterFs(this);
      };

      document.exitFullscreen = function() {
        window.tesroidExitFs();
        return Promise.resolve();
      };
      document.webkitExitFullscreen = function() {
        window.tesroidExitFs();
      };

      Object.defineProperty(document, 'fullscreenElement', {
        get: () => activeFsEl,
        configurable: true,
      });
      Object.defineProperty(document, 'webkitFullscreenElement', {
        get: () => activeFsEl,
        configurable: true,
      });
      Object.defineProperty(document, 'fullscreen', {
        get: () => !!activeFsEl,
        configurable: true,
      });
      Object.defineProperty(document, 'webkitIsFullScreen', {
        get: () => !!activeFsEl,
        configurable: true,
      });

      // Escape key exits fullscreen
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && (activeFsEl || document.body.classList.contains('tesroid-web-fs-active'))) {
          e.preventDefault();
          e.stopPropagation();
          window.tesroidExitFs();
        }
      }, true);

      // Patch YouTube internal player toggle
      const patchYtPlayer = () => {
        const player = document.getElementById('movie_player');
        if (player && !player._tesroidFsHooked) {
          player._tesroidFsHooked = true;
          player.toggleFullscreen = function() {
            if (activeFsEl || document.body.classList.contains('tesroid-web-fs-active')) {
              window.tesroidExitFs();
            } else {
              window.tesroidEnterFs(player);
            }
          };
        }
      };
      patchYtPlayer();
      setInterval(patchYtPlayer, 1000);

      // Unmute YouTube player and video element if auto-muted
      const ensureUnmuted = () => {
        try {
          const video = document.querySelector('video');
          if (video) {
            if (video.muted) video.muted = false;
            if (video.volume < 1) video.volume = 1;
          }
          const player = document.getElementById('movie_player');
          if (player && typeof player.isMuted === 'function' && player.isMuted()) {
            player.unMute?.();
            player.setVolume?.(100);
          }
        } catch {}
      };
      ensureUnmuted();
      setInterval(ensureUnmuted, 2000);
    }
  } catch (e) {}
})()
        `;

        let msgId = 100;
        const send = (method: string, params: any) =>
          new Promise<any>((resolve) => {
            const id = msgId++;
            const to = setTimeout(() => resolve(null), 1500);
            const h = (d: any) => {
              try {
                const p = JSON.parse(d.toString());
                if (p.id === id) {
                  clearTimeout(to);
                  ws.off('message', h);
                  resolve(p.result);
                }
              } catch {}
            };
            ws.on('message', h);
            ws.send(JSON.stringify({ id, method, params }));
          });

        await send('Page.enable', {});
        await send('Page.addScriptToEvaluateOnNewDocument', { source: script });
        await send('Runtime.evaluate', { expression: script });

        try {
          ws.close();
        } catch {}
        console.log(
          '[BrowserManager] CDP car layout optimizations active (Web Fullscreen & Theater mode & Dark theme).',
        );
        return;
      } catch (e) {
        // Retry next attempt
      }
    }
  }

  private cleanProfileLocks(): void {
    try {
      // 1. Unconditionally remove any file/symlink starting with Singleton
      if (fs.existsSync(this.profileDir)) {
        try {
          const entries = fs.readdirSync(this.profileDir);
          for (const entry of entries) {
            if (entry.startsWith('Singleton')) {
              const fullPath = path.join(this.profileDir, entry);
              try {
                fs.rmSync(fullPath, { force: true, recursive: true });
                console.log(`[BrowserManager] Cleaned lock file/symlink: ${entry}`);
              } catch (e) {
                console.warn(`[BrowserManager] Failed to remove ${entry}:`, e);
              }
            }
          }
        } catch (e) {
          console.warn('[BrowserManager] Error reading profileDir entries:', e);
        }
      }

      // Shell cleanup as secondary guarantee for broken symlinks
      try {
        execSync(`sh -c 'rm -f "${this.profileDir}"/Singleton*' 2>/dev/null || true`);
      } catch {}

      // Reset exit_type in Preferences so "Restore pages?" bubble never shows
      const prefPaths = [
        path.join(this.profileDir, 'Default', 'Preferences'),
        path.join(this.profileDir, 'Preferences'),
      ];
      for (const prefPath of prefPaths) {
        if (fs.existsSync(prefPath)) {
          try {
            let content = fs.readFileSync(prefPath, 'utf-8');
            content = content.replace(/"exit_type"\s*:\s*"[^"]*"/g, '"exit_type":"Normal"');
            content = content.replace(/"exited_cleanly"\s*:\s*false/g, '"exited_cleanly":true');
            fs.writeFileSync(prefPath, content, 'utf-8');
          } catch {}
        }
      }
    } catch (err) {
      console.warn('[BrowserManager] Failed to clean profile locks:', err);
    }
  }

  private async startChrome(targetUrl?: string): Promise<void> {
    if (this.chromeProcess || this.isStartingChrome) {
      console.log(
        '[BrowserManager] Chrome is already running or starting, skipping duplicate spawn.',
      );
      return;
    }
    this.isStartingChrome = true;

    const url = targetUrl || this.currentUrl;
    const chromeBin = this.detectChromeBinary();

    // Clean any stale Singleton locks from previous crashes/restarts to avoid exit code 21
    this.cleanProfileLocks();

    const args = [
      '--no-sandbox',
      '--test-type',
      `--user-data-dir=${this.profileDir}`,
      `--window-size=${this.width},${this.height}`,
      '--window-position=0,0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--disable-infobars',
      '--disable-notifications',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu-sandbox',
      '--ignore-gpu-blocklist',
      // Hardware video decode via VAAPI (e.g. Intel QuickSync / AMD VAAPI)
      '--enable-features=VaapiVideoDecoder,VaapiVideoEncoder,VaapiIgnoreDriverChecks',
      // CRITICAL: Disable AV1 software decode so YouTube automatically serves hardware-accelerated VP9/H.264
      // (Pre-11th Gen Intel iGPUs lack AV1 hardware decode but have full silicon VP9/H.264 decode).
      // Disable AudioServiceSandbox so Chrome AudioService can seamlessly access PulseAudio UNIX socket in container.
      '--disable-features=Av1Decoder,AudioServiceSandbox',
      '--touch-events=enabled',
      '--force-dark-mode',
      '--remote-debugging-port=9222',
      '--remote-debugging-address=127.0.0.1',
    ];

    // Load Tesroid Web Fullscreen extension if present
    const extensionCandidates = [
      path.resolve('/app/server/extension'),
      path.resolve(__dirname, '../extension'),
      path.resolve(__dirname, '../../extension'),
      path.resolve(__dirname, '../../../server/extension'),
    ];
    const extensionDir = extensionCandidates.find((d) => fs.existsSync(d));
    if (extensionDir) {
      args.push(`--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`);
      console.log(`[BrowserManager] Loading Tesroid car layout extension from: ${extensionDir}`);
    }

    args.push(`--app=${url}`);

    console.log(`[BrowserManager] Spawning Chrome: ${chromeBin} ${args.join(' ')}`);
    const proc = spawn(chromeBin, args, {
      env: {
        ...process.env,
        DISPLAY: this.displayNum,
        LIBVA_DRIVER_NAME: 'iHD',
        PULSE_SERVER: 'unix:/tmp/pulse-socket',
        PULSE_SINK: 'virtual_sink',
      },
      stdio: 'ignore',
    });
    this.chromeProcess = proc;
    this.isStartingChrome = false;

    // Apply CDP car layout optimizations asynchronously
    this.applyCdpCarOptimizations().catch(() => {});

    proc.on('exit', (code, signal) => {
      console.warn(`[BrowserManager] Chrome exited (code=${code}, signal=${signal})`);
      if (this.chromeProcess !== proc) {
        console.log('[BrowserManager] Ignoring exit of superseded Chrome process.');
        return;
      }
      this.chromeProcess = null;
      const intentional = this.isIntentionalChromeStop;
      this.isIntentionalChromeStop = false;

      if (!intentional && (this.state === 'running' || this.state === 'starting')) {
        if (this.chromeRestartTimer) clearTimeout(this.chromeRestartTimer);
        console.log('[BrowserManager] Auto-restarting Chrome in 2s...');
        this.chromeRestartTimer = setTimeout(() => {
          this.chromeRestartTimer = null;
          if ((this.state === 'running' || this.state === 'starting') && !this.chromeProcess) {
            this.cleanProfileLocks();
            this.startChrome().catch((e) =>
              console.error('[BrowserManager] Failed to restart Chrome:', e),
            );
          }
        }, 2000);
      }
    });

    await new Promise((r) => setTimeout(r, 1000));
    if (!this.chromeProcess || this.chromeProcess.exitCode !== null) {
      console.warn(
        '[BrowserManager] Chrome process failed to stay alive after spawn. Cleaning locks and retrying...',
      );
      this.cleanProfileLocks();
      if (!this.chromeRestartTimer && (this.state === 'running' || this.state === 'starting')) {
        this.startChrome().catch((e) =>
          console.error('[BrowserManager] Immediate retry startChrome failed:', e),
        );
      }
    }
  }

  private stopChrome(): void {
    if (this.chromeRestartTimer) {
      clearTimeout(this.chromeRestartTimer);
      this.chromeRestartTimer = null;
    }
    this.isIntentionalChromeStop = true;
    if (this.chromeProcess) {
      try {
        if (this.chromeProcess.pid) {
          const pids = getProcessTree(this.chromeProcess.pid);
          for (let i = pids.length - 1; i >= 0; i--) {
            const pid = pids[i];
            try {
              process.kill(pid, 'SIGKILL');
            } catch (err: any) {
              if (err?.code !== 'ESRCH') {
                console.warn(`[BrowserManager] Warning killing pid ${pid}:`, err);
              }
            }
          }
        }
      } catch {}
      this.chromeProcess = null;
    }
    // Clean any lingering chrome processes without shell self-matching (-f avoided)
    try {
      const lingeringPids = findProcessesByName([
        'chrome',
        'google-chrome',
        'chromium',
        'chromium-browser',
      ]);
      for (const rootPid of lingeringPids) {
        const tree = getProcessTree(rootPid);
        for (let i = tree.length - 1; i >= 0; i--) {
          try {
            process.kill(tree[i], 'SIGKILL');
          } catch (err: any) {
            if (err?.code !== 'ESRCH') {
              console.warn(`[BrowserManager] Warning killing lingering pid ${tree[i]}:`, err);
            }
          }
        }
      }
      execSync('pkill -9 -x "chrome|google-chrome|chromium|chromium-browse" 2>/dev/null || true');
    } catch {}
  }

  private stopOpenbox(): void {
    if (this.openboxProcess) {
      try {
        this.openboxProcess.kill('SIGTERM');
      } catch {}
      this.openboxProcess = null;
    }
  }

  private stopXvfb(): void {
    if (this.xvfbProcess) {
      try {
        this.xvfbProcess.kill('SIGTERM');
      } catch {}
      this.xvfbProcess = null;
    }
  }

  private detectChromeBinary(): string {
    const candidates = ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium'];
    for (const bin of candidates) {
      try {
        execSync(`which ${bin} 2>/dev/null`);
        return bin;
      } catch {}
    }
    return 'google-chrome-stable';
  }

  private async waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(socketPath)) {
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    console.warn(`[BrowserManager] Timeout waiting for X11 socket: ${socketPath}`);
  }
}
