/**
 * App-preference schema, validation and storage codec.
 *
 * Preferences are user-level (not part of the project document) and persist
 * to localStorage as a versioned JSON envelope. Unknown or invalid fields
 * fall back to their defaults so a corrupt or future payload never breaks
 * boot.
 */

/** Storage schema version of the settings envelope. */
export const APP_SETTINGS_VERSION = 1;

/** Color-theme preference. */
export type AppTheme = 'system' | 'light' | 'dark';

/** Resolved color theme applied to the document. */
export type ResolvedAppTheme = 'light' | 'dark';

/** UI language preference. */
export type AppLanguage = 'system' | 'en' | 'ja';

/** Resolved UI language applied to the document. */
export type ResolvedAppLanguage = 'en' | 'ja';

/** UI density of the editor panels. */
export type EditorDensity = 'comfortable' | 'compact';

/** Piano-roll ghost-note overlay scope. */
export type PianoRollGhostMode = 'all' | 'active-track' | 'none';

/** Piano-roll note color mapping. */
export type PianoRollNoteColorMode = 'track' | 'velocity' | 'channel';

/** User-level application preferences. */
export interface AppSettings {
  /** Color theme; 'system' follows the OS preference. */
  theme: AppTheme;
  /** UI language; 'system' follows the browser language list. */
  language: AppLanguage;
  /** Editor panel density. */
  editorDensity: EditorDensity;
  /** Whether grid snap starts enabled in a new session. */
  snapDefault: boolean;
  /** Recording count-in length in bars (0 disables the count-in). */
  countInBars: number;
  /** Whether input monitoring starts enabled when arming a track. */
  monitorDefault: boolean;
  /** Quiet period between the last edit and an autosave write. */
  autosaveIntervalMs: number;
  /** Whether the arrangement/piano-roll views follow the playhead. */
  scrollFollowPlayhead: boolean;
  /** Whether the piano-roll bottom velocity / CC lane is shown. */
  pianoRollLaneVisible: boolean;
  /** Whether newly drawn piano-roll notes snap to the highlighted scale. */
  pianoRollSnapToScale: boolean;
  /** Which non-active clips appear as piano-roll ghost notes. */
  pianoRollGhostMode: PianoRollGhostMode;
  /** Whether muted tracks are hidden from the piano-roll ghost overlay. */
  pianoRollGhostHideMuted: boolean;
  /** How editable piano-roll notes are colored. */
  pianoRollNoteColorMode: PianoRollNoteColorMode;
  /** Whether pitch-changing piano-roll drags audition the destination pitch. */
  pianoRollAuditionDrag: boolean;
  /** Ask for confirmation before destructive actions (delete project, discard edits). */
  confirmDestructive: boolean;
  /**
   * Integrated-loudness target in LUFS the master meter compares against
   * (e.g. -14 for most streaming services, -23 for EBU R128 broadcast).
   */
  loudnessTargetLufs: number;
}

/** Count-in bounds in bars. */
export const COUNT_IN_BARS_MIN = 0;
export const COUNT_IN_BARS_MAX = 4;

/** Autosave interval bounds in milliseconds. */
export const AUTOSAVE_INTERVAL_MIN_MS = 5000;
export const AUTOSAVE_INTERVAL_MAX_MS = 600000;

/** Integrated-loudness target bounds in LUFS (broadcast-quiet to loud masters). */
export const LOUDNESS_TARGET_MIN_LUFS = -31;
export const LOUDNESS_TARGET_MAX_LUFS = -5;

/** Factory defaults (matching the shell's current hardcoded behavior). */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  language: 'system',
  editorDensity: 'comfortable',
  snapDefault: true,
  countInBars: 0,
  monitorDefault: false,
  autosaveIntervalMs: 30000,
  scrollFollowPlayhead: true,
  pianoRollLaneVisible: true,
  pianoRollSnapToScale: false,
  pianoRollGhostMode: 'all',
  pianoRollGhostHideMuted: true,
  pianoRollNoteColorMode: 'track',
  pianoRollAuditionDrag: true,
  confirmDestructive: true,
  loudnessTargetLufs: -14,
};

/** Clamps a number to [lo, hi]. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asIntInRange(value: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), lo, hi);
}

function asTheme(value: unknown, fallback: AppTheme): AppTheme {
  return value === 'system' || value === 'light' || value === 'dark' ? value : fallback;
}

function asLanguage(value: unknown, fallback: AppLanguage): AppLanguage {
  return value === 'system' || value === 'en' || value === 'ja' ? value : fallback;
}

function asPianoRollGhostMode(value: unknown, fallback: PianoRollGhostMode): PianoRollGhostMode {
  return value === 'all' || value === 'active-track' || value === 'none' ? value : fallback;
}

function asPianoRollNoteColorMode(
  value: unknown,
  fallback: PianoRollNoteColorMode,
): PianoRollNoteColorMode {
  return value === 'track' || value === 'velocity' || value === 'channel' ? value : fallback;
}

/**
 * Validates a raw settings object field by field; anything missing or
 * out of range falls back to the default.
 *
 * @param raw Untrusted value (parsed JSON, partial patch, …).
 * @returns A complete, valid settings object.
 */
