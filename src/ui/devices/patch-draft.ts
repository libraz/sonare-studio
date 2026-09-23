/**
 * Patch-editor draft model for the NativeSynth wrapper patch (SynthPatch).
 *
 * The editor keeps a local draft the user mutates freely; Apply sanitizes it
 * back into a SynthPatch and commits a single undoable setTrackInstrument.
 * A field the patch omits keeps the base preset value and a field it carries
 * overrides it, explicit zeros included; an empty `modRoutings` array clears
 * the base mod matrix.
 */

import type { StoredSynthPatch, TrackInstrument } from '@/project/instrument';
import type { SynthModRouting } from '@/wasm/index.js';
import { FALLBACK_SYNTH_ENUMS } from './synth-enums';

/** Editor section a patch field renders under. */
export type PatchSection = 'osc' | 'filter' | 'amp' | 'filter-env' | 'lfo' | 'global';

/** Numeric StoredSynthPatch fields the editor exposes. */
export type NumericPatchField =
  | 'unison'
  | 'detuneCents'
  | 'driftCents'
  | 'drive'
  | 'stereoSpread'
  | 'cutoffHz'
  | 'resonanceQ'
  | 'keyTrack'
  | 'envToCutoffCents'
  | 'velToCutoffCents'
  | 'ampAttackMs'
  | 'ampDecayMs'
  | 'ampSustain'
  | 'ampReleaseMs'
  | 'filterAttackMs'
  | 'filterDecayMs'
  | 'filterSustain'
  | 'filterReleaseMs'
  | 'lfoRateHz'
  | 'lfoToPitchCents'
  | 'lfo2RateHz'
  | 'glideMs'
  | 'bodyMix'
  | 'gain'
  | 'polyphony'
  | 'busDrive'
  | 'pitchOffsetCents'
  | 'hpCutoffHz'
  | 'sampleHoldHz'
  | 'bitDepth';

/** Enum (string-valued) StoredSynthPatch fields the editor exposes. */
export type EnumPatchField =
  | 'engineMode'
  | 'waveform'
  | 'filterModel'
  | 'filterOutput'
  | 'body'
  | 'retrigger';

/** Spec of one numeric patch field (range, step, section placement). */
export interface PatchFieldSpec {
  id: NumericPatchField;
  /** i18n key for the display label (stable field id, independent of locale). */
  labelKey: NumericPatchField;
  /** English fallback label for non-component consumers. */
  label: string;
  /** Editor section the field renders under. */
  section: PatchSection;
  min: number;
  max: number;
  /** Slider step. */
  step: number;
  /** Display unit; omitted for unitless values. */
  unit?: string;
  /** True when the field only accepts integers (rounded on sanitize). */
  integer?: boolean;
}

/**
 * Numeric patch fields by editor section. Ranges follow the documented wrapper
 * semantics where declared ([0,1] amounts, unison [1,7], polyphony [1,64]) and
 * sensible UI bounds elsewhere.
 */
