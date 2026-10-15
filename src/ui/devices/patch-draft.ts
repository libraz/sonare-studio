/**
 * Patch-editor draft model for the NativeSynth wrapper patch (SynthPatch).
 *
 * The editor keeps a local draft the user mutates freely; Apply sanitizes it
 * back into a SynthPatch and commits a single undoable setTrackInstrument.
 * A field the patch omits keeps the base preset value and a field it carries
 * overrides it, explicit zeros included; an empty `modRoutings` array clears
 * the base mod matrix.
 */

import { clamp } from '@/lib/math';
import type { StoredSynthPatch, TrackInstrument } from '@/project/instrument';
import { getWasmModule } from '@/project/runtime';
import type { SynthModRouting, SynthParamCondition, SynthParamInfo } from '@/wasm/index.js';
import { FALLBACK_SYNTH_ENUMS } from './synth-enums';

/** Editor section a patch field renders under. */
export type PatchSection = 'osc' | 'filter' | 'amp' | 'filter-env' | 'lfo' | 'global';

/** Numeric StoredSynthPatch fields the editor exposes. */
export type NumericPatchField =
  | 'unison'
  | 'detuneCents'
  | 'driftCents'
  | 'driftRateHz'
  | 'drive'
  | 'stereoSpread'
  | 'cutoffHz'
  | 'resonanceQ'
  | 'keyTrack'
  | 'envToCutoffCents'
  | 'velToCutoffCents'
  | 'ampDelayMs'
  | 'ampAttackMs'
  | 'ampHoldMs'
  | 'ampDecayMs'
  | 'ampSustain'
  | 'ampReleaseMs'
  | 'filterDelayMs'
  | 'filterAttackMs'
  | 'filterHoldMs'
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
  {
    id: 'driftRateHz',
    labelKey: 'driftRateHz',
    label: 'Drift Rate',
    section: 'osc',
    min: 0.01,
    max: 20,
    step: 0.01,
    unit: 'Hz',
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
    min: 0.5,
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
    id: 'ampDelayMs',
    labelKey: 'ampDelayMs',
    label: 'Delay',
    section: 'amp',
    min: 0,
    max: 5000,
    step: 1,
    unit: 'ms',
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
    id: 'ampHoldMs',
    labelKey: 'ampHoldMs',
    label: 'Hold',
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
    min: 1,
    max: 5000,
    step: 1,
    unit: 'ms',
  },
  {
    id: 'filterDelayMs',
    labelKey: 'filterDelayMs',
    label: 'Delay',
    section: 'filter-env',
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
    id: 'filterHoldMs',
    labelKey: 'filterHoldMs',
    label: 'Hold',
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
    min: 1,
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
  const clamped = clamp(raw, spec.min, spec.max);
  return spec.integer ? Math.round(clamped) : clamped;
}

// --- Engine model params -----------------------------------------------------

/** Lists the model fields an engine mode accepts (empty for modes without a section). */
export type EngineParamInfoResolver = (
  engineMode: StoredSynthPatch['engineMode'],
) => SynthParamInfo[];

/** Descriptor source backed by the loaded wasm; empty before init or on an unknown mode. */
export const wasmEngineParamInfo: EngineParamInfoResolver = (engineMode) => {
  if (engineMode === undefined) return [];
  try {
    return getWasmModule().synthEngineParamInfo(engineMode);
  } catch {
    return [];
  }
};

/** Keeps the finite numeric entries of a raw engine-params record. */
function finiteEngineParams(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** A descriptor's base value in the patch's numeric form: a switch as 0/1. */
export function engineParamDefault(info: SynthParamInfo): number {
  return typeof info.default === 'boolean' ? Number(info.default) : info.default;
}

/** The value a condition reads: a set key, else its base (engine keys) or patch default. */
function conditionSubject(
  condition: SynthParamCondition,
  patch: StoredSynthPatch,
  engineInfo: ReadonlyArray<SynthParamInfo>,
  patchInfo: ReadonlyArray<SynthParamInfo>,
): unknown {
  if (condition.scope === 'engine') {
    const set = patch.engineParams?.[condition.key];
    if (set !== undefined) return set;
    const info = engineInfo.find((entry) => entry.name === condition.key);
    return info ? engineParamDefault(info) : undefined;
  }
  const set = (patch as Record<string, unknown>)[condition.key];
  if (set !== undefined) return set;
  return patchInfo.find((entry) => entry.name === condition.key)?.default;
}

function conditionHolds(condition: SynthParamCondition, subject: unknown): boolean {
  if (typeof condition.value === 'string') {
    return condition.relation === 'ne' ? subject !== condition.value : subject === condition.value;
  }
  if (typeof subject !== 'number' && typeof subject !== 'boolean') return false;
  const left = Number(subject);
  const right = Number(condition.value);
  switch (condition.relation) {
    case 'eq':
      return left === right;
    case 'ne':
      return left !== right;
    case 'gt':
      return left > right;
    case 'ge':
      return left >= right;
    case 'lt':
      return left < right;
    case 'le':
      return left <= right;
  }
}

/**
 * The conditions keeping an engine field from reaching the voice, or null when
 * it reaches it. Of several alternatives, the one closest to holding is named.
 */
export function engineParamBlockers(
  info: SynthParamInfo,
  patch: StoredSynthPatch,
  engineInfo: ReadonlyArray<SynthParamInfo>,
  patchInfo: ReadonlyArray<SynthParamInfo>,
): SynthParamCondition[] | null {
  if (info.activeWhen === undefined) return null;
  let closest: SynthParamCondition[] | null = null;
  for (const alternative of info.activeWhen) {
    const failing = alternative.filter(
      (condition) =>
        !conditionHolds(condition, conditionSubject(condition, patch, engineInfo, patchInfo)),
    );
    if (failing.length === 0) return null;
    if (closest === null || failing.length < closest.length) closest = failing;
  }
  return closest;
}

/** Patch-level field descriptors from the loaded wasm; empty before init. */
export function wasmPatchParamInfo(): SynthParamInfo[] {
  try {
    return getWasmModule().synthPatchParamInfo();
  } catch {
    return [];
  }
}

/** Clamps one value to a descriptor: booleans to 0/1, integers rounded, closed ranges enforced. */
export function clampEngineParam(info: SynthParamInfo, value: number): number {
  if (info.type === 'boolean') return value !== 0 ? 1 : 0;
  let next = value;
  if (info.min !== undefined) next = Math.max(info.min, next);
  if (info.max !== undefined) next = Math.min(info.max, next);
  return info.integer ? Math.round(next) : next;
}

/**
 * Reduces engine params to what an engine lists: unknown keys and non-finite
 * values are dropped, the rest clamped, so the library never refuses the patch.
 */
export function clampEngineParams(
  raw: unknown,
  info: ReadonlyArray<SynthParamInfo>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const byName = new Map(info.map((entry) => [entry.name, entry]));
  for (const [key, value] of Object.entries(finiteEngineParams(raw))) {
    const entry = byName.get(key);
    if (entry) out[key] = clampEngineParam(entry, value);
  }
  return out;
}

/**
 * Readable caption for an engine key: camelCase words split, digits detached,
 * dotted segments joined with a middle dot (`ranks2.level` -> "Ranks 2 · Level").
 */
export function humanizeEngineParamName(name: string): string {
  return name
    .split('.')
    .map((part) =>
      part
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Za-z])(\d)/g, '$1 $2')
        .replace(/^./, (c) => c.toUpperCase()),
    )
    .join(' \u00b7 ');
}

