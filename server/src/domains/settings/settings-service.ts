import type { AppSettings, SettingsUpdateInput } from "@tesroid/shared";
import type { AtomicJsonStore } from "../../infra/index.js";
import type {
  CompleteSetupRepoInput,
  SettingsChangeListener,
  SettingsRepository,
  UpdateSettingsRepoOptions,
} from "./ports.js";

export interface SettingsServiceDeps {
  readonly store: AtomicJsonStore;
  readonly filePath: string;
}

export class SettingsService implements SettingsRepository {
  // Spec: docs/specs/01-auth-security.md#2.3
  constructor(deps: SettingsServiceDeps) {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#4
  load(): Promise<AppSettings> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/07-ui-hud-settings.md#2.4
  getCurrent(): AppSettings {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#3.1
  save(next: AppSettings): Promise<AppSettings> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.3
  completeSetup(input: CompleteSetupRepoInput): Promise<AppSettings> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/01-auth-security.md#2.1
  updateSettings(
    patch: SettingsUpdateInput,
    options: UpdateSettingsRepoOptions,
  ): Promise<AppSettings> {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/architecture.md#2.3
  subscribe(listener: SettingsChangeListener): () => void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
