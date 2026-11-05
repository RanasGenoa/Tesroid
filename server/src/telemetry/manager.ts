import fs from 'node:fs';
import path from 'node:path';
import type { TelemetryEvent } from '../ws/protocol.js';

export interface TelemetrySessionInfo {
  sessionId: string;
  filename: string;
  filePath: string;
  createdAt: number;
  updatedAt: number;
  sizeBytes: number;
  eventCount: number;
}

const VALID_TELEMETRY_TYPES = new Set([
  'av_sync',
  'buffering',
  'decoder',
  'pacer',
  'audio',
  'network',
  'log',
]);

const MAX_EVENTS_PER_BATCH = 500;

export class TelemetryManager {
  private static instance: TelemetryManager | null = null;
  private logDir: string;
  private maxSessions: number;
  private maxFileSizeBytes: number;
  private sessionEventCounts: Map<string, number> = new Map();
  private cappedSessions: Set<string> = new Set();
  private writeQueues: Map<string, Promise<void>> = new Map();

  constructor(options: { logDir?: string; maxSessions?: number; maxFileSizeBytes?: number } = {}) {
    const defaultDataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
    this.logDir =
      options.logDir ||
      process.env.TELEMETRY_LOG_DIR ||
      path.join(defaultDataDir, 'logs', 'telemetry');
    this.maxSessions = options.maxSessions || 15;
    this.maxFileSizeBytes = options.maxFileSizeBytes || 10 * 1024 * 1024; // 10MB per session
  }

  public static getInstance(): TelemetryManager {
    if (!TelemetryManager.instance) {
      TelemetryManager.instance = new TelemetryManager();
    }
    return TelemetryManager.instance;
  }

  public static resetInstance(): void {
    TelemetryManager.instance = null;
  }

  private async ensureDirAsync(): Promise<void> {
    try {
      await fs.promises.mkdir(this.logDir, { recursive: true });
    } catch (err) {
      console.warn(`[TelemetryManager] Failed to create log directory: ${this.logDir}`, err);
    }
  }

  public getLogDir(): string {
    return this.logDir;
  }

  /**
   * Pure in-memory session ID generator (zero disk I/O until telemetry events actually arrive).
   */
  public createSessionId(prefix: string = 'session'): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    return `${prefix}-${dateStr}-${randomSuffix}`;
  }

  private sanitizeSessionId(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  private getSessionPath(sessionId: string): string {
    // Sanitize filename to prevent directory traversal
    const safeSessionId = this.sanitizeSessionId(sessionId);
    return path.join(this.logDir, `${safeSessionId}.jsonl`);
  }

  public async appendEvents(sessionId: string, events: TelemetryEvent[]): Promise<void> {
    if (!Array.isArray(events) || events.length === 0) return;

    const safeSessionId = this.sanitizeSessionId(sessionId);
    if (!safeSessionId || this.cappedSessions.has(safeSessionId)) return;

    const sanitizedEvents = events
      .slice(0, MAX_EVENTS_PER_BATCH)
      .filter(
        (ev): ev is TelemetryEvent =>
          ev !== null &&
          typeof ev === 'object' &&
          !Array.isArray(ev) &&
          typeof ev.event === 'string' &&
          typeof ev.type === 'string' &&
          VALID_TELEMETRY_TYPES.has(ev.type),
      );

    if (sanitizedEvents.length === 0) return;

    const prevTask = this.writeQueues.get(safeSessionId) ?? Promise.resolve();
    const nextTask = prevTask
      .catch(() => {})
      .then(() => this.appendEventsInternal(safeSessionId, sanitizedEvents));

    this.writeQueues.set(safeSessionId, nextTask);
    try {
      await nextTask;
    } finally {
      if (this.writeQueues.get(safeSessionId) === nextTask) {
        this.writeQueues.delete(safeSessionId);
      }
    }
  }

  private async appendEventsInternal(
    safeSessionId: string,
    events: TelemetryEvent[],
  ): Promise<void> {
    if (this.cappedSessions.has(safeSessionId)) return;

    await this.ensureDirAsync();
    const filePath = path.join(this.logDir, `${safeSessionId}.jsonl`);

    let currentSize = 0;
    let isNewSessionFile = false;
    try {
      const stats = await fs.promises.stat(filePath);
      currentSize = stats.size;
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        isNewSessionFile = true;
      }
    }

    if (currentSize >= this.maxFileSizeBytes) {
      this.cappedSessions.add(safeSessionId);
      return;
    }

    const now = Date.now();
    const serializedLines: string[] = [];
    let addedBytes = 0;

    for (const ev of events) {
      const line =
        JSON.stringify({
          timestamp: typeof ev.timestamp === 'number' ? ev.timestamp : now,
          type: ev.type,
          event: ev.event,
          ...(ev.data !== undefined ? { data: ev.data } : {}),
          sessionId: safeSessionId,
          serverTimestamp: now,
        }) + '\n';
      const lineBytes = Buffer.byteLength(line, 'utf-8');
      if (currentSize + addedBytes + lineBytes > this.maxFileSizeBytes) {
        this.cappedSessions.add(safeSessionId);
        console.warn(
          `[TelemetryManager] Session ${safeSessionId} reached max log size (${this.maxFileSizeBytes} bytes). Discarding further events.`,
        );
        break;
      }
      serializedLines.push(line);
      addedBytes += lineBytes;
    }

    if (serializedLines.length === 0) return;

    try {
      await fs.promises.appendFile(filePath, serializedLines.join(''), 'utf-8');
      const currentCount =
        (this.sessionEventCounts.get(safeSessionId) || 0) + serializedLines.length;
      this.sessionEventCounts.set(safeSessionId, currentCount);

      if (isNewSessionFile) {
        await this.pruneOldSessions();
      }
    } catch (err) {
      console.warn(`[TelemetryManager] Failed to write events for session ${safeSessionId}:`, err);
    }
  }

  private async countLinesInFile(filePath: string): Promise<number> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      if (!content) return 0;
      let count = 0;
      for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10) count++;
      }
      if (content.length > 0 && content.charCodeAt(content.length - 1) !== 10) {
        count++;
      }
      return count;
    } catch {
      return 0;
    }
  }

  public async listSessions(): Promise<TelemetrySessionInfo[]> {
    try {
      const files = await fs.promises.readdir(this.logDir);
      const sessionFiles = files.filter((f) => f.endsWith('.jsonl'));
      const list: TelemetrySessionInfo[] = [];

      for (const filename of sessionFiles) {
        const filePath = path.join(this.logDir, filename);
        try {
          const stat = await fs.promises.stat(filePath);
          const sessionId = path.basename(filename, '.jsonl');
          let count = this.sessionEventCounts.get(sessionId);
          if (count === undefined) {
            count = stat.size <= this.maxFileSizeBytes ? await this.countLinesInFile(filePath) : 0;
            this.sessionEventCounts.set(sessionId, count);
          }
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
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return [];
      }
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
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
      return filePath;
    } catch {
      return null;
    }
  }

  public async clearAllSessions(): Promise<void> {
    this.sessionEventCounts.clear();
    this.cappedSessions.clear();
    try {
      const files = await fs.promises.readdir(this.logDir);
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          await fs.promises.unlink(path.join(this.logDir, file)).catch(() => {});
        }
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.warn('[TelemetryManager] Failed to clear sessions:', err);
      }
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
        this.cappedSessions.delete(item.sessionId);
      } catch {}
    }
  }
}