/** Slider step for an engine field: whole numbers when integer, else a decade of the range / 200. */
export function engineParamStep(info: SynthParamInfo): number {
  if (info.integer || info.type === 'boolean') return 1;
  const span = (info.max ?? 1) - (info.min ?? 0);
  if (!(span > 0)) return 0.01;
  return 10 ** Math.floor(Math.log10(span / 200));
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
      depth: clamp(row.depth, MOD_DEPTH_MIN, MOD_DEPTH_MAX),
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
  if (typeof source.oneShot === 'boolean') target.oneShot = source.oneShot;
  if (source.engineParams) {
    const params = finiteEngineParams(source.engineParams);
    if (Object.keys(params).length > 0) target.engineParams = { ...target.engineParams, ...params };
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
 * binding-internal fields (destinationId) are never emitted. Engine params
 * are reduced to the keys the patch's engine lists, clamped to the descriptor.
 *
 * @param draft Editor draft (not mutated).
 * @param engineInfo Engine descriptor source (the loaded wasm by default).
 * @returns A clean patch.
 */
export function sanitizePatchDraft(
  draft: StoredSynthPatch,
  engineInfo: EngineParamInfoResolver = wasmEngineParamInfo,
): StoredSynthPatch {
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
  if (typeof draft.oneShot === 'boolean') out.oneShot = draft.oneShot;
  const engineParams = clampEngineParams(draft.engineParams, engineInfo(out.engineMode));
  if (Object.keys(engineParams).length > 0) out.engineParams = engineParams;
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
  if (typeof patch.oneShot === 'boolean') count += 1;
  count += Object.keys(patch.engineParams ?? {}).length;
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
 * Computes the DAHDSR polyline of the mini envelope display.
 *
 * The sustain plateau takes a fixed quarter of the width; the timed stages
 * split the rest proportionally to their times (each at least one pixel so
 * degenerate envelopes stay visible). y = 0 is full level, y = height is
 * silence. Delay and hold add points only when non-zero.
 *
 * @param attackMs Attack time (>= 0).
 * @param decayMs Decay time (>= 0).
 * @param sustain Sustain level in [0, 1].
 * @param releaseMs Release time (>= 0).
 * @param width Canvas width in px (> 0).
 * @param height Canvas height in px (> 0).
 * @param delayMs Delay before the attack (>= 0).
 * @param holdMs Hold at the peak (>= 0).
 * @returns Start, [delay end], attack peak, [hold end], decay end, sustain end, release end.
 */
export function adsrEnvelopePoints(
  attackMs: number,
  decayMs: number,
  sustain: number,
  releaseMs: number,
  width: number,
  height: number,
  delayMs = 0,
  holdMs = 0,
): EnvelopePoint[] {
  const time = (ms: number) => Math.max(0, Number.isFinite(ms) ? ms : 0);
  const dl = time(delayMs);
  const a = time(attackMs);
  const h = time(holdMs);
  const d = time(decayMs);
  const r = time(releaseMs);
  const s = clamp(Number.isFinite(sustain) ? sustain : 0, 0, 1);
  const sustainWidth = width * SUSTAIN_WIDTH_FRACTION;
  const segmentWidth = width - sustainWidth;
  const total = dl + a + h + d + r;
  const share = (ms: number) => (total > 0 ? (ms / total) * segmentWidth : segmentWidth / 3);
  const sustainY = height * (1 - s);
  const points: EnvelopePoint[] = [{ x: 0, y: height }];
  let x = 0;
  if (dl > 0) {
    x += Math.max(1, share(dl));
    points.push({ x, y: height });
  }
  x += Math.max(1, share(a));
  points.push({ x, y: 0 });
  if (h > 0) {
    x += Math.max(1, share(h));
    points.push({ x, y: 0 });
  }
  x += Math.max(1, share(d));
  points.push({ x, y: sustainY });
  points.push({ x: x + sustainWidth, y: sustainY });
  points.push({ x: width, y: height });
  return points;
}
