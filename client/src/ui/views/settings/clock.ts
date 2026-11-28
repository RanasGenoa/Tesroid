export interface SettingsPollingTimerHandle {
  cancel(): void;
}

export interface SettingsPollingClock {
  nowMs(): number;
  setTimeout(callback: () => void, delayMs: number): SettingsPollingTimerHandle;
  clearTimeout(handle: SettingsPollingTimerHandle): void;
}

export function defaultPollingClock(): SettingsPollingClock {
  return {
    nowMs: () => Date.now(),
    setTimeout: (callback, delayMs) => {
      const id = globalThis.setTimeout(callback, delayMs);
      return {
        cancel: () => {
          globalThis.clearTimeout(id);
        },
      };
    },
    clearTimeout: (handle) => {
      handle.cancel();
    },
  };
}
