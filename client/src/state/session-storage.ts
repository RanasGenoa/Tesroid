import type { SessionRole } from "@tesroid/shared";

export interface StoredTabSession {
  readonly token: string;
  readonly role: SessionRole;
}

export interface TabSessionStoragePort {
  load(): StoredTabSession | null;
  save(session: StoredTabSession): void;
  clear(): void;
}

export class BrowserTabSessionStorage implements TabSessionStoragePort {
  // Spec: docs/specs/01-auth-security.md#2.1
  load(): StoredTabSession | null {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  save(session: StoredTabSession): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/02-session-multidisplay.md#2.3
  clear(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
