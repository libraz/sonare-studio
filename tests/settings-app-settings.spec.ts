import { beforeEach, describe, expect, it } from 'vitest';
import { APP_SETTINGS_STORAGE_KEY, useAppSettings } from '@/composables/useAppSettings';
import {
  APP_SETTINGS_VERSION,
  AUTOSAVE_INTERVAL_MAX_MS,
  AUTOSAVE_INTERVAL_MIN_MS,
  COUNT_IN_BARS_MAX,
  DEFAULT_APP_SETTINGS,
  decodeAppSettings,
  encodeAppSettings,
  LOUDNESS_TARGET_MAX_LUFS,
  LOUDNESS_TARGET_MIN_LUFS,
  migrateAppSettings,
  resolveAppLanguage,
  resolveAppTheme,
  sanitizeAppSettings,
} from '@/ui/settings/app-settings';

describe('sanitizeAppSettings', () => {
  it('returns defaults for non-objects', () => {
    expect(sanitizeAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(sanitizeAppSettings('x')).toEqual(DEFAULT_APP_SETTINGS);
    expect(sanitizeAppSettings(undefined)).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('keeps valid fields and defaults invalid ones', () => {
    const out = sanitizeAppSettings({
      editorDensity: 'compact',
      snapDefault: false,
      countInBars: 2,
      monitorDefault: 'yes',
      autosaveIntervalMs: 60000,
      scrollFollowPlayhead: 0,
      confirmDestructive: false,
      theme: 'light',
      language: 'ja',
      bogus: true,
    });
    expect(out).toEqual({
      theme: 'light',
      language: 'ja',
      editorDensity: 'compact',
      snapDefault: false,
      countInBars: 2,
      monitorDefault: DEFAULT_APP_SETTINGS.monitorDefault,
      autosaveIntervalMs: 60000,
      scrollFollowPlayhead: DEFAULT_APP_SETTINGS.scrollFollowPlayhead,
      pianoRollLaneVisible: DEFAULT_APP_SETTINGS.pianoRollLaneVisible,
      pianoRollSnapToScale: DEFAULT_APP_SETTINGS.pianoRollSnapToScale,
      pianoRollGhostMode: DEFAULT_APP_SETTINGS.pianoRollGhostMode,
      pianoRollGhostHideMuted: DEFAULT_APP_SETTINGS.pianoRollGhostHideMuted,
      pianoRollNoteColorMode: DEFAULT_APP_SETTINGS.pianoRollNoteColorMode,
      pianoRollAuditionDrag: DEFAULT_APP_SETTINGS.pianoRollAuditionDrag,
      confirmDestructive: false,
      loudnessTargetLufs: DEFAULT_APP_SETTINGS.loudnessTargetLufs,
    });
  });

  it('keeps a valid loudness target and clamps out-of-range ones', () => {
    expect(sanitizeAppSettings({ loudnessTargetLufs: -16 }).loudnessTargetLufs).toBe(-16);
    expect(sanitizeAppSettings({ loudnessTargetLufs: -100 }).loudnessTargetLufs).toBe(
      LOUDNESS_TARGET_MIN_LUFS,
    );
    expect(sanitizeAppSettings({ loudnessTargetLufs: 5 }).loudnessTargetLufs).toBe(
      LOUDNESS_TARGET_MAX_LUFS,
    );
    expect(sanitizeAppSettings({ loudnessTargetLufs: Number.NaN }).loudnessTargetLufs).toBe(
      DEFAULT_APP_SETTINGS.loudnessTargetLufs,
    );
  });

  it('clamps and rounds numeric fields', () => {
    const out = sanitizeAppSettings({ countInBars: 99.7, autosaveIntervalMs: 1 });
    expect(out.countInBars).toBe(COUNT_IN_BARS_MAX);
    expect(out.autosaveIntervalMs).toBe(AUTOSAVE_INTERVAL_MIN_MS);
    expect(sanitizeAppSettings({ autosaveIntervalMs: 1e9 }).autosaveIntervalMs).toBe(
      AUTOSAVE_INTERVAL_MAX_MS,
    );
    expect(sanitizeAppSettings({ countInBars: Number.NaN }).countInBars).toBe(
      DEFAULT_APP_SETTINGS.countInBars,
    );
  });

  it('defaults invalid theme and language values', () => {
    const out = sanitizeAppSettings({ theme: 'sepia', language: 'fr' });
    expect(out.theme).toBe(DEFAULT_APP_SETTINGS.theme);
    expect(out.language).toBe(DEFAULT_APP_SETTINGS.language);
  });
});

describe('theme and language resolution', () => {
  it('resolves system theme against the OS preference', () => {
    expect(resolveAppTheme('system', true)).toBe('dark');
    expect(resolveAppTheme('system', false)).toBe('light');
    expect(resolveAppTheme('dark', false)).toBe('dark');
  });

  it('resolves system language from browser languages', () => {
    expect(resolveAppLanguage('system', ['ja-JP', 'en-US'])).toBe('ja');
    expect(resolveAppLanguage('system', ['en-US'])).toBe('en');
    expect(resolveAppLanguage('en', ['ja-JP'])).toBe('en');
  });
});

describe('migrateAppSettings / codec', () => {
  it('round-trips the current version', () => {
    const settings = sanitizeAppSettings({ countInBars: 1, snapDefault: false });
    expect(decodeAppSettings(encodeAppSettings(settings))).toEqual(settings);
  });

  it('salvages fields from an unknown-version envelope', () => {
    const out = migrateAppSettings({
      version: APP_SETTINGS_VERSION + 1,
      settings: { countInBars: 3 },
    });
    expect(out.countInBars).toBe(3);
    expect(out.snapDefault).toBe(DEFAULT_APP_SETTINGS.snapDefault);
  });

  it('salvages a flat legacy payload without an envelope', () => {
    expect(migrateAppSettings({ snapDefault: false }).snapDefault).toBe(false);
  });

  it('returns defaults for null text and corrupt JSON', () => {
    expect(decodeAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(decodeAppSettings('{oops')).toEqual(DEFAULT_APP_SETTINGS);
  });
});

describe('useAppSettings', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAppSettings().reset();
  });

  it('starts from defaults', () => {
    expect({ ...useAppSettings().settings }).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('set persists a validated value', () => {
    const app = useAppSettings();
    app.set('countInBars', 2);
    expect(app.settings.countInBars).toBe(2);
    const stored = JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}');
    expect(stored.version).toBe(APP_SETTINGS_VERSION);
    expect(stored.settings.countInBars).toBe(2);
  });

  it('set clamps out-of-range values', () => {
    const app = useAppSettings();
    app.set('autosaveIntervalMs', 1);
    expect(app.settings.autosaveIntervalMs).toBe(AUTOSAVE_INTERVAL_MIN_MS);
  });

  it('update applies a partial patch', () => {
    const app = useAppSettings();
    app.update({ snapDefault: false, monitorDefault: true });
    expect(app.settings.snapDefault).toBe(false);
    expect(app.settings.monitorDefault).toBe(true);
    expect(app.settings.confirmDestructive).toBe(DEFAULT_APP_SETTINGS.confirmDestructive);
  });

  it('shares state across callers', () => {
    const a = useAppSettings();
    const b = useAppSettings();
    a.set('editorDensity', 'compact');
    expect(b.settings.editorDensity).toBe('compact');
  });

  it('reset restores defaults and persists them', () => {
    const app = useAppSettings();
    app.set('snapDefault', false);
    app.reset();
    expect(app.settings.snapDefault).toBe(DEFAULT_APP_SETTINGS.snapDefault);
    const stored = JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}');
    expect(stored.settings).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('reload re-reads storage', () => {
    const app = useAppSettings();
    window.localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      encodeAppSettings(sanitizeAppSettings({ countInBars: 4 })),
    );
    app.reload();
    expect(app.settings.countInBars).toBe(4);
  });

  it('applies theme and language to the document', () => {
    const app = useAppSettings();
    app.update({ theme: 'dark', language: 'ja' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themePreference).toBe('dark');
    expect(document.documentElement.lang).toBe('ja');
  });

  it('reflects the editor density on the document for CSS to consume', () => {
    const app = useAppSettings();
    app.update({ editorDensity: 'compact' });
    expect(document.documentElement.dataset.density).toBe('compact');
    app.update({ editorDensity: 'comfortable' });
    expect(document.documentElement.dataset.density).toBe('comfortable');
  });
});
