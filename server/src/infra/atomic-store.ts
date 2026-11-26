export interface AtomicJsonStore {
  readJson<T>(filePath: string): Promise<T | null>;
  writeJsonAtomic(filePath: string, data: unknown): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  remove(filePath: string): Promise<void>;
}

export interface JsonlFileInfo {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly lineCount: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface JsonlStore {
  ensureDir(dirPath: string): Promise<void>;
  appendLine(filePath: string, line: string): Promise<number>;
  statFile(filePath: string): Promise<JsonlFileInfo | null>;
  listFiles(dirPath: string, extension: string): Promise<readonly JsonlFileInfo[]>;
  readFileText(filePath: string): Promise<string | null>;
  deleteFile(filePath: string): Promise<void>;
  deleteAllFiles(dirPath: string, extension: string): Promise<void>;
}

export class NodeAtomicJsonStore implements AtomicJsonStore {
  // Spec: docs/architecture.md#3.1
  readJson<T>(filePath: string): Promise<T | null> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#3.1
  writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#3.1
  exists(filePath: string): Promise<boolean> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#3.1
  remove(filePath: string): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
}

export class NodeJsonlStore implements JsonlStore {
  // Spec: docs/specs/08-observability.md#2.2
  ensureDir(dirPath: string): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  appendLine(filePath: string, line: string): Promise<number> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  statFile(filePath: string): Promise<JsonlFileInfo | null> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  listFiles(dirPath: string, extension: string): Promise<readonly JsonlFileInfo[]> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  readFileText(filePath: string): Promise<string | null> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  deleteFile(filePath: string): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/08-observability.md#2.2
  deleteAllFiles(dirPath: string, extension: string): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
}
