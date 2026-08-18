/**
 * Expression maps: turning score articulations into what a sampler listens to.
 *
 * The score's articulation marks are display annotations — they never rewrite
 * stored notes. An expression map says what each mark should send: a key
 * switch, a controller value, or both. The injection happens while the MIDI
 * schedule is built (see src/engine/midi-sync.ts), so the mapping stays
 * non-destructive and can be changed or removed at any time.
 *
 * Pure data module: no store, no engine, no history.
 */

import type { NoteArticulation } from './annotations';
import { NOTE_ARTICULATIONS } from './annotations';

/** What one articulation sends before the note it marks. */
export interface ExpressionMapEntry {
  /** Articulation this entry reacts to. */
  articulation: NoteArticulation;
  /** Key-switch pitch played just before the note (0-127); absent = none. */
  keySwitch?: number;
  /** Controller number sent just before the note (0-127); absent = none. */
  controller?: number;
  /** Value for {@link controller} (0-127); defaults to 127. */
  value?: number;
}

/** Per-track articulation map (app-level metadata). */
export interface TrackExpressionMap {
  /** One entry per articulation; articulations without an entry send nothing. */
  entries: ExpressionMapEntry[];
}

/** Velocity used for key switches: audible to the sampler, silent musically. */
export const KEY_SWITCH_VELOCITY = 1;

/** Lowest key switch of the preset bank (C1), below any playable range. */
const FIRST_KEY_SWITCH = 24;

/** Controller the second preset selects articulations on. */
const ARTICULATION_SELECT_CONTROLLER = 32;

/** True when a map would send nothing at all. */
export function isExpressionMapEmpty(map: TrackExpressionMap | undefined): boolean {
  return (
    map === undefined ||
    map.entries.every((entry) => entry.keySwitch === undefined && entry.controller === undefined)
  );
}

function clampByte(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > 127) return undefined;
  return rounded;
}

/**
 * Normalizes a persisted or hand-edited map: unknown articulations, duplicate
 * entries and out-of-range bytes are dropped, and an entry that would send
 * nothing is removed.
 *
 * @param raw Untrusted map value (document field or editor draft).
 * @returns A sanitized map, or undefined when nothing usable remains.
 */
export function sanitizeExpressionMap(raw: unknown): TrackExpressionMap | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const entriesRaw = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entriesRaw)) return undefined;
  const seen = new Set<NoteArticulation>();
  const entries: ExpressionMapEntry[] = [];
  for (const candidate of entriesRaw) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const source = candidate as Record<string, unknown>;
    const articulation = source.articulation as NoteArticulation;
    if (!NOTE_ARTICULATIONS.includes(articulation) || seen.has(articulation)) continue;
    const keySwitch = clampByte(source.keySwitch);
    const controller = clampByte(source.controller);
    if (keySwitch === undefined && controller === undefined) continue;
    const value = clampByte(source.value);
    seen.add(articulation);
    entries.push({
      articulation,
      ...(keySwitch === undefined ? {} : { keySwitch }),
      ...(controller === undefined ? {} : { controller, value: value ?? 127 }),
    });
  }
  if (entries.length === 0) return undefined;
  return { entries };
}

/** Ids of the built-in maps; the UI labels are keyed by these. */
export type ExpressionMapPresetId = 'keySwitchesC1' | 'controller32';

/** A named starting point offered in the UI. */
export interface ExpressionMapPreset {
  /** Stable id used by the menu and by tests. */
  id: ExpressionMapPresetId;
  /** The map this preset installs. */
  map: TrackExpressionMap;
}

/**
 * Ready-made maps for the two conventions sample libraries actually use: a
 * bank of key switches below the playable range, and one articulation-select
 * controller. Both cover every articulation the score can mark, in the order
 * {@link NOTE_ARTICULATIONS} declares, so a mark added to the vocabulary is
 * audible without hand-editing a map; a project file can carry any other
 * combination the model allows.
 */
export const EXPRESSION_MAP_PRESETS: ReadonlyArray<ExpressionMapPreset> = [
  {
    id: 'keySwitchesC1',
    map: {
      entries: NOTE_ARTICULATIONS.map((articulation, index) => ({
        articulation,
        keySwitch: FIRST_KEY_SWITCH + index,
      })),
    },
  },
  {
    id: 'controller32',
    map: {
      entries: NOTE_ARTICULATIONS.map((articulation, index) => ({
        articulation,
        controller: ARTICULATION_SELECT_CONTROLLER,
        value: index + 1,
      })),
    },
  },
];

/** The preset a map matches exactly, or undefined for a custom/absent map. */
export function matchingExpressionMapPreset(
  map: TrackExpressionMap | undefined,
): ExpressionMapPreset | undefined {
  if (map === undefined) return undefined;
  const key = JSON.stringify(map.entries);
  return EXPRESSION_MAP_PRESETS.find((preset) => JSON.stringify(preset.map.entries) === key);
}

/** The entry governing an articulation, or undefined when it sends nothing. */
export function expressionMapEntryFor(
  map: TrackExpressionMap | undefined,
  articulation: NoteArticulation | undefined,
): ExpressionMapEntry | undefined {
  if (map === undefined || articulation === undefined) return undefined;
  return map.entries.find((entry) => entry.articulation === articulation);
}
