import {
  encodeTelemetryFrame,
  ProtocolError,
  TELEMETRY_LIMITS,
  type TelemetryCategory,
  type TelemetryEventInput,
} from "@tesroid/shared";
import {
  type ClientClock,
  type ClientTimerHandle,
  createBrowserClock,
  type WsTransportPort,
} from "../transport/ports.js";

export interface TelemetryConsoleTarget {
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface TelemetryClientDeps {
  readonly transport: WsTransportPort;
  readonly clock?: ClientClock;
  readonly consoleTarget?: TelemetryConsoleTarget;
}

interface SyncThrottleEntry {
  lastEmittedAtMs: number;
  suppressedCount: number;
}

const DEFAULT_MAX_SANITIZE_DEPTH = 8;

function sanitizeInternal(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
  maxDepth: number,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    case "symbol":
      return String(value);
    case "function":
      return "[Function]";
    case "object":
      break;
  }

  const obj = value;
  if (ancestors.has(obj)) {
    return "[Circular]";
  }
  if (depth >= maxDepth) {
    return "[MaxDepth]";
  }

  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: obj.message,
      ...(obj.stack !== undefined ? { stack: obj.stack } : {}),
    };
  }

  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((item) => sanitizeInternal(item, ancestors, depth + 1, maxDepth));
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      let propValue: unknown;
      try {
        propValue = (obj as Record<string, unknown>)[key];
      } catch {
        output[key] = "[Unreadable]";
        continue;
      }
      const sanitized = sanitizeInternal(propValue, ancestors, depth + 1, maxDepth);
      if (sanitized !== undefined) {
        output[key] = sanitized;
      }
    }
    return output;
  } finally {
    ancestors.delete(obj);
  }
}

// Spec: docs/specs/08-observability.md#2.2
export function sanitizeTelemetryValue(
  value: unknown,
  maxDepth: number = DEFAULT_MAX_SANITIZE_DEPTH,
): unknown {
  return sanitizeInternal(value, new WeakSet<object>(), 0, maxDepth);
}

// Spec: docs/specs/08-observability.md#2.2
export function sanitizeTelemetryData(
  data?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (data === undefined) {
    return undefined;
  }
  const sanitized = sanitizeTelemetryValue(data);
  if (typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }
  return { value: sanitized };
}

export class ClientTelemetryReporter {
  private readonly deps: TelemetryClientDeps;
  private readonly clock: ClientClock;
  private readonly consoleTarget: TelemetryConsoleTarget | null;

  private enabled = false;
  private queue: TelemetryEventInput[] = [];
  private flushTimer: ClientTimerHandle | null = null;
  private readonly syncThrottle = new Map<string, SyncThrottleEntry>();

  private originalWarn: ((...args: unknown[]) => void) | null = null;
  private originalError: ((...args: unknown[]) => void) | null = null;
  private inConsoleHook = false;

  // Spec: docs/specs/08-observability.md#2.2
  constructor(deps: TelemetryClientDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? createBrowserClock();
    this.consoleTarget =
      deps.consoleTarget ?? (typeof globalThis.console !== "undefined" ? globalThis.console : null);
  }

