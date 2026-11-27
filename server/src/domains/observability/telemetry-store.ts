import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  type StoredTelemetryEvent,
  TELEMETRY_CATEGORIES,
  TELEMETRY_LIMITS,
  type TelemetryEventInput,
  type TelemetrySessionSummary,
} from "@tesroid/shared";
import type { Clock, JsonlStore } from "../../infra/index.js";
import type { SettingsRepository } from "../settings/ports.js";
import type { TelemetryServicePort } from "./ports.js";

export interface TelemetryStoreDeps {
  readonly clock: Clock;
  readonly settings: SettingsRepository;
  readonly jsonlStore: JsonlStore;
  readonly logDir: string;
  readonly sessionId?: string;
  readonly maxSessionFileBytes?: number;
  readonly maxSessions?: number;
}

const TELEMETRY_CATEGORY_SET = new Set<string>(TELEMETRY_CATEGORIES);
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const JSONL_EXTENSION = ".jsonl";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function generateSessionId(nowMs: number): string {
  const date = new Date(nowMs);
  const stamp = [
    String(date.getUTCFullYear()),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
    "-",
    pad2(date.getUTCHours()),
    pad2(date.getUTCMinutes()),
    pad2(date.getUTCSeconds()),
  ].join("");
  const rand = randomBytes(4).toString("hex");
  return `session-${stamp}-${rand}`;
}

function safeJsonStringify(value: unknown): string {
  const ancestors: object[] = [];
  return JSON.stringify(value, function (_key: string, current: unknown): unknown {
    if (typeof current === "bigint") {
      return current.toString();
    }
    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
        ...(current.stack !== undefined ? { stack: current.stack } : {}),
      };
    }
    if (typeof current === "object" && current !== null) {
      const parentIndex = ancestors.indexOf(this as object);
      if (parentIndex !== -1) {
        ancestors.length = parentIndex + 1;
      } else {
        ancestors.push(this as object);
      }
      if (ancestors.includes(current)) {
        return "[Circular]";
      }
    }
    return current;
  });
}

// Spec: docs/specs/08-observability.md#3
export function sanitizeTelemetrySessionId(sessionId: string): string | null {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    return null;
  }
  return sessionId;
}

// Spec: docs/specs/08-observability.md#2.2
export function isValidTelemetryEvent(value: unknown): value is TelemetryEventInput {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.category !== "string" || !TELEMETRY_CATEGORY_SET.has(value.category)) {
    return false;
  }
  if (typeof value.event !== "string" || value.event.length === 0) {
    return false;
  }
  if (
    value.timestamp !== undefined &&
    (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp))
  ) {
    return false;
  }
  if (value.data !== undefined && !isRecord(value.data)) {
    return false;
  }
  return true;
}

export class TelemetryStore implements TelemetryServicePort {
  private readonly deps: TelemetryStoreDeps;
  private readonly sessionId: string;
  private readonly maxSessionFileBytes: number;
  private readonly maxSessions: number;

  private writeQueue: Promise<void> = Promise.resolve();
  private fileStateLoaded = false;
  private fileCreated = false;
  private currentFileBytes = 0;
  private currentLineCount = 0;
  private sizeCapReached = false;

  // Spec: docs/specs/08-observability.md#2.2
  constructor(deps: TelemetryStoreDeps) {
    this.deps = deps;
    const providedId =
      deps.sessionId !== undefined ? sanitizeTelemetrySessionId(deps.sessionId) : null;
    this.sessionId = providedId ?? generateSessionId(deps.clock.nowMs());
    this.maxSessionFileBytes =
      deps.maxSessionFileBytes !== undefined &&
      Number.isInteger(deps.maxSessionFileBytes) &&
      deps.maxSessionFileBytes >= 1
        ? deps.maxSessionFileBytes
        : TELEMETRY_LIMITS.maxSessionFileBytes;
    this.maxSessions =
      deps.maxSessions !== undefined && Number.isInteger(deps.maxSessions) && deps.maxSessions >= 1
        ? deps.maxSessions
        : TELEMETRY_LIMITS.maxSessions;
  }

  // Spec: docs/specs/08-observability.md#2.2
  async initialize(): Promise<void> {
    // Lazy creation: defer all directory and file I/O until the first valid event arrives.
  }

  // Spec: docs/specs/08-observability.md#2.2
  getCurrentSessionId(): string {
    return this.sessionId;
  }

