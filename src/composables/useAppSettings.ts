import { reactive, readonly } from 'vue';
import {
  type AppSettings,
  DEFAULT_APP_SETTINGS,
  decodeAppSettings,
  encodeAppSettings,
  sanitizeAppSettings,
} from '@/ui/settings/app-settings';

/** localStorage key holding the versioned settings envelope. */
export const APP_SETTINGS_STORAGE_KEY = 'sonare-studio.settings';

/** Reactive settings state and actions returned by {@link useAppSettings}. */
export interface UseAppSettingsReturn {
  /** Live, reactive preferences (read-only; mutate via set/update). */
  settings: Readonly<AppSettings>;
  /** Sets one preference (validated/clamped) and persists immediately. */
  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void;
  /** Applies a partial patch (validated/clamped) and persists immediately. */
  update(patch: Partial<AppSettings>): void;
  /** Restores factory defaults and persists. */
  reset(): void;
  /** Re-reads settings from storage (discarding unsaved in-memory state). */
  reload(): void;
}

/** Reads the stored envelope; returns defaults when storage is unavailable. */
function readStored(): AppSettings {
  try {
    return decodeAppSettings(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

/** Best-effort write; storage failures (quota, privacy mode) are ignored. */
function writeStored(settings: AppSettings): void {
  try {
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, encodeAppSettings(settings));
  } catch {
    // Settings stay in memory for the session.
  }
}

// Single shared state so every caller observes the same preferences.
const state = reactive<AppSettings>(readStored());

function assign(next: AppSettings): void {
  Object.assign(state, next);
}

/**
 * Vue composable exposing the app-wide user preferences.
 *
 * All callers share one reactive state backed by localStorage; every write
 * is validated against the schema and persisted immediately. Safe to call
 * from any component or plain module code (no component scope required).
 */
export function useAppSettings(): UseAppSettingsReturn {
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    assign(sanitizeAppSettings({ ...state, [key]: value }));
    writeStored({ ...state });
  };

  const update = (patch: Partial<AppSettings>): void => {
    assign(sanitizeAppSettings({ ...state, ...patch }));
    writeStored({ ...state });
  };

  const reset = (): void => {
    assign({ ...DEFAULT_APP_SETTINGS });
    writeStored({ ...state });
  };

  const reload = (): void => {
    assign(readStored());
  };

  return { settings: readonly(state) as Readonly<AppSettings>, set, update, reset, reload };
}
