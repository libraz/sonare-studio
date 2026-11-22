/**
 * App-preference schema, validation and storage codec.
 *
 * Preferences are user-level (not part of the project document) and persist
 * to localStorage as a versioned JSON envelope. Unknown or invalid fields
 * fall back to their defaults so a corrupt or future payload never breaks
 * boot.
 */

import type { NoteNameSystem } from '@libraz/libcantus';
import type {
  RealtimeVoiceChangerConfigInput,
  StreamingPlatform,
  VoicePresetId,
} from '@libraz/libsonare';
import { DEFAULT_APP_GUIDANCE_PROFILE, type GuidanceProfile } from '@/compose/guidance-profile';
import {
  STREAMING_RETUNE_MAX_SEMITONES,
  STREAMING_RETUNE_MIN_SEMITONES,
} from '@/engine/streaming-retune';
import { clampInt } from '@/lib/math';
import {
  createDefaultStreamingPlatforms,
  normalizeStreamingPlatforms,
} from '@/ui/mastering/streaming';

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

/**
 * Note-name systems offered for pitch and key names, in picker order.
 *
 * Independent of the UI language: reading 音名 and reading a Japanese UI are
 * separate preferences, so this list is the same in every locale.
 */
export const NOTE_NAME_SYSTEMS = [
  'english',
  'german',
  'japanese',
  'italian',
  'fixedDo',
] as const satisfies ReadonlyArray<NoteNameSystem>;

/** UI density of the editor panels. */
export type EditorDensity = 'comfortable' | 'compact';

/** Piano-roll ghost-note overlay scope. */
export type PianoRollGhostMode = 'all' | 'active-track' | 'none';

/** Piano-roll note color mapping. */
export type PianoRollNoteColorMode = 'track' | 'velocity' | 'channel';

/** Realtime voice changer preset for microphone recording/monitoring. */
export type RecordingVoiceChangerPreset = 'off' | RealtimeVoiceChangerConfigInput;

/** Audio source captured by the recording workflow. */
export type RecordingCaptureSource = 'input' | 'output';

/**
 * How much wording the composition-guidance theory card shows. Every level
 * renders the same set of card lines; only the phrasing changes — beginner
 * uses plain, jargon-free sentences, theory uses terse technical terms.
 */
export type ExplainLevel = 'beginner' | 'normal' | 'theory';

/** User-level application preferences. */
export interface AppSettings {
  /** Color theme; 'system' follows the OS preference. */
  theme: AppTheme;
  /** UI language; 'system' follows the browser language list. */
  language: AppLanguage;
  /**
   * System pitch and key names are displayed in. Only display follows it:
   * chord-symbol suffixes, exported documents and any name parsed back stay
   * ASCII English.
   */
  noteNameSystem: NoteNameSystem;
  /** Editor panel density. */
  editorDensity: EditorDensity;
  /** Whether grid snap starts enabled in a new session. */
  snapDefault: boolean;
  /** Recording count-in length in bars (0 disables the count-in). */
  countInBars: number;
  /** MIDI input-quantize denominator for recorded notes; 0 disables quantize. */
  midiInputQuantizeDenominator: number;
  /** Whether input monitoring starts enabled when arming a track. */
  monitorDefault: boolean;
  /** Realtime voice changer preset inserted into the microphone input path. */
  recordingVoiceChangerPreset: RecordingVoiceChangerPreset;
  /** StreamingRetune semitone shift inserted into the microphone input path. */
  recordingRetuneSemitones: number;
  /** Audio source captured by the recording workflow. */
  recordingCaptureSource: RecordingCaptureSource;
  /** Browser audioinput device id used for microphone recording; empty = default input. */
  recordingInputDeviceId: string;
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
  /** Whether settled melody edits suggest chord-track updates in the piano roll. */
  pianoRollAutoReharmonize: boolean;
  /** Ask for confirmation before destructive actions (delete project, discard edits). */
  confirmDestructive: boolean;
  /** How much wording the composition-guidance theory card shows. */
  explainLevel: ExplainLevel;
  /**
   * Integrated-loudness target in LUFS the master meter compares against
   * (e.g. -14 for most streaming services, -23 for EBU R128 broadcast).
   */
  loudnessTargetLufs: number;
  /** Streaming loudness targets remembered across mastering sessions. */
  streamingPlatforms: StreamingPlatform[];
  /** Track ids hidden in the mixer view; empty displays every track. */
  mixerHiddenTrackIds: number[];
  /** Guidance profile for placement verdicts and harmonic analysis. */
  guidanceProfile: GuidanceProfile;
  /** Whether to show placement guide overlay on the piano roll. */
  pianoRollPlacementGuide: boolean;
  /** Whether to show background tint guidance on the piano roll. */
  pianoRollGuidanceTint: boolean;
}

