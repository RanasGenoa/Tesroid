import { SESSION_ROLES, type SessionRole } from "@tesroid/shared";

export interface StoredTabSession {
  readonly token: string;
  readonly role: SessionRole;
}

export interface TabSessionStoragePort {
  load(): StoredTabSession | null;
  save(session: StoredTabSession): void;
  clear(): void;
}

export interface SessionStorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const TAB_SESSION_STORAGE_KEY = "tesroid.tabSession.v1";
const SESSION_ROLE_SET = new Set<string>(SESSION_ROLES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultStorageBackend(): SessionStorageBackend | null {
  try {
    const candidate = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")?.value as
      | SessionStorageBackend
      | undefined;
    if (
      candidate !== undefined &&
      candidate !== null &&
      typeof candidate.getItem === "function" &&
      typeof candidate.setItem === "function" &&
      typeof candidate.removeItem === "function"
    ) {
      return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

export class BrowserTabSessionStorage implements TabSessionStoragePort {
  private readonly backend: SessionStorageBackend | null;

  // Spec: docs/specs/01-auth-security.md#2.1
  constructor(backend?: SessionStorageBackend | null) {
    this.backend = backend === undefined ? defaultStorageBackend() : backend;
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  load(): StoredTabSession | null {
    if (this.backend === null) {
      return null;
    }
    try {
      const raw = this.backend.getItem(TAB_SESSION_STORAGE_KEY);
      if (raw === null || raw.length === 0) {
        return null;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        return null;
      }
      if (typeof parsed.token !== "string" || parsed.token.length === 0) {
        return null;
      }
      if (typeof parsed.role !== "string" || !SESSION_ROLE_SET.has(parsed.role)) {
        return null;
      }
      return {
        token: parsed.token,
        role: parsed.role as SessionRole,
      };
    } catch {
      return null;
    }
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  save(session: StoredTabSession): void {
    if (this.backend === null) {
      return;
    }
    try {
      this.backend.setItem(
        TAB_SESSION_STORAGE_KEY,
        JSON.stringify({
          token: session.token,
          role: session.role,
        }),
      );
    } catch {
      // Ignore storage quota or private-mode errors.
    }
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  clear(): void {
    if (this.backend === null) {
      return;
    }
    try {
      this.backend.removeItem(TAB_SESSION_STORAGE_KEY);
    } catch {
      // Ignore storage access errors.
    }
  }
}