export const PATCH_FIELD_SPECS: ReadonlyArray<PatchFieldSpec> = [
  {
    id: 'unison',
    labelKey: 'unison',
    label: 'Unison',
    section: 'osc',
    min: 1,
    max: 7,
    step: 1,
    integer: true,
  },
  {
    id: 'detuneCents',
    labelKey: 'detuneCents',
    label: 'Detune',
    section: 'osc',
    min: 0,
    max: 200,
    step: 1,
    unit: 'ct',
  },
  {
    id: 'driftCents',
    labelKey: 'driftCents',
    label: 'Drift',
    section: 'osc',
    min: 0,
    max: 100,
    step: 1,
    unit: 'ct',
  },
  { id: 'drive', labelKey: 'drive', label: 'Drive', section: 'osc', min: 0, max: 1, step: 0.01 },
  {
    id: 'stereoSpread',
    labelKey: 'stereoSpread',
    label: 'Spread',
    section: 'osc',
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    id: 'pitchOffsetCents',
    labelKey: 'pitchOffsetCents',
    label: 'Pitch Offset',
    section: 'osc',
    min: -1200,
    max: 1200,
    step: 1,
    unit: 'ct',
  },
  {
    id: 'cutoffHz',
    labelKey: 'cutoffHz',
    label: 'Cutoff',
    section: 'filter',
    min: 20,
    max: 20000,
    step: 1,
    unit: 'Hz',
  },
  {
    id: 'resonanceQ',
    labelKey: 'resonanceQ',
    label: 'Resonance',
    section: 'filter',
    min: 0.1,
    max: 20,
    step: 0.1,
  },
  {
    id: 'hpCutoffHz',
    labelKey: 'hpCutoffHz',
    label: 'High-pass',
    section: 'filter',
    min: 0,
    max: 20000,
    step: 1,
    unit: 'Hz',
  },
  {
    id: 'keyTrack',
    labelKey: 'keyTrack',
    label: 'Key Track',
    section: 'filter',
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    id: 'envToCutoffCents',
    labelKey: 'envToCutoffCents',
    label: 'Env Amount',
    section: 'filter',
    min: -9600,
    max: 9600,
    step: 10,
    unit: 'ct',
  },
  {
    id: 'velToCutoffCents',
    labelKey: 'velToCutoffCents',
    label: 'Vel Amount',
    section: 'filter',
    min: -9600,
    max: 9600,
    step: 10,
    unit: 'ct',
  },
  {
    id: 'ampAttackMs',
    labelKey: 'ampAttackMs',
    label: 'Attack',
    section: 'amp',
    min: 0,
    max: 5000,
    step: 1,
    unit: 'ms',
  },
  {
    id: 'ampDecayMs',
    labelKey: 'ampDecayMs',
    label: 'Decay',
    section: 'amp',
    min: 0,
    max: 5000,
    step: 1,
    unit: 'ms',
  },
  {
    id: 'ampSustain',
    labelKey: 'ampSustain',
    label: 'Sustain',
    section: 'amp',
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    id: 'ampReleaseMs',
    labelKey: 'ampReleaseMs',
    label: 'Release',
    section: 'amp',
    min: 0,
    max: 5000,
    step: 1,
    unit: 'ms',
  },
  {
    id: 'filterAttackMs',
    labelKey: 'filterAttackMs',
    label: 'Attack',
    section: 'filter-env',
    min: 0,
    max: 5000,
    step: 1,
    unit: 'ms',
  },
  {
    id: 'filterDecayMs',
    labelKey: 'filterDecayMs',
    label: 'Decay',
    section: 'filter-env',
    min: 0,
    max: 5000,
    step: 1,
    unit: 'ms',
  },
  {
    id: 'filterSustain',
    labelKey: 'filterSustain',
    label: 'Sustain',
    section: 'filter-env',
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    id: 'filterReleaseMs',
    labelKey: 'filterReleaseMs',
    label: 'Release',
    section: 'filter-env',
    min: 0,
    max: 5000,
    step: 1,
    unit: 'ms',
  },
  {
    id: 'lfoRateHz',
    labelKey: 'lfoRateHz',
    label: 'LFO 1 Rate',
    section: 'lfo',
    min: 0,
    max: 20,
    step: 0.05,
    unit: 'Hz',
  },
  {
    id: 'lfoToPitchCents',
    labelKey: 'lfoToPitchCents',
    label: 'LFO 1 → Pitch',
    section: 'lfo',
    min: 0,
    max: 1200,
    step: 1,
    unit: 'ct',
  },
  {
    id: 'lfo2RateHz',
    labelKey: 'lfo2RateHz',
    label: 'LFO 2 Rate',
    section: 'lfo',
    min: 0,
    max: 20,
    step: 0.05,
    unit: 'Hz',
  },
  {
    id: 'glideMs',
    labelKey: 'glideMs',
    label: 'Glide',
    section: 'global',
    min: 0,
    max: 2000,
    step: 1,
    unit: 'ms',
  },
  {
    id: 'bodyMix',
    labelKey: 'bodyMix',
    label: 'Body Mix',
    section: 'global',
    min: 0,
    max: 1,
    step: 0.01,
  },
  { id: 'gain', labelKey: 'gain', label: 'Gain', section: 'global', min: 0, max: 2, step: 0.01 },
  {
    id: 'polyphony',
    labelKey: 'polyphony',
    label: 'Voices',
    section: 'global',
    min: 1,
    max: 64,
    step: 1,
    integer: true,
  },
  {
    id: 'busDrive',
    labelKey: 'busDrive',
    label: 'Bus Drive',
    section: 'global',
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    id: 'sampleHoldHz',
    labelKey: 'sampleHoldHz',
    label: 'Sample Rate',
    section: 'global',
    min: 0,
    max: 48000,
    step: 1,
    unit: 'Hz',
  },
  {
    id: 'bitDepth',
    labelKey: 'bitDepth',
    label: 'Bit Depth',
    section: 'global',
    min: 0,
    max: 24,
    step: 0.1,
    unit: 'bit',
  },
];