/** Count-in bounds in bars. */
export const COUNT_IN_BARS_MIN = 0;
export const COUNT_IN_BARS_MAX = 4;

/** MIDI input quantize choices: off, quarter, eighth, sixteenth, thirty-second. */
export const MIDI_INPUT_QUANTIZE_DENOMINATORS = [0, 4, 8, 16, 32] as const;

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
  // English names in every locale; reading 音名 is an explicit choice rather
  // than a consequence of the UI language.
  noteNameSystem: 'english',
  editorDensity: 'comfortable',
  snapDefault: true,
  countInBars: 0,
  midiInputQuantizeDenominator: 0,
  monitorDefault: false,
  recordingVoiceChangerPreset: 'off',
  recordingRetuneSemitones: 0,
  recordingCaptureSource: 'input',
  recordingInputDeviceId: '',
  autosaveIntervalMs: 30000,
  scrollFollowPlayhead: true,
  pianoRollLaneVisible: true,
  pianoRollSnapToScale: false,
  pianoRollGhostMode: 'all',
  pianoRollGhostHideMuted: true,
  pianoRollNoteColorMode: 'track',
  pianoRollAuditionDrag: true,
  // Reactive chord suggestions can surprise a first-time composer; opt in.
  pianoRollAutoReharmonize: false,
  confirmDestructive: true,
  // Plain wording and pop placement rules help a first-time composer get a
  // usable result quickly; explicit saved preferences still win on reload.
  explainLevel: 'beginner',
  loudnessTargetLufs: -14,
  streamingPlatforms: createDefaultStreamingPlatforms(),
  mixerHiddenTrackIds: [],
  guidanceProfile: DEFAULT_APP_GUIDANCE_PROFILE,
  pianoRollPlacementGuide: true,
  pianoRollGuidanceTint: true,
};

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asIntInRange(value: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clampInt(value, lo, hi, fallback);
}

function asMidiInputQuantizeDenominator(value: unknown, fallback: number): number {
  return typeof value === 'number' &&
    MIDI_INPUT_QUANTIZE_DENOMINATORS.includes(
      value as (typeof MIDI_INPUT_QUANTIZE_DENOMINATORS)[number],
    )
    ? value
    : fallback;
}

function asTheme(value: unknown, fallback: AppTheme): AppTheme {
  return value === 'system' || value === 'light' || value === 'dark' ? value : fallback;
}

function asLanguage(value: unknown, fallback: AppLanguage): AppLanguage {
  return value === 'system' || value === 'en' || value === 'ja' ? value : fallback;
}

function asNoteNameSystem(value: unknown, fallback: NoteNameSystem): NoteNameSystem {
  return NOTE_NAME_SYSTEMS.includes(value as NoteNameSystem) ? (value as NoteNameSystem) : fallback;
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

/** Preset ids stored by earlier versions, mapped to the core's current ids on load. */
const LEGACY_VOICE_PRESET_IDS: Readonly<Record<string, VoicePresetId>> = {
  'neutral-monitor': 'neutralMonitor',
  'bright-idol': 'brightIdol',
  'soft-whisper': 'softWhisper',
  'deep-narrator': 'deepNarrator',
  'robot-mascot': 'robotMascot',
  'dark-villain': 'darkVillain',
};

/** Exhaustive over the core's ids, so a new preset id is a compile error here. */
const VOICE_PRESET_IDS = {
  neutralMonitor: true,
  brightIdol: true,
  softWhisper: true,
  deepNarrator: true,
  robotMascot: true,
  darkVillain: true,
  hardTune: true,
  robotMonotone: true,
  choirHarmony: true,
  vocoderStrings: true,
  megaphone: true,
  radioVoice: true,
} as const satisfies Record<VoicePresetId, true>;

function asRecordingVoiceChangerPreset(
  value: unknown,
  fallback: RecordingVoiceChangerPreset,
): RecordingVoiceChangerPreset {
  if (value === 'off') return value;
  if (typeof value === 'string') {
    if (Object.hasOwn(VOICE_PRESET_IDS, value)) return value as VoicePresetId;
    if (Object.hasOwn(LEGACY_VOICE_PRESET_IDS, value)) return LEGACY_VOICE_PRESET_IDS[value];
  }
  // Custom presets are validated by the transport editor before being set;
  // preserve their JSON shape across a reload rather than silently disabling it.
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RealtimeVoiceChangerConfigInput)
    : fallback;
}