  // Spec: docs/specs/08-observability.md#2.2
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) {
      return;
    }

    if (enabled) {
      this.enabled = true;
      this.installConsoleHooks();
      this.armFlushTimer();
      return;
    }

    this.uninstallConsoleHooks();
    this.stopFlushTimer();
    this.enqueueEvent({
      category: "log",
      event: "telemetry_disabled",
      timestamp: this.clock.nowMs(),
    });
    this.flushInternal(true);
    this.enabled = false;
    this.queue = [];
    this.syncThrottle.clear();
  }

  // Spec: docs/specs/08-observability.md#2.2
  isEnabled(): boolean {
    return this.enabled;
  }

  // Spec: docs/specs/08-observability.md#2.2
  record(category: TelemetryCategory, event: string, data?: Record<string, unknown>): void {
    if (!this.enabled || event.length === 0) {
      return;
    }
    const sanitizedData = sanitizeTelemetryData(data);
    this.enqueueEvent({
      category,
      event,
      timestamp: this.clock.nowMs(),
      ...(sanitizedData !== undefined ? { data: sanitizedData } : {}),
    });
  }

  // Spec: docs/specs/08-observability.md#2.2
  recordThrottledSync(event: string, data?: Record<string, unknown>): void {
    if (!this.enabled || event.length === 0) {
      return;
    }
    const nowMs = this.clock.nowMs();
    const existing = this.syncThrottle.get(event);
    if (
      existing !== undefined &&
      nowMs - existing.lastEmittedAtMs < TELEMETRY_LIMITS.syncThrottleMs
    ) {
      existing.suppressedCount += 1;
      return;
    }

    const suppressedCount = existing?.suppressedCount ?? 0;
    this.syncThrottle.set(event, {
      lastEmittedAtMs: nowMs,
      suppressedCount: 0,
    });

    const payload = suppressedCount > 0 ? { ...(data ?? {}), suppressedCount } : data;
    this.record("av_sync", event, payload);
  }

  // Spec: docs/specs/08-observability.md#2.2
  flush(): void {
    if (!this.enabled || this.queue.length === 0) {
      return;
    }
    this.flushInternal(false);
  }

  // Spec: docs/specs/08-observability.md#2.2
  dispose(): void {
    this.uninstallConsoleHooks();
    this.stopFlushTimer();
    this.enabled = false;
    this.queue = [];
    this.syncThrottle.clear();
  }

  private enqueueEvent(entry: TelemetryEventInput): void {
    if (this.queue.length >= TELEMETRY_LIMITS.maxBatchEvents) {
      this.queue.shift();
    }
    this.queue.push(entry);
  }

  private armFlushTimer(): void {
    if (!this.enabled || this.flushTimer !== null) {
      return;
    }
    const scheduleNext = () => {
      if (!this.enabled) {
        return;
      }
      this.flushTimer = this.clock.setTimeout(() => {
        this.flushTimer = null;
        if (!this.enabled) {
          return;
        }
        this.flush();
        scheduleNext();
      }, TELEMETRY_LIMITS.flushIntervalMs);
    };
    scheduleNext();
  }

  private stopFlushTimer(): void {
    if (this.flushTimer !== null) {
      this.clock.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private installConsoleHooks(): void {
    if (this.consoleTarget === null || this.originalWarn !== null || this.originalError !== null) {
      return;
    }
    const target = this.consoleTarget;
    const origWarn = target.warn.bind(target);
    const origError = target.error.bind(target);
    this.originalWarn = target.warn;
    this.originalError = target.error;

    target.warn = (...args: unknown[]) => {
      if (!this.inConsoleHook && this.enabled) {
        this.inConsoleHook = true;
        try {
          this.record("log", "console_warn", {
            args: sanitizeTelemetryValue(args),
          });
        } finally {
          this.inConsoleHook = false;
        }
      }
      origWarn(...args);
    };

    target.error = (...args: unknown[]) => {
      if (!this.inConsoleHook && this.enabled) {
        this.inConsoleHook = true;
        try {
          this.record("log", "console_error", {
            args: sanitizeTelemetryValue(args),
          });
        } finally {
          this.inConsoleHook = false;
        }
      }
      origError(...args);
    };
  }

  private uninstallConsoleHooks(): void {
    if (this.consoleTarget === null) {
      return;
    }
    if (this.originalWarn !== null) {
      this.consoleTarget.warn = this.originalWarn;
      this.originalWarn = null;
    }
    if (this.originalError !== null) {
      this.consoleTarget.error = this.originalError;
      this.originalError = null;
    }
  }

  private flushInternal(discardOnSendFailure: boolean): void {
    if (this.queue.length === 0) {
      return;
    }

    const pending = this.queue.splice(0, TELEMETRY_LIMITS.maxBatchEvents);
    const chunks = this.encodeBoundedChunks(pending);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (chunk === undefined) {
        continue;
      }
      const sent = this.deps.transport.sendBinary(chunk.frame);
      if (!sent) {
        if (!discardOnSendFailure) {
          const unsentEvents = chunks.slice(i).flatMap((item) => item.events);
          const merged = [...unsentEvents, ...this.queue];
          this.queue = merged.slice(-TELEMETRY_LIMITS.maxBatchEvents);
        }
        return;
      }
    }
  }

  private encodeBoundedChunks(
    events: readonly TelemetryEventInput[],
  ): readonly { readonly events: readonly TelemetryEventInput[]; readonly frame: Uint8Array }[] {
    if (events.length === 0) {
      return [];
    }
    try {
      const frame = encodeTelemetryFrame({ events });
      return [{ events, frame }];
    } catch (error) {
      if (!(error instanceof ProtocolError) || error.code !== "PAYLOAD_TOO_LARGE") {
        throw error;
      }
      if (events.length === 1) {
        return [];
      }
      const mid = Math.floor(events.length / 2);
      return [
        ...this.encodeBoundedChunks(events.slice(0, mid)),
        ...this.encodeBoundedChunks(events.slice(mid)),
      ];
    }
  }
}