/**
 * Epsilons a project may carry in place of an explicit zero, from when the
 * patch ABI read a literal 0 as "keep the base preset value". Reading maps them
 * back to the zero the user asked for; nothing writes them any more.
 */
const LEGACY_ZERO_AMOUNT = 0.0001;
const LEGACY_ZERO_TIME_OR_CENTS = 0.001;

/** Maps the epsilon such a project stored for a field back to zero. */
export function decodePatchFieldValue(id: NumericPatchField, value: number): number {
  const spec = patchFieldSpec(id);
  // Fields whose range excludes zero were never epsilon-encoded.
  if ((spec?.min ?? 0) > 0) return value;
  const epsilon =
    spec?.unit === 'ct' || spec?.unit === 'ms' ? LEGACY_ZERO_TIME_OR_CENTS : LEGACY_ZERO_AMOUNT;
  return value > 0 && value <= epsilon ? 0 : value;
}

/** Returns the numeric field specs of one editor section, in display order. */
export function patchFieldsForSection(section: PatchSection): PatchFieldSpec[] {
  return PATCH_FIELD_SPECS.filter((spec) => spec.section === section);
}

/** Returns the spec of a numeric patch field, or null for unknown ids. */
export function patchFieldSpec(id: string): PatchFieldSpec | null {
  return PATCH_FIELD_SPECS.find((spec) => spec.id === id) ?? null;
}

/**
 * Clamps a numeric patch field to its spec range. Zero is an ordinary override
 * the patch carries like any other value; non-finite input degrades to the
 * in-range value nearest zero.
 *
 * @param id Numeric patch field id.
 * @param value Raw value from the editor.
 * @returns The clamped value (integer fields rounded).
 */
export function clampPatchField(id: NumericPatchField, value: number): number {
  const raw = Number.isFinite(value) ? value : 0;
  const spec = patchFieldSpec(id);
  if (!spec) return raw;
  const clamped = Math.min(spec.max, Math.max(spec.min, raw));
  return spec.integer ? Math.round(clamped) : clamped;
}

// --- Mod matrix --------------------------------------------------------------

/** One editable mod-matrix row (string-valued source/destination). */
export interface ModMatrixRow {
  source: string;
  destination: string;
  /** Normalized modulation depth in [-1, 1]. */
  depth: number;
}

/** Maximum number of mod routings the patch ABI carries. */
export const MAX_MOD_ROUTINGS = 8;

/** Mod depth bounds (normalized amount). */
export const MOD_DEPTH_MIN = -1;
export const MOD_DEPTH_MAX = 1;

/** Resolves a numeric mod enum ordinal to its name via a table. */
function modEnumName(value: string | number, table: ReadonlyArray<string>): string {
  if (typeof value === 'string') return value;
  return table[value] ?? 'none';
}

/** Builds a fresh inert mod-matrix row. */
export function createModMatrixRow(): ModMatrixRow {
  return { source: 'none', destination: 'none', depth: 0 };
}

/**
 * Converts a patch's mod routings to editable rows (numeric enum ordinals are
 * resolved to names via the published tables).
 *
 * @param patch Patch holding the routings (possibly none).
 * @returns Editable rows (empty when the patch defines none).
 */