function asRecordingCaptureSource(
  value: unknown,
  fallback: RecordingCaptureSource,
): RecordingCaptureSource {
  return value === 'input' || value === 'output' ? value : fallback;
}

function asExplainLevel(value: unknown, fallback: ExplainLevel): ExplainLevel {
  return value === 'beginner' || value === 'normal' || value === 'theory' ? value : fallback;
}

function asGuidanceProfile(value: unknown, fallback: GuidanceProfile): GuidanceProfile {
  return value === 'counterpoint' || value === 'pop' ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asTrackIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<number>();
  for (const raw of value) {
    if (!Number.isInteger(raw) || raw < 0) continue;
    ids.add(raw);
    if (ids.size >= 256) break;
  }
  return [...ids];
}

/** Settings written by earlier versions name the platform ceiling `ceilingDb`. */
function upgradeStoredPlatform(raw: unknown): StreamingPlatform {
  if (typeof raw !== 'object' || raw === null) return raw as StreamingPlatform;
  const { ceilingDb, ...rest } = raw as Record<string, unknown>;
  return (
    ceilingDb !== undefined && !('ceilingDbtp' in rest) ? { ...rest, ceilingDbtp: ceilingDb } : raw
  ) as StreamingPlatform;
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
    noteNameSystem: asNoteNameSystem(source.noteNameSystem, defaults.noteNameSystem),
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
    midiInputQuantizeDenominator: asMidiInputQuantizeDenominator(
      source.midiInputQuantizeDenominator,
      defaults.midiInputQuantizeDenominator,
    ),
    monitorDefault: asBoolean(source.monitorDefault, defaults.monitorDefault),
    recordingVoiceChangerPreset: asRecordingVoiceChangerPreset(
      source.recordingVoiceChangerPreset,
      defaults.recordingVoiceChangerPreset,
    ),
    recordingRetuneSemitones: asIntInRange(
      source.recordingRetuneSemitones,
      STREAMING_RETUNE_MIN_SEMITONES,
      STREAMING_RETUNE_MAX_SEMITONES,
      defaults.recordingRetuneSemitones,
    ),
    recordingCaptureSource: asRecordingCaptureSource(
      source.recordingCaptureSource,
      defaults.recordingCaptureSource,
    ),
    recordingInputDeviceId: asString(
      source.recordingInputDeviceId,
      defaults.recordingInputDeviceId,
    ),
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
    pianoRollAutoReharmonize: asBoolean(
      source.pianoRollAutoReharmonize,
      defaults.pianoRollAutoReharmonize,
    ),
    confirmDestructive: asBoolean(source.confirmDestructive, defaults.confirmDestructive),
    explainLevel: asExplainLevel(source.explainLevel, defaults.explainLevel),
    loudnessTargetLufs: asIntInRange(
      source.loudnessTargetLufs,
      LOUDNESS_TARGET_MIN_LUFS,
      LOUDNESS_TARGET_MAX_LUFS,
      defaults.loudnessTargetLufs,
    ),
    streamingPlatforms: Array.isArray(source.streamingPlatforms)
      ? normalizeStreamingPlatforms(source.streamingPlatforms.map(upgradeStoredPlatform))
      : createDefaultStreamingPlatforms(),
    mixerHiddenTrackIds: asTrackIds(source.mixerHiddenTrackIds),
    guidanceProfile: asGuidanceProfile(source.guidanceProfile, defaults.guidanceProfile),
    pianoRollPlacementGuide: asBoolean(
      source.pianoRollPlacementGuide,
      defaults.pianoRollPlacementGuide,
    ),
    pianoRollGuidanceTint: asBoolean(source.pianoRollGuidanceTint, defaults.pianoRollGuidanceTint),
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