export function sanitizeAppSettings(raw: unknown): AppSettings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const defaults = DEFAULT_APP_SETTINGS;
  return {
    theme: asTheme(source.theme, defaults.theme),
    language: asLanguage(source.language, defaults.language),
    editorDensity:
      source.editorDensity === 'compact' || source.editorDensity === 'comfortable'
        ? source.editorDensity
        : defaults.editorDensity,
    snapDefault: asBoolean(source.snapDefault, defaults.snapDefault),
    countInBars: asIntInRange(
      source.countInBars,
      COUNT_IN_BARS_MIN,
      COUNT_IN_BARS_MAX,
      defaults.countInBars,
    ),
    monitorDefault: asBoolean(source.monitorDefault, defaults.monitorDefault),
    autosaveIntervalMs: asIntInRange(
      source.autosaveIntervalMs,
      AUTOSAVE_INTERVAL_MIN_MS,
      AUTOSAVE_INTERVAL_MAX_MS,
      defaults.autosaveIntervalMs,
    ),
    scrollFollowPlayhead: asBoolean(source.scrollFollowPlayhead, defaults.scrollFollowPlayhead),
    pianoRollLaneVisible: asBoolean(source.pianoRollLaneVisible, defaults.pianoRollLaneVisible),
    pianoRollSnapToScale: asBoolean(source.pianoRollSnapToScale, defaults.pianoRollSnapToScale),
    pianoRollGhostMode: asPianoRollGhostMode(
      source.pianoRollGhostMode,
      defaults.pianoRollGhostMode,
    ),
    pianoRollGhostHideMuted: asBoolean(
      source.pianoRollGhostHideMuted,
      defaults.pianoRollGhostHideMuted,
    ),
    pianoRollNoteColorMode: asPianoRollNoteColorMode(
      source.pianoRollNoteColorMode,
      defaults.pianoRollNoteColorMode,
    ),
    pianoRollAuditionDrag: asBoolean(source.pianoRollAuditionDrag, defaults.pianoRollAuditionDrag),
    confirmDestructive: asBoolean(source.confirmDestructive, defaults.confirmDestructive),
    loudnessTargetLufs: asIntInRange(
      source.loudnessTargetLufs,
      LOUDNESS_TARGET_MIN_LUFS,
      LOUDNESS_TARGET_MAX_LUFS,
      defaults.loudnessTargetLufs,
    ),
  };
}

/**
 * Migrates a stored envelope of any version to the current schema.
 *
 * Version 1 is current; older/newer versions currently sanitize whatever
 * fields still line up and default the rest. New versions add their upgrade
 * step here.
 *
 * @param raw Parsed envelope ({ version, settings }) or any legacy shape.
 * @returns A complete settings object.
 */
export function migrateAppSettings(raw: unknown): AppSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_APP_SETTINGS };
  const envelope = raw as { version?: unknown; settings?: unknown };
  if (envelope.version === APP_SETTINGS_VERSION) {
    return sanitizeAppSettings(envelope.settings);
  }
  // Unknown version: salvage recognizable fields from either nesting level.
  return sanitizeAppSettings(envelope.settings ?? raw);
}

/** Encodes settings into the versioned JSON envelope for storage. */
export function encodeAppSettings(settings: AppSettings): string {
  return JSON.stringify({ version: APP_SETTINGS_VERSION, settings });
}

/**
 * Decodes a stored payload back into settings.
 *
 * @param text The stored JSON text, or null when nothing is stored.
 * @returns Valid settings; defaults when text is null or corrupt.
 */
export function decodeAppSettings(text: string | null): AppSettings {
  if (text === null) return { ...DEFAULT_APP_SETTINGS };
  try {
    return migrateAppSettings(JSON.parse(text));
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

/** Resolves a theme preference against an OS dark-mode flag. */
export function resolveAppTheme(theme: AppTheme, prefersDark: boolean): ResolvedAppTheme {
  return theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
}

/** Resolves a language preference against the browser language list. */
export function resolveAppLanguage(
  language: AppLanguage,
  browserLanguages: ReadonlyArray<string>,
): ResolvedAppLanguage {
  if (language === 'en' || language === 'ja') return language;
  return browserLanguages.some((entry) => entry.toLowerCase().startsWith('ja')) ? 'ja' : 'en';
}