export function modMatrixRows(patch: StoredSynthPatch): ModMatrixRow[] {
  const routings = patch.modRoutings ?? [];
  return routings.map((routing) => ({
    source: modEnumName(routing.source, FALLBACK_SYNTH_ENUMS.modSources),
    destination: modEnumName(routing.destination, FALLBACK_SYNTH_ENUMS.modDestinations),
    depth: Number.isFinite(routing.depth) ? routing.depth : 0,
  }));
}

/**
 * Converts editor rows back into patch routings: inert rows (source or
 * destination 'none', or zero depth) are dropped, depths are clamped to
 * [-1, 1], and the list is capped at {@link MAX_MOD_ROUTINGS}.
 *
 * @param rows Editor rows.
 * @returns Routings ready for StoredSynthPatch.modRoutings.
 */
export function modRowsToRoutings(rows: ReadonlyArray<ModMatrixRow>): SynthModRouting[] {
  const routings: SynthModRouting[] = [];
  for (const row of rows) {
    if (row.source === 'none' || row.destination === 'none') continue;
    if (!Number.isFinite(row.depth) || row.depth === 0) continue;
    routings.push({
      source: row.source as SynthModRouting['source'],
      destination: row.destination as SynthModRouting['destination'],
      depth: Math.min(MOD_DEPTH_MAX, Math.max(MOD_DEPTH_MIN, row.depth)),
    });
    if (routings.length === MAX_MOD_ROUTINGS) break;
  }
  return routings;
}

// --- Draft construction / sanitizing -----------------------------------------

/** Resolves a preset name to its patch values (null when unknown). */
export type PresetPatchResolver = (preset: string) => StoredSynthPatch | null;

/** Enum patch fields copied between base patches and drafts. */
const ENUM_PATCH_FIELDS: ReadonlyArray<EnumPatchField> = [
  'engineMode',
  'waveform',
  'filterModel',
  'filterOutput',
  'body',
  'retrigger',
];

/** Copies the editable fields of a source patch onto a target draft. */
function copyPatchFields(target: StoredSynthPatch, source: StoredSynthPatch): void {
  const record = source as Record<string, unknown>;
  for (const spec of PATCH_FIELD_SPECS) {
    const value = record[spec.id];
    if (typeof value === 'number' && Number.isFinite(value)) {
      (target as Record<string, unknown>)[spec.id] = decodePatchFieldValue(spec.id, value);
    }
  }
  for (const field of ENUM_PATCH_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value !== '' && value !== 'default') {
      (target as Record<string, unknown>)[field] = value;
    }
  }
  if (source.useGmPrograms === true) target.useGmPrograms = true;
  if (Array.isArray(source.modRoutings) && source.modRoutings.length > 0) {
    target.modRoutings = source.modRoutings.map((routing) => ({ ...routing }));
  }
}

/**
 * Builds the editor draft for a track instrument.
 *
 * Synth presets become `{ preset }` plus the preset's resolvable base values
 * (so sliders start at audible positions instead of sentinels); synth patches
 * keep their explicit fields layered over the base; SF2 instruments (and
 * missing instruments) start from an init subtractive patch.
 *
 * @param instrument The track's instrument (null/undefined = default).
 * @param resolvePreset Optional preset catalog resolver (wasm synthPresetPatch).
 * @returns A fresh draft the editor may mutate freely.
 */
export function createPatchDraft(
  instrument: TrackInstrument | null | undefined,
  resolvePreset?: PresetPatchResolver,
): StoredSynthPatch {
  const draft: StoredSynthPatch = {};
  if (!instrument || instrument.kind === 'sf2' || instrument.kind === 'external-midi') return draft;
  const presetName =
    instrument.kind === 'synth-preset' ? instrument.preset : instrument.patch.preset;
  if (presetName !== undefined && resolvePreset) {
    let base: StoredSynthPatch | null = null;
    try {
      base = resolvePreset(presetName);
    } catch {
      base = null;
    }
    if (base) copyPatchFields(draft, base);
  }
  if (instrument.kind === 'synth-patch') copyPatchFields(draft, instrument.patch);
  if (presetName !== undefined) draft.preset = presetName;
  return draft;
}

