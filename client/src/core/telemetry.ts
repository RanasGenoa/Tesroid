import { TelemetryEvent } from '../transport/protocol.js';

export interface TelemetryCollectorOptions {
  storageKey?: string;
  flushIntervalMs?: number;
  maxQueueSize?: number;
}

export class TelemetryCollector {
  private enabled: boolean = false;
  private queue: TelemetryEvent[] = [];
  private flushTimer: any = null;
  private storageKey: string;
  private flushIntervalMs: number;
  private maxQueueSize: number;

  public onFlush?: (events: TelemetryEvent[]) => void;

  private originalConsoleWarn?: typeof console.warn;
  private originalConsoleError?: typeof console.error;
  private isHookingConsole: boolean = false;
  private isRecordingConsole: boolean = false;
  private isFlushing: boolean = false;

  constructor(options: TelemetryCollectorOptions = {}) {
    this.storageKey = options.storageKey ?? 'tesroid_detailed_telemetry';
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.maxQueueSize = options.maxQueueSize ?? 500;

    // Load initial preference from localStorage if available
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(this.storageKey);
        this.enabled = saved === 'true' || saved === '1';
      }
    } catch {}

    if (this.enabled) {
      this.startFlushTimer();
      this.hookConsole();
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(this.storageKey, enabled ? 'true' : 'false');
      }
    } catch {}

    if (enabled) {
      this.enabled = true;
      this.startFlushTimer();
      this.hookConsole();
      this.record('log', 'telemetry_enabled', { timestamp: Date.now() });
    } else {
      // Record and flush 'telemetry_disabled' BEFORE flipping enabled=false
      this.record('log', 'telemetry_disabled', { timestamp: Date.now() });
      this.flush();
      this.enabled = false;
      this.stopFlushTimer();
      this.unhookConsole();
      this.queue = [];
    }
  }

  public record(type: TelemetryEvent['type'], event: string, data?: Record<string, any>): void {
    if (!this.enabled) return;

    const entry: TelemetryEvent = {
      timestamp: Date.now(),
      type,
      event,
      data,
    };

    this.queue.push(entry);

    if (this.queue.length >= this.maxQueueSize) {
      this.flush();
    }
  }

  public recordAvSync(event: string, data?: Record<string, any>): void {
    if (!this.enabled) return;
    this.record('av_sync', event, data);
  }

  public recordBuffering(event: string, data?: Record<string, any>): void {
    if (!this.enabled) return;
    this.record('buffering', event, data);
  }

  public recordDecoder(event: string, data?: Record<string, any>): void {
    if (!this.enabled) return;
    this.record('decoder', event, data);
  }

  public recordPacer(event: string, data?: Record<string, any>): void {
    if (!this.enabled) return;
    this.record('pacer', event, data);
  }

  public recordAudio(event: string, data?: Record<string, any>): void {
    if (!this.enabled) return;
    this.record('audio', event, data);
  }

  public recordLog(level: 'warn' | 'error', message: string, detail?: any): void {
    if (!this.enabled) return;
    let serializedDetail: any = undefined;
    if (detail !== undefined) {
      try {
        serializedDetail = typeof detail === 'string' ? detail : JSON.parse(JSON.stringify(detail));
      } catch {
        serializedDetail = String(detail);
      }
    }
    this.record('log', level, { message, detail: serializedDetail });
  }

  public flush(): void {
    if (this.isFlushing || this.queue.length === 0) return;
    this.isFlushing = true;
    const batch = this.queue;
    this.queue = [];
    try {
      this.onFlush?.(batch);
    } catch (err) {
      const warnFn = this.originalConsoleWarn ?? console.warn;
      warnFn('[TelemetryCollector] Failed to flush events:', err);
    } finally {
      this.isFlushing = false;
    }
  }

  private startFlushTimer(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.flushIntervalMs);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private formatConsoleArg(arg: unknown): string {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) {
      return arg.stack || `${arg.name}: ${arg.message}`;
    }
    if (typeof arg === 'object' && arg !== null) {
      try {
        return JSON.stringify(arg);
      } catch {
        return Object.prototype.toString.call(arg);
      }
    }
    return String(arg);
  }

  private hookConsole(): void {
    if (this.isHookingConsole || typeof console === 'undefined') return;
    this.isHookingConsole = true;

    this.originalConsoleWarn = console.warn.bind(console);
    this.originalConsoleError = console.error.bind(console);

    console.warn = (...args: any[]) => {
      this.originalConsoleWarn?.(...args);
      if (this.enabled && !this.isRecordingConsole) {
        this.isRecordingConsole = true;
        try {
          const msg = args.map((a) => this.formatConsoleArg(a)).join(' ');
          this.recordLog('warn', msg);
        } catch {
        } finally {
          this.isRecordingConsole = false;
        }
      }
    };

    console.error = (...args: any[]) => {
      this.originalConsoleError?.(...args);
      if (this.enabled && !this.isRecordingConsole) {
        this.isRecordingConsole = true;
        try {
          const msg = args.map((a) => this.formatConsoleArg(a)).join(' ');
          this.recordLog('error', msg);
        } catch {
        } finally {
          this.isRecordingConsole = false;
        }
      }
    };
  }

  private unhookConsole(): void {
    if (!this.isHookingConsole || typeof console === 'undefined') return;
    if (this.originalConsoleWarn) {
      console.warn = this.originalConsoleWarn;
      this.originalConsoleWarn = undefined;
    }
    if (this.originalConsoleError) {
      console.error = this.originalConsoleError;
      this.originalConsoleError = undefined;
    }
    this.isHookingConsole = false;
  }

  public destroy(): void {
    this.flush();
    this.stopFlushTimer();
    this.unhookConsole();
    this.queue = [];
  }
}
