import { type ChildProcess, execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { findProcessesByName, getProcessTree } from '../utils/processTree.js';
import { buildCarFullscreenScript } from './fullscreen-script.js';

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
  locale?: string; // e.g. 'ja-JP'
  timezone?: string; // e.g. 'Asia/Tokyo'
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
  private locale: string;
  private timezone: string;

  private xvfbProcess: ChildProcess | null = null;
  private openboxProcess: ChildProcess | null = null;
  private chromeProcess: ChildProcess | null = null;

  private state: BrowserState = 'stopped';
  private currentUrl: string;
  private currentTitle = '';
  private pageInfoListeners = new Set<(info: { url: string; title: string }) => void>();

  private pageMonitorWs: WebSocket | null = null;
  private pageMonitorTargetWsUrl: string | null = null;
  private pageMonitorConnectTimer: NodeJS.Timeout | null = null;
  private pageMonitorPollTimer: NodeJS.Timeout | null = null;
  private pageMonitorTitleTimer: NodeJS.Timeout | null = null;
  private pageMonitorMsgId = 1;
  private pendingPageInfoEvalIds = new Set<number>();
  private isPageMonitorStopped = true;
  private isConnectingPageMonitor = false;

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
    this.locale = options.locale || process.env.LOCALE || 'ja-JP';
    this.timezone = options.timezone || process.env.TZ || 'Asia/Tokyo';
    this.currentUrl = this.defaultUrl;
  }

  public getLocale(): string {
    return this.locale;
  }

  public setLocale(locale: string): void {
    const trimmed = (locale || '').trim();
    if (trimmed && this.locale !== trimmed) {
      this.locale = trimmed;
      this.applyChromePreferences();
    }
  }

  public getTimezone(): string {
    return this.timezone;
  }

  public setTimezone(timezone: string): void {
    const trimmed = (timezone || '').trim();
    if (trimmed && this.timezone !== trimmed) {
      this.timezone = trimmed;
    }
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

  public getCurrentTitle(): string {
    return this.currentTitle;
  }

  public onPageInfoChanged(listener: (info: { url: string; title: string }) => void): () => void {
    this.pageInfoListeners.add(listener);
    return () => {
      this.pageInfoListeners.delete(listener);
    };
  }

  public updatePageInfo(url?: string, title?: string): boolean {
    let changed = false;

    if (url !== undefined) {
      const trimmedUrl = typeof url === 'string' ? url.trim() : '';
      if (!isSafeHttpUrl(trimmedUrl)) {
        return false;
      }
      if (trimmedUrl !== this.currentUrl) {
        this.currentUrl = trimmedUrl;
        changed = true;
      }
    }

    if (typeof title === 'string') {
      const nextTitle = title.trim();
      if (nextTitle !== this.currentTitle) {
        this.currentTitle = nextTitle;
        changed = true;
      }
    }

    if (changed) {
      const info = { url: this.currentUrl, title: this.currentTitle };
      for (const listener of this.pageInfoListeners) {
        try {
          listener(info);
        } catch (err) {
          console.warn('[BrowserManager] pageInfo listener error:', err);
        }
      }
    }

    return changed;
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
      if (!this.isPageMonitorStopped) {
        this.schedulePageMonitorConnect(300);
      }
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
    const normalizedUrl = url.trim();
    const urlChanged = normalizedUrl !== this.currentUrl;
    this.updatePageInfo(normalizedUrl, urlChanged ? '' : undefined);
    if (this.state === 'paused') {
      this.resume();
    }
    console.log(`[BrowserManager] Navigating to: ${normalizedUrl}`);
    const navigated = await this.navigateViaCdp(normalizedUrl);
    if (!navigated) {
      await this.restartChrome(normalizedUrl);
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
    if (url && isSafeHttpUrl(url)) {
      const normalizedUrl = url.trim();
      const urlChanged = normalizedUrl !== this.currentUrl;
      this.updatePageInfo(normalizedUrl, urlChanged ? '' : undefined);
    }
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
    // WebAuthn / Passkey Dialog Suppressor (Issue #35)
    // Docker/Xvfb環境には物理・プラットフォームFIDO2認証器が存在せず、ChromeネイティブのWebAuthn
    // バブルダイアログ（"No passkeys available"）が表示されると車載タッチ操作（DOM注入）では
    // 閉じられず操作不能になるため、WebAuthn API呼び出しをインターセプトして安全に拒否・無効化する。
    try {
      if (typeof window.PublicKeyCredential !== 'undefined') {
        try {
          window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
        } catch {
          Object.defineProperty(window.PublicKeyCredential, 'isUserVerifyingPlatformAuthenticatorAvailable', {
            value: () => Promise.resolve(false),
            configurable: true,
            writable: true,
          });
        }
        if (typeof window.PublicKeyCredential.isConditionalMediationAvailable === 'function') {
          try {
            window.PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
          } catch {
            Object.defineProperty(window.PublicKeyCredential, 'isConditionalMediationAvailable', {
              value: () => Promise.resolve(false),
              configurable: true,
              writable: true,
            });
          }
        }
      }
    } catch (e) {}

    try {
      if (typeof navigator !== 'undefined' && navigator.credentials && !navigator.credentials._tesroidWebAuthnHooked) {
        navigator.credentials._tesroidWebAuthnHooked = true;

        const createNotAllowedError = (msg) => {
          if (typeof DOMException !== 'undefined') {
            return new DOMException(msg, 'NotAllowedError');
          }
          const err = new Error(msg);
          err.name = 'NotAllowedError';
          return err;
        };

        if (typeof navigator.credentials.get === 'function') {
          const origGet = navigator.credentials.get.bind(navigator.credentials);
          navigator.credentials.get = async function(options) {
            if (options && options.publicKey) {
              throw createNotAllowedError('Passkeys are not supported in this environment.');
            }
            return origGet(options);
          };
        }

        if (typeof navigator.credentials.create === 'function') {
          const origCreate = navigator.credentials.create.bind(navigator.credentials);
          navigator.credentials.create = async function(options) {
            if (options && options.publicKey) {
              throw createNotAllowedError('Passkeys are not supported in this environment.');
            }
            return origCreate(options);
          };
        }
      }
    } catch (e) {}

    // Set YouTube Dark Theme & Theater mode cookies natively (no DOM hacks)
    document.cookie = "PREF=f6=400&wide=1; domain=.youtube.com; path=/; max-age=31536000";

    ${buildCarFullscreenScript(this.displayScale)}

    // Unmute YouTube player and video element if auto-muted
    if (!window._tesroidAudioUnmuteInstalled) {
      window._tesroidAudioUnmuteInstalled = true;
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

  /**
   * Pre-configures Chrome user profile preferences (Default/Preferences and Preferences) to:
   * 1. Suppress translation popups/bubbles completely (translate.enabled: false).
   * 2. Set accept_languages to prefer the configured locale (e.g. ja-JP,ja,en-US,en).
   * 3. Suppress Chrome native password manager save/autosignin/leak-detection and autofill bubbles
   *    (Views Bubbles cannot be dismissed via DOM-scoped CdpTouchBridge injection).
   */
  public applyChromePreferences(): void {
    try {
      const prefDir = path.join(this.profileDir, 'Default');
      if (!fs.existsSync(prefDir)) {
        fs.mkdirSync(prefDir, { recursive: true });
      }
      const prefPaths = [
        path.join(this.profileDir, 'Default', 'Preferences'),
        path.join(this.profileDir, 'Preferences'),
      ];

      const lang = this.locale || 'ja-JP';
      const acceptLang = lang.startsWith('ja') ? 'ja-JP,ja,en-US,en' : `${lang},en-US,en`;

      for (const prefPath of prefPaths) {
        let prefs: Record<string, any> = {};
        if (fs.existsSync(prefPath)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(prefPath, 'utf-8'));
            prefs = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
          } catch {
            prefs = {};
          }
        } else if (prefPath.endsWith(path.join('Default', 'Preferences'))) {
          prefs = {};
        } else {
          continue;
        }

        prefs.intl = {
          ...(prefs.intl || {}),
          accept_languages: acceptLang,
          selected_languages: acceptLang,
        };

        prefs.translate = {
          ...(prefs.translate || {}),
          enabled: false,
        };

        prefs.translate_blocked_languages = prefs.translate_blocked_languages || [];

        // Suppress Chrome native password manager save / autosignin / leak detection
        // and autofill Views Bubbles (cannot be dismissed via DOM touch injection).
        prefs.credentials_enable_service = false;
        prefs.credentials_enable_autosignin = false;

        prefs.profile = {
          ...(prefs.profile || {}),
          password_manager_enabled: false,
          password_manager_leak_detection: false,
        };

        prefs.autofill = {
          ...(prefs.autofill || {}),
          profile_enabled: false,
          credit_card_enabled: false,
        };

        fs.writeFileSync(prefPath, JSON.stringify(prefs, null, 2), 'utf-8');
      }
    } catch (err) {
      console.warn('[BrowserManager] Failed to apply Chrome preferences:', err);
    }
  }

  public buildChromeArgs(targetUrl?: string): string[] {
    const url = targetUrl || this.currentUrl;
    const lang = this.locale || 'ja-JP';
    const acceptLang = lang.startsWith('ja') ? 'ja-JP,ja,en-US,en' : `${lang},en-US,en`;

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
      // Prevent OS keyring prompts and credential store bubbles in Linux/Xvfb
      '--password-store=basic',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu-sandbox',
      '--ignore-gpu-blocklist',
      `--lang=${lang}`,
      `--accept-lang=${acceptLang}`,
      // Hardware video decode via VAAPI (e.g. Intel QuickSync / AMD VAAPI)
      // Note: Chrome 131+ uses AcceleratedVideoDecodeLinuxGL on Linux/X11/EGL; VaapiVideoDecoder flag is obsolete.
      // In headless Xvfb environments, ANGLE reports llvmpipe software rasterizer, which causes Chrome to reject
      // DRI render nodes during pre-sandbox PCI device filtering. --render-node-override forces VAAPI VADisplay binding.
      '--enable-features=AcceleratedVideoDecodeLinuxGL,VaapiIgnoreDriverChecks',
      `--render-node-override=${process.env.VAAPI_DEVICE || '/dev/dri/renderD128'}`,
      // CRITICAL: Disable AV1 software decode so YouTube automatically serves hardware-accelerated VP9/H.264
      // (Pre-11th Gen Intel iGPUs lack AV1 hardware decode but have full silicon VP9/H.264 decode).
      // Disable AudioServiceSandbox so Chrome AudioService can seamlessly access PulseAudio UNIX socket in container.
      // Disable Translate so Google Chrome translation prompt bubbles never appear.
      '--disable-features=Av1Decoder,AudioServiceSandbox,Translate',
      '--disable-translate',
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
    return args;
  }

  public buildChromeEnv(): NodeJS.ProcessEnv {
    const lang = this.locale || 'ja-JP';
    const linuxLocale = lang.startsWith('ja')
      ? 'ja_JP.UTF-8'
      : lang === 'en-US'
        ? 'en_US.UTF-8'
        : 'ja_JP.UTF-8';

    return {
      ...process.env,
      DISPLAY: this.displayNum,
      LIBVA_DRIVER_NAME: 'iHD',
      PULSE_SERVER: 'unix:/tmp/pulse-socket',
      PULSE_SINK: 'virtual_sink',
      TZ: this.timezone || 'Asia/Tokyo',
      LANG: linuxLocale,
      LANGUAGE: lang.startsWith('ja') ? 'ja_JP:ja' : linuxLocale,
      LC_ALL: linuxLocale,
    };
  }

  private async startChrome(targetUrl?: string): Promise<void> {
    if (this.chromeProcess || this.isStartingChrome) {
      console.log(
        '[BrowserManager] Chrome is already running or starting, skipping duplicate spawn.',
      );
      return;
    }
    this.isStartingChrome = true;

    const chromeBin = this.detectChromeBinary();

    // Clean any stale Singleton locks from previous crashes/restarts to avoid exit code 21
    this.cleanProfileLocks();
    this.applyChromePreferences();

    const args = this.buildChromeArgs(targetUrl);
    const env = this.buildChromeEnv();

    console.log(`[BrowserManager] Spawning Chrome: ${chromeBin} ${args.join(' ')}`);
    const proc = spawn(chromeBin, args, {
      env,
      stdio: 'ignore',
    });
    this.chromeProcess = proc;
    this.isStartingChrome = false;

    // Apply CDP car layout optimizations and start real-time page URL/title monitor asynchronously
    this.applyCdpCarOptimizations().catch(() => {});
    this.startPageInfoMonitor();

    proc.on('exit', (code, signal) => {
      console.warn(`[BrowserManager] Chrome exited (code=${code}, signal=${signal})`);
      if (this.chromeProcess !== proc) {
        console.log('[BrowserManager] Ignoring exit of superseded Chrome process.');
        return;
      }
      this.chromeProcess = null;
      this.stopPageInfoMonitor();
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
    this.stopPageInfoMonitor();
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

  private schedulePageMonitorConnect(delayMs: number): void {
    if (this.isPageMonitorStopped) return;
    if (this.pageMonitorConnectTimer) {
      clearTimeout(this.pageMonitorConnectTimer);
    }
    this.pageMonitorConnectTimer = setTimeout(() => {
      this.pageMonitorConnectTimer = null;
      void this.connectPageInfoMonitor();
    }, delayMs);
    this.pageMonitorConnectTimer.unref();
  }

  private startPageInfoMonitor(): void {
    this.stopPageInfoMonitor();
    this.isPageMonitorStopped = false;
    this.schedulePageMonitorConnect(800);
    this.pageMonitorPollTimer = setInterval(() => {
      void this.pollPageInfoFromJsonList();
    }, 3000);
    this.pageMonitorPollTimer.unref();
  }

  private stopPageInfoMonitor(): void {
    this.isPageMonitorStopped = true;
    this.isConnectingPageMonitor = false;
    if (this.pageMonitorConnectTimer) {
      clearTimeout(this.pageMonitorConnectTimer);
      this.pageMonitorConnectTimer = null;
    }
    if (this.pageMonitorPollTimer) {
      clearInterval(this.pageMonitorPollTimer);
      this.pageMonitorPollTimer = null;
    }
    if (this.pageMonitorTitleTimer) {
      clearTimeout(this.pageMonitorTitleTimer);
      this.pageMonitorTitleTimer = null;
    }
    this.pendingPageInfoEvalIds.clear();
    if (this.pageMonitorWs) {
      const ws = this.pageMonitorWs;
      this.pageMonitorWs = null;
      this.pageMonitorTargetWsUrl = null;
      try {
        ws.removeAllListeners();
        ws.close();
      } catch {}
    }
  }

  private async connectPageInfoMonitor(): Promise<void> {
    if (this.isPageMonitorStopped || this.isConnectingPageMonitor || !this.isChromeAlive()) {
      return;
    }
    if (this.state === 'paused') {
      return;
    }
    if (this.pageMonitorWs && this.pageMonitorWs.readyState === WebSocket.OPEN) {
      return;
    }

    this.isConnectingPageMonitor = true;
    try {
      const res = await fetch('http://127.0.0.1:9222/json/list', {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const targets = (await res.json()) as Array<{
        type?: string;
        url?: string;
        title?: string;
        webSocketDebuggerUrl?: string;
      }>;
      const page = Array.isArray(targets)
        ? targets.find((t) => t?.type === 'page' && t?.webSocketDebuggerUrl)
        : undefined;

      if (!page || !page.webSocketDebuggerUrl) {
        this.isConnectingPageMonitor = false;
        this.schedulePageMonitorConnect(1500);
        return;
      }

      if (this.isPageMonitorStopped) {
        this.isConnectingPageMonitor = false;
        return;
      }

      this.updatePageInfo(
        typeof page.url === 'string' ? page.url : undefined,
        typeof page.title === 'string' ? page.title : undefined,
      );

      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => {
          try {
            ws.close();
          } catch {}
          reject(new Error('CDP page monitor connect timeout'));
        }, 2500);
        to.unref();

        ws.once('open', () => {
          clearTimeout(to);
          resolve();
        });
        ws.once('error', (err) => {
          clearTimeout(to);
          reject(err);
        });
      });

      if (this.isPageMonitorStopped) {
        try {
          ws.close();
        } catch {}
        this.isConnectingPageMonitor = false;
        return;
      }

      if (this.pageMonitorWs && this.pageMonitorWs !== ws) {
        try {
          this.pageMonitorWs.removeAllListeners();
          this.pageMonitorWs.close();
        } catch {}
      }

      this.pageMonitorWs = ws;
      this.pageMonitorTargetWsUrl = page.webSocketDebuggerUrl;
      this.pendingPageInfoEvalIds.clear();
      this.isConnectingPageMonitor = false;

      ws.on('message', (data) => {
        this.handlePageMonitorMessage(ws, data.toString());
      });

      ws.on('close', () => {
        if (this.pageMonitorWs === ws) {
          this.pageMonitorWs = null;
          this.pageMonitorTargetWsUrl = null;
          this.pendingPageInfoEvalIds.clear();
          this.schedulePageMonitorConnect(1500);
        }
      });

      ws.on('error', () => {
        if (this.pageMonitorWs === ws) {
          this.pageMonitorWs = null;
          this.pageMonitorTargetWsUrl = null;
          this.pendingPageInfoEvalIds.clear();
          try {
            ws.close();
          } catch {}
          this.schedulePageMonitorConnect(1500);
        }
      });

      ws.send(JSON.stringify({ id: this.pageMonitorMsgId++, method: 'Page.enable', params: {} }));
      this.requestCdpPageInfo(ws);
    } catch {
      this.isConnectingPageMonitor = false;
      this.schedulePageMonitorConnect(1500);
    }
  }

  private requestCdpPageInfo(ws: WebSocket): void {
    if (this.isPageMonitorStopped || ws.readyState !== WebSocket.OPEN) return;
    const id = this.pageMonitorMsgId++;
    this.pendingPageInfoEvalIds.add(id);
    if (this.pendingPageInfoEvalIds.size > 50) {
      const oldest = this.pendingPageInfoEvalIds.values().next().value;
      if (oldest !== undefined) this.pendingPageInfoEvalIds.delete(oldest);
    }
    try {
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: {
            expression: '({ url: location.href, title: document.title })',
            returnByValue: true,
          },
        }),
      );
    } catch {}
  }

  private handlePageMonitorMessage(ws: WebSocket, raw: string): void {
    if (this.isPageMonitorStopped) return;
    try {
      const msg = JSON.parse(raw) as {
        id?: number;
        method?: string;
        params?: {
          url?: string;
          frame?: { parentId?: string; url?: string };
        };
        result?: {
          result?: {
            value?: { url?: unknown; title?: unknown };
          };
        };
      };

      if (typeof msg.id === 'number' && this.pendingPageInfoEvalIds.has(msg.id)) {
        this.pendingPageInfoEvalIds.delete(msg.id);
        const val = msg.result?.result?.value;
        if (val && typeof val === 'object') {
          this.updatePageInfo(
            typeof val.url === 'string' ? val.url : undefined,
            typeof val.title === 'string' ? val.title : undefined,
          );
        }
        return;
      }

      if (msg.method === 'Page.frameNavigated') {
        if (!msg.params?.frame?.parentId) {
          if (typeof msg.params?.frame?.url === 'string') {
            this.updatePageInfo(msg.params.frame.url);
          }
          this.requestCdpPageInfo(ws);
        }
      } else if (msg.method === 'Page.navigatedWithinDocument') {
        if (typeof msg.params?.url === 'string') {
          this.updatePageInfo(msg.params.url);
        }
        this.requestCdpPageInfo(ws);
        if (this.pageMonitorTitleTimer) {
          clearTimeout(this.pageMonitorTitleTimer);
        }
        this.pageMonitorTitleTimer = setTimeout(() => {
          this.pageMonitorTitleTimer = null;
          if (!this.isPageMonitorStopped && this.pageMonitorWs === ws) {
            this.requestCdpPageInfo(ws);
          }
        }, 400);
        this.pageMonitorTitleTimer.unref();
      } else if (
        msg.method === 'Page.loadEventFired' ||
        msg.method === 'Page.domContentEventFired'
      ) {
        this.requestCdpPageInfo(ws);
      }
    } catch {}
  }

  private async pollPageInfoFromJsonList(): Promise<void> {
    if (this.isPageMonitorStopped || this.state === 'paused' || !this.isChromeAlive()) {
      return;
    }
    try {
      const res = await fetch('http://127.0.0.1:9222/json/list', {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return;
      const targets = (await res.json()) as Array<{
        type?: string;
        url?: string;
        title?: string;
        webSocketDebuggerUrl?: string;
      }>;
      if (!Array.isArray(targets)) return;
      const page = targets.find((t) => t?.type === 'page');
      if (!page) return;

      this.updatePageInfo(
        typeof page.url === 'string' ? page.url : undefined,
        typeof page.title === 'string' ? page.title : undefined,
      );

      if (
        !this.pageMonitorWs ||
        this.pageMonitorWs.readyState !== WebSocket.OPEN ||
        (page.webSocketDebuggerUrl && page.webSocketDebuggerUrl !== this.pageMonitorTargetWsUrl)
      ) {
        void this.connectPageInfoMonitor();
      }
    } catch {}
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