/**
 * Sanitizes a draft into a StoredSynthPatch ready to commit: numeric fields are
 * clamped to their spec ranges (non-finite values are dropped), enum fields are
 * kept as strings, mod routings are filtered/clamped/capped, and
 * binding-internal fields (destinationId) are never emitted.
 *
 * @param draft Editor draft (not mutated).
 * @returns A clean patch.
 */
export function sanitizePatchDraft(draft: StoredSynthPatch): StoredSynthPatch {
  const out: StoredSynthPatch = {};
  if (typeof draft.preset === 'string' && draft.preset.length > 0) out.preset = draft.preset;
  const record = draft as Record<string, unknown>;
  for (const spec of PATCH_FIELD_SPECS) {
    const value = record[spec.id];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    (out as Record<string, unknown>)[spec.id] = clampPatchField(spec.id, value);
  }
  for (const field of ENUM_PATCH_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value !== '' && value !== 'default') {
      (out as Record<string, unknown>)[field] = value;
    }
  }
  // Emitted only when on, so an untouched patch stays byte-identical.
  if (draft.useGmPrograms === true) out.useGmPrograms = true;
  // An empty array clears the base mod matrix; omitting the key would keep it.
  if (Array.isArray(draft.modRoutings)) out.modRoutings = modRowsToRoutings(modMatrixRows(draft));
  return out;
}

/** Counts the explicitly set fields of a patch (preset excluded). */
export function patchEditCount(patch: StoredSynthPatch): number {
  const record = patch as Record<string, unknown>;
  let count = 0;
  for (const spec of PATCH_FIELD_SPECS) {
    const value = record[spec.id];
    if (typeof value === 'number' && Number.isFinite(value)) count += 1;
  }
  for (const field of ENUM_PATCH_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value !== '' && value !== 'default') count += 1;
  }
  if (patch.useGmPrograms === true) count += 1;
  // Any routing list is an edit — an empty one clears the base mod matrix.
  if (Array.isArray(patch.modRoutings)) count += 1;
  return count;
}

// --- Envelope geometry --------------------------------------------------------

/** One point of the mini envelope polyline (canvas pixel space). */
export interface EnvelopePoint {
  x: number;
  y: number;
}

/** Width fraction reserved for the sustain plateau of the mini envelope. */
const SUSTAIN_WIDTH_FRACTION = 0.25;

/**
 * Computes the ADSR polyline of the mini envelope display.
 *
 * The sustain plateau takes a fixed quarter of the width; attack, decay and
 * release split the rest proportionally to their times (each at least one
 * pixel so degenerate envelopes stay visible). y = 0 is full level, y =
 * height is silence.
 *
 * @param attackMs Attack time (>= 0).
 * @param decayMs Decay time (>= 0).
 * @param sustain Sustain level in [0, 1].
 * @param releaseMs Release time (>= 0).
 * @param width Canvas width in px (> 0).
 * @param height Canvas height in px (> 0).
 * @returns Five points: start, attack peak, decay end, sustain end, release end.
 */
export function adsrEnvelopePoints(
  attackMs: number,
  decayMs: number,
  sustain: number,
  releaseMs: number,
  width: number,
  height: number,
): EnvelopePoint[] {
  const a = Math.max(0, Number.isFinite(attackMs) ? attackMs : 0);
  const d = Math.max(0, Number.isFinite(decayMs) ? decayMs : 0);
  const r = Math.max(0, Number.isFinite(releaseMs) ? releaseMs : 0);
  const s = Math.min(1, Math.max(0, Number.isFinite(sustain) ? sustain : 0));
  const sustainWidth = width * SUSTAIN_WIDTH_FRACTION;
  const segmentWidth = width - sustainWidth;
  const total = a + d + r;
  const ax = total > 0 ? (a / total) * segmentWidth : segmentWidth / 3;
  const dx = total > 0 ? (d / total) * segmentWidth : segmentWidth / 3;
  const sustainY = height * (1 - s);
  const x1 = Math.max(1, ax);
  const x2 = x1 + Math.max(1, dx);
  const x3 = x2 + sustainWidth;
  return [
    { x: 0, y: height },
    { x: x1, y: 0 },
    { x: x2, y: sustainY },
    { x: x3, y: sustainY },
    { x: width, y: height },
  ];
}
