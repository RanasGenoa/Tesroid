import fs from 'node:fs';
import path from 'node:path';
import { TelemetryEvent } from '../ws/protocol.js';

export interface TelemetrySessionInfo {
  sessionId: string;
  filename: string;
  filePath: string;
  createdAt: number;
  updatedAt: number;
  sizeBytes: number;
  eventCount: number;
}

export class TelemetryManager {
  private static instance: TelemetryManager | null = null;
  private logDir: string;
  private maxSessions: number;
  private maxFileSizeBytes: number;
  private activeStreams: Map<string, fs.WriteStream> = new Map();
  private sessionEventCounts: Map<string, number> = new Map();

  constructor(options: { logDir?: string; maxSessions?: number; maxFileSizeBytes?: number } = {}) {
    const defaultDataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
    this.logDir =
      options.logDir ||
      process.env.TELEMETRY_LOG_DIR ||
      path.join(defaultDataDir, 'logs', 'telemetry');
    this.maxSessions = options.maxSessions || 15;
    this.maxFileSizeBytes = options.maxFileSizeBytes || 10 * 1024 * 1024; // 10MB per session

    this.ensureDir();
  }

  public static getInstance(): TelemetryManager {
    if (!TelemetryManager.instance) {
      TelemetryManager.instance = new TelemetryManager();
    }
    return TelemetryManager.instance;
  }

  public static resetInstance(): void {
    if (TelemetryManager.instance) {
      TelemetryManager.instance.closeAllStreams();
      TelemetryManager.instance = null;
    }
  }

  private ensureDir(): void {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch (err) {
      console.warn(`[TelemetryManager] Failed to create log directory: ${this.logDir}`, err);
    }
  }

  public getLogDir(): string {
    return this.logDir;
  }

  public createSessionId(prefix: string = 'session'): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const sessionId = `${prefix}-${dateStr}-${randomSuffix}`;

    this.pruneOldSessions().catch(() => {});
    return sessionId;
  }

  private getSessionPath(sessionId: string): string {
    // Sanitize filename to prevent directory traversal
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.logDir, `${safeSessionId}.jsonl`);
  }

  public async appendEvents(sessionId: string, events: TelemetryEvent[]): Promise<void> {
    if (!events || events.length === 0) return;

    this.ensureDir();
    const filePath = this.getSessionPath(sessionId);

    // Check file size guard to avoid disk bloat
    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        if (stats.size >= this.maxFileSizeBytes) {
          console.warn(`[TelemetryManager] Session ${sessionId} exceeded max log size (${this.maxFileSizeBytes} bytes). Discarding further events.`);
          return;
        }
      }
    } catch {}

    const now = Date.now();
    const lines = events
      .map((ev) => {
        const record = {
          ...ev,
          sessionId,
          serverTimestamp: now,
        };
        return JSON.stringify(record);
      })
      .join('\n') + '\n';

    try {
      await fs.promises.appendFile(filePath, lines, 'utf-8');
      const currentCount = (this.sessionEventCounts.get(sessionId) || 0) + events.length;
      this.sessionEventCounts.set(sessionId, currentCount);
    } catch (err) {
      console.warn(`[TelemetryManager] Failed to write events for session ${sessionId}:`, err);
    }
  }

  public async listSessions(): Promise<TelemetrySessionInfo[]> {
    this.ensureDir();
    try {
      const files = await fs.promises.readdir(this.logDir);
      const sessionFiles = files.filter((f) => f.endsWith('.jsonl'));
      const list: TelemetrySessionInfo[] = [];

      for (const filename of sessionFiles) {
        const filePath = path.join(this.logDir, filename);
        try {
          const stat = await fs.promises.stat(filePath);
          const sessionId = path.basename(filename, '.jsonl');
          const count = this.sessionEventCounts.get(sessionId) || 0;
          list.push({
            sessionId,
            filename,
            filePath,
            createdAt: stat.birthtimeMs || stat.ctimeMs,
            updatedAt: stat.mtimeMs,
            sizeBytes: stat.size,
            eventCount: count,
          });
        } catch {}
      }

      // Sort by newest first
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      return list;
    } catch (err) {
      console.warn('[TelemetryManager] Failed to list sessions:', err);
      return [];
    }
  }

  public async getLatestSessionFile(): Promise<string | null> {
    const list = await this.listSessions();
    if (list.length === 0) return null;
    return list[0].filePath;
  }

  public async getSessionFile(sessionId: string): Promise<string | null> {
    const filePath = this.getSessionPath(sessionId);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
    return null;
  }

  public async clearAllSessions(): Promise<void> {
    this.closeAllStreams();
    this.sessionEventCounts.clear();
    this.ensureDir();
    try {
      const files = await fs.promises.readdir(this.logDir);
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          await fs.promises.unlink(path.join(this.logDir, file)).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('[TelemetryManager] Failed to clear sessions:', err);
    }
  }

  public async pruneOldSessions(): Promise<void> {
    const list = await this.listSessions();
    if (list.length <= this.maxSessions) return;

    const toDelete = list.slice(this.maxSessions);
    for (const item of toDelete) {
      try {
        await fs.promises.unlink(item.filePath);
        this.sessionEventCounts.delete(item.sessionId);
      } catch {}
    }
  }

  public closeAllStreams(): void {
    for (const stream of this.activeStreams.values()) {
      try {
        stream.end();
      } catch {}
    }
    this.activeStreams.clear();
  }
}
