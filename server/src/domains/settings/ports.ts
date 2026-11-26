import type {
  AppSettings,
  EncoderBackend,
  SettingsUpdateInput,
  StreamSettings,
} from "@tesroid/shared";

export type SettingsChangeListener = (settings: AppSettings) => void;

export interface CompleteSetupRepoInput {
  readonly pinHash: string;
  readonly timezone: string;
  readonly streamPatch?: Partial<StreamSettings>;
}

export interface UpdateSettingsRepoOptions {
  readonly backend: EncoderBackend;
  readonly pinHash?: string;
}

export interface SettingsRepository {
  load(): Promise<AppSettings>;
  getCurrent(): AppSettings;
  save(next: AppSettings): Promise<AppSettings>;
  completeSetup(input: CompleteSetupRepoInput): Promise<AppSettings>;
  updateSettings(
    patch: SettingsUpdateInput,
    options: UpdateSettingsRepoOptions,
  ): Promise<AppSettings>;
  subscribe(listener: SettingsChangeListener): () => void;
}
