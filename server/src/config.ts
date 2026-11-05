import fs from 'node:fs';
import path from 'node:path';

export interface StreamConfig {
  bitrate: number; // in bps, e.g. 8000000 = 8Mbps
  maxFps: number; // e.g. 60
  maxSize: number; // maximum dimension, e.g. 1920
}

export interface AppConfig {
  isSetupCompleted: boolean;
  pinHash: string; // bcrypt hash of PIN
  allowedDomains: string[]; // e.g. ["tesroid.example.com"]
  autoSleepMinutes: number; // 0 to disable
  defaultDpi: number; // e.g. 160
  displayScale: number; // e.g. 120 = 120% (car display readable zoom)
  displayScaleUserSet?: boolean;
  stream: StreamConfig;
}

const DEFAULT_CONFIG: AppConfig = {
  isSetupCompleted: false,
  pinHash: '',
  allowedDomains: [],
  autoSleepMinutes: 3,
  defaultDpi: 160,
  displayScale: 120,
  displayScaleUserSet: false,
  stream: {
    bitrate: 1000000,
    maxFps: 30,
    maxSize: 1280,
  },
};

export class ConfigStore {
  private dataDir: string;
  private configPath: string;
  private currentConfig: AppConfig;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || process.env.DATA_DIR || path.join(process.cwd(), 'data');
    this.configPath = path.join(this.dataDir, 'config.json');
    this.currentConfig = this.loadConfig();
  }

  public getDataDir(): string {
    return this.dataDir;
  }

  public getConfig(): Readonly<AppConfig> {
    return { ...this.currentConfig };
  }

  public isSetupCompleted(): boolean {
    return this.currentConfig.isSetupCompleted;
  }

  public updateConfig(partial: Partial<AppConfig>): AppConfig {
    if (partial.displayScale !== undefined) {
      partial.displayScaleUserSet = true;
    }
    this.currentConfig = {
      ...this.currentConfig,
      ...partial,
      stream: {
        ...this.currentConfig.stream,
        ...(partial.stream || {}),
      },
    };
    this.saveConfig();
    return this.getConfig();
  }

  private loadConfig(): AppConfig {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        // Migrate legacy default displayScale (85) to new readable car default (120) if not explicitly customized
        if (parsed.displayScale === 85 && !parsed.displayScaleUserSet) {
          parsed.displayScale = 120;
        }
        return {
          ...DEFAULT_CONFIG,
          ...parsed,
          stream: {
            ...DEFAULT_CONFIG.stream,
            ...(parsed.stream || {}),
          },
        };
      }
    } catch (err) {
      console.error('[ConfigStore] Failed to load config, falling back to default:', err);
    }
    return { ...DEFAULT_CONFIG };
  }

  private saveConfig(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.currentConfig, null, 2), 'utf-8');
    } catch (err) {
      console.error('[ConfigStore] Failed to save config to file:', err);
    }
  }
}