  // Spec: docs/specs/08-observability.md#2.2
  async appendBatch(events: readonly TelemetryEventInput[]): Promise<number> {
    if (!this.deps.settings.getCurrent().stream.telemetryEnabled) {
      return 0;
    }

    const bounded = events.slice(0, TELEMETRY_LIMITS.maxBatchEvents);
    const validEvents: TelemetryEventInput[] = [];
    for (const candidate of bounded) {
      if (isValidTelemetryEvent(candidate)) {
        validEvents.push(candidate);
      }
    }
    if (validEvents.length === 0) {
      return 0;
    }

    return this.enqueueMutation(async () => {
      if (!this.deps.settings.getCurrent().stream.telemetryEnabled) {
        return 0;
      }

      const filePath = this.resolveSessionFilePath(this.sessionId);
      if (!this.fileStateLoaded) {
        const existing = await this.deps.jsonlStore.statFile(filePath);
        if (existing !== null) {
          this.fileCreated = true;
          this.currentFileBytes = existing.sizeBytes;
          this.currentLineCount = existing.lineCount;
          this.sizeCapReached = existing.sizeBytes >= this.maxSessionFileBytes;
        } else {
          this.fileCreated = false;
          this.currentFileBytes = 0;
          this.currentLineCount = 0;
          this.sizeCapReached = false;
        }
        this.fileStateLoaded = true;
      }

      if (this.sizeCapReached) {
        return 0;
      }

      let writtenCount = 0;
      let createdNewFile = false;
      const serverTimestamp = new Date(this.deps.clock.nowMs()).toISOString();

      for (const event of validEvents) {
        const stored: StoredTelemetryEvent = {
          category: event.category,
          event: event.event,
          ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
          ...(event.data !== undefined ? { data: event.data } : {}),
          sessionId: this.sessionId,
          serverTimestamp,
        };
        const line = safeJsonStringify(stored);
        const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
        if (this.currentFileBytes + lineBytes > this.maxSessionFileBytes) {
          this.sizeCapReached = true;
          break;
        }

        if (!this.fileCreated) {
          await this.deps.jsonlStore.ensureDir(this.deps.logDir);
          this.fileCreated = true;
          createdNewFile = true;
        }

        const appendedBytes = await this.deps.jsonlStore.appendLine(filePath, line);
        this.currentFileBytes += appendedBytes;
        this.currentLineCount += 1;
        writtenCount += 1;

        if (this.currentFileBytes >= this.maxSessionFileBytes) {
          this.sizeCapReached = true;
          break;
        }
      }

      if (createdNewFile) {
        await this.rotateOldSessions();
      }

      return writtenCount;
    });
  }

  // Spec: docs/specs/08-observability.md#2.2
  async listSessions(): Promise<readonly TelemetrySessionSummary[]> {
    await this.writeQueue;
    const files = await this.deps.jsonlStore.listFiles(this.deps.logDir, JSONL_EXTENSION);
    const summaries: { readonly summary: TelemetrySessionSummary; readonly updatedAtMs: number }[] =
      [];

    for (const file of files) {
      if (!file.fileName.endsWith(JSONL_EXTENSION)) {
        continue;
      }
      const rawId = file.fileName.slice(0, -JSONL_EXTENSION.length);
      const safeId = sanitizeTelemetrySessionId(rawId);
      if (safeId === null) {
        continue;
      }
      summaries.push({
        updatedAtMs: file.updatedAtMs,
        summary: {
          sessionId: safeId,
          sizeBytes: file.sizeBytes,
          lineCount: file.lineCount,
          createdAt: new Date(file.createdAtMs).toISOString(),
          updatedAt: new Date(file.updatedAtMs).toISOString(),
        },
      });
    }

    summaries.sort((a, b) => {
      if (b.updatedAtMs !== a.updatedAtMs) {
        return b.updatedAtMs - a.updatedAtMs;
      }
      return b.summary.sessionId.localeCompare(a.summary.sessionId);
    });

    return summaries.map((item) => item.summary);
  }

  // Spec: docs/specs/08-observability.md#2.2
  async readSessionNdjson(sessionId: string): Promise<string | null> {
    const safeId = sanitizeTelemetrySessionId(sessionId);
    if (safeId === null) {
      return null;
    }
    await this.writeQueue;
    return this.deps.jsonlStore.readFileText(this.resolveSessionFilePath(safeId));
  }

  // Spec: docs/specs/08-observability.md#2.2
  async readLatestSessionNdjson(): Promise<{
    readonly sessionId: string;
    readonly content: string;
  } | null> {
    const sessions = await this.listSessions();
    const latest = sessions[0];
    if (latest === undefined) {
      return null;
    }
    const content = await this.deps.jsonlStore.readFileText(
      this.resolveSessionFilePath(latest.sessionId),
    );
    if (content === null) {
      return null;
    }
    return {
      sessionId: latest.sessionId,
      content,
    };
  }

  // Spec: docs/specs/08-observability.md#2.2
  async deleteAllSessions(): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.deps.jsonlStore.deleteAllFiles(this.deps.logDir, JSONL_EXTENSION);
      this.fileCreated = false;
      this.fileStateLoaded = false;
      this.currentFileBytes = 0;
      this.currentLineCount = 0;
      this.sizeCapReached = false;
    });
  }

  private resolveSessionFilePath(safeSessionId: string): string {
    return path.join(this.deps.logDir, `${safeSessionId}${JSONL_EXTENSION}`);
  }

  private enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async rotateOldSessions(): Promise<void> {
    const files = await this.deps.jsonlStore.listFiles(this.deps.logDir, JSONL_EXTENSION);
    if (files.length <= this.maxSessions) {
      return;
    }

    const currentFileName = `${this.sessionId}${JSONL_EXTENSION}`;
    const candidates = files
      .filter((file) => file.fileName !== currentFileName)
      .sort((a, b) => {
        if (a.updatedAtMs !== b.updatedAtMs) {
          return a.updatedAtMs - b.updatedAtMs;
        }
        return a.fileName.localeCompare(b.fileName);
      });

    const excess = files.length - this.maxSessions;
    for (let i = 0; i < excess && i < candidates.length; i += 1) {
      const target = candidates[i];
      if (target !== undefined) {
        await this.deps.jsonlStore.deleteFile(path.join(this.deps.logDir, target.fileName));
      }
    }
  }
}
