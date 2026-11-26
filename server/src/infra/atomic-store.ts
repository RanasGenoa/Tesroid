import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

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

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export class NodeAtomicJsonStore implements AtomicJsonStore {
  // Spec: docs/architecture.md#3.1
  async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const text = await fs.readFile(filePath, "utf8");
      return JSON.parse(text) as T;
    } catch (error) {
      if (isEnoentError(error)) {
        return null;
      }
      throw error;
    }
  }

  // Spec: docs/architecture.md#3.1
  async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    const dirPath = path.dirname(filePath);
    await fs.mkdir(dirPath, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(tmpPath, "w", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(tmpPath, filePath);
    } catch (error) {
      if (handle !== null) {
        await handle.close().catch(() => {});
      }
      await fs.unlink(tmpPath).catch(() => {});
      throw error;
    }
  }

  // Spec: docs/architecture.md#3.1
  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // Spec: docs/architecture.md#3.1
  async remove(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }
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
