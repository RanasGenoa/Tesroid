import fs from 'node:fs';
import path from 'node:path';

export type PerformancePreset = 'high' | 'balanced' | 'low_power' | 'custom';

export interface PerformancePresetConfig {
  maxSize: number;
  vaapiCompressionLevel: number;
  vaapiLowPower: boolean;
  vaapiGpuColorConversion: boolean;
}

export const PERFORMANCE_PRESET_DEFAULTS: Record<
  Exclude<PerformancePreset, 'custom'>,
  PerformancePresetConfig
> = {
  high: {
    maxSize: 1920,
    vaapiCompressionLevel: 4,
    vaapiLowPower: false,
    vaapiGpuColorConversion: true,
  },
  balanced: {
    maxSize: 1280,
    vaapiCompressionLevel: 7,
    vaapiLowPower: false,
    vaapiGpuColorConversion: true,
  },
  low_power: {
    maxSize: 960,
    vaapiCompressionLevel: 7,
    vaapiLowPower: false,
    vaapiGpuColorConversion: true,
  },
};

export interface StreamConfig {
  bitrate: number; // in bps, e.g. 8000000 = 8Mbps
  maxFps: number; // e.g. 60
  maxSize: number; // maximum dimension, e.g. 1920
  audioBitrate?: number; // in bps, e.g. 128000 = 128kbps (128k - 320k)
  performancePreset?: PerformancePreset;
  vaapiCompressionLevel?: number; // 1 (best quality/heaviest) - 7 (fastest/lightest)
  vaapiLowPower?: boolean; // Enable Intel VDEnc (-low_power 1)
  vaapiGpuColorConversion?: boolean; // Offload RGB->NV12 conversion to GPU via scale_vaapi
}

export interface FavoriteItem {
  id: string;
  title: string;
  url: string;
}

export const DEFAULT_HOME_FAVORITE_ID = 'youtube';

export const DEFAULT_FAVORITES: FavoriteItem[] = [
  { id: 'youtube', title: 'YouTube', url: 'https://www.youtube.com' },
  { id: 'netflix', title: 'Netflix', url: 'https://www.netflix.com' },
  { id: 'abema', title: 'ABEMA', url: 'https://abema.tv' },
  { id: 'disneyplus', title: 'Disney+', url: 'https://www.disneyplus.com' },
  { id: 'unext', title: 'U-NEXT', url: 'https://video.unext.jp' },
  { id: 'dazn', title: 'DAZN', url: 'https://www.dazn.com' },
  { id: 'nicovideo', title: 'ニコニコ動画', url: 'https://www.nicovideo.jp' },
  { id: 'twitch', title: 'Twitch', url: 'https://www.twitch.tv' },
  { id: 'google', title: 'Google 検索', url: 'https://www.google.com' },
  { id: 'tver', title: 'TVer (動作不可)', url: 'https://tver.jp' },
  { id: 'primevideo', title: 'Prime Video (動作不可)', url: 'https://www.amazon.co.jp/primevideo' },
];

function isValidHttpUrl(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface AppConfig {
  isSetupCompleted: boolean;
  pinHash: string; // bcrypt hash of PIN
  allowedDomains: string[]; // e.g. ["tesroid.example.com"]
  autoSleepMinutes: number; // 0 to disable
  defaultDpi: number; // e.g. 160
  displayScale: number; // e.g. 120 = 120% (car display readable zoom)
  displayScaleUserSet?: boolean;
  locale?: string; // e.g. "ja-JP"
  timezone?: string; // e.g. "Asia/Tokyo"
  favorites: FavoriteItem[];
  homeFavoriteId: string;
  stream: StreamConfig;
}

export function resolveHomeUrl(config: Pick<AppConfig, 'favorites' | 'homeFavoriteId'>): string {
  const favorites = Array.isArray(config.favorites) ? config.favorites : [];
  const matched = favorites.find((f) => f.id === config.homeFavoriteId);
  const candidate = matched || favorites[0];
  if (candidate && isValidHttpUrl(candidate.url)) {
    return candidate.url.trim();
  }
  return 'https://www.youtube.com';
}

const DEFAULT_CONFIG: AppConfig = {
  isSetupCompleted: false,
  pinHash: '',
  allowedDomains: [],
  autoSleepMinutes: 3,
  defaultDpi: 160,
  displayScale: 120,
  displayScaleUserSet: false,
  locale: 'ja-JP',
  timezone: 'Asia/Tokyo',
  favorites: DEFAULT_FAVORITES.map((f) => ({ ...f })),
  homeFavoriteId: DEFAULT_HOME_FAVORITE_ID,
  stream: {
    bitrate: 1000000,
    maxFps: 30,
    maxSize: Number(process.env.STREAM_MAX_SIZE) || 1280,
    audioBitrate: 128000,
    performancePreset: 'balanced',
    vaapiCompressionLevel: Number(process.env.VAAPI_COMPRESSION_LEVEL) || 7,
    vaapiLowPower: process.env.VAAPI_LOW_POWER === 'true' || process.env.VAAPI_LOW_POWER === '1',
    vaapiGpuColorConversion:
      process.env.VAAPI_GPU_CSC !== 'false' && process.env.VAAPI_GPU_CSC !== '0',
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
    return {
      ...this.currentConfig,
      allowedDomains: [...(this.currentConfig.allowedDomains || [])],
      favorites: (this.currentConfig.favorites || []).map((f) => ({ ...f })),
      stream: { ...this.currentConfig.stream },
    };
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
      allowedDomains:
        partial.allowedDomains !== undefined
          ? [...partial.allowedDomains]
          : [...this.currentConfig.allowedDomains],
      favorites:
        partial.favorites !== undefined
          ? partial.favorites.map((f) => ({ ...f }))
          : this.currentConfig.favorites.map((f) => ({ ...f })),
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

        let favorites: FavoriteItem[];
        if (Array.isArray(parsed.favorites)) {
          const seenIds = new Set<string>();
          favorites = [];
          for (const item of parsed.favorites) {
            if (!item || typeof item !== 'object') continue;
            const id = typeof item.id === 'string' ? item.id.trim() : '';
            const title = typeof item.title === 'string' ? item.title.trim() : '';
            const url = typeof item.url === 'string' ? item.url.trim() : '';
            if (!id || !title || !isValidHttpUrl(url) || seenIds.has(id)) {
              continue;
            }
            seenIds.add(id);
            favorites.push({ id, title, url });
          }
        } else {
          favorites = DEFAULT_FAVORITES.map((f) => ({ ...f }));
        }

        const rawHomeId =
          typeof parsed.homeFavoriteId === 'string' ? parsed.homeFavoriteId.trim() : '';
        const homeFavoriteId = favorites.some((f) => f.id === rawHomeId)
          ? rawHomeId
          : favorites[0]?.id || DEFAULT_HOME_FAVORITE_ID;

        return {
          ...DEFAULT_CONFIG,
          ...parsed,
          favorites,
          homeFavoriteId,
          stream: {
            ...DEFAULT_CONFIG.stream,
            ...(parsed.stream || {}),
          },
        };
      }
    } catch (err) {
      console.error('[ConfigStore] Failed to load config, falling back to default:', err);
    }
    return {
      ...DEFAULT_CONFIG,
      allowedDomains: [...DEFAULT_CONFIG.allowedDomains],
      favorites: DEFAULT_FAVORITES.map((f) => ({ ...f })),
      stream: { ...DEFAULT_CONFIG.stream },
    };
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
