/**
 * Quick Controls: maps an instrument or insert slot onto its primary
 * parameters as flat { id, name, value, min, max, unit? } descriptors, for a
 * device-rack UI to render as knobs.
 *
 * Listing is pure over the store mirror (with injectable resolvers for the
 * wasm preset/param catalogs); setting routes through the undoable command
 * layer with gesture coalescing, so a continuous knob drag lands as one
 * history entry (pass commit: false while dragging, then a final committing
 * call).
 */

import { decodePatchFieldValue, type NumericPatchField } from '@/ui/devices/patch-draft';
import { FALLBACK_SYNTH_ENUMS, resolveSynthEnums } from '@/ui/devices/synth-enums';
import type { SynthEnumTables } from '@/wasm/index.js';
import {
  type CommandGestureOptions,
  isMixerBusStripTarget,
  type MixerStripTarget,
  mixerBusIdFromTarget,
  setInsertParam,
  setTrackInstrument,
} from './commands';
import { INSERT_PARAM_DOMAIN_FALLBACK, insertParamDomain } from './insert-param-domains';
import { type StoredSynthPatch, trackInstrument } from './instrument';
import type { InsertSlot, MixerStrip } from './mixer';
import {
  type ProcessorControl,
  type ProcessorControlValue,
  type ProcessorEnumOption,
  processorControl,
  processorControls,
  processorNumberSpec,
  validateProcessorControlValue,
} from './processor-controls';
import { getWasmModule, useProjectStore } from './store';

/** One quick-control descriptor (knob, toggle, or enum menu). */
export type QuickControl = ProcessorControl;

/** Addresses what a quick-control rack edits. */
export type QuickControlTarget =
  | { type: 'instrument'; trackId: number }
  | { type: 'insert'; trackId: MixerStripTarget; index: number };

/** Injectable catalog resolvers (default to the loaded wasm module). */
export interface QuickControlResolvers {
  /** Resolves a synth preset to its patch values; null when unknown. */
  resolvePresetPatch?: (preset: string) => StoredSynthPatch | null;
  /** Resolves an insert processor name to its parameter names. */
  resolveInsertParams?: (processor: string) => string[];
  /** Resolves engine-provided parameter metadata, including an optional unit. */
  resolveInsertParamInfo?: (processor: string) => QuickControlParamInfo[];
}

/** Minimal engine parameter metadata needed by the quick-control UI. */
export interface QuickControlParamInfo {
  /** JSON-key parameter name. */
  name: string;
  /** Engine-provided physical unit, when it declares one. */
  unit?: string;
  /** Engine-provided value kind, when available. */
  type?: 'number' | 'boolean' | 'enum';
}

/** One entry of the NativeSynth quick-control table. */
interface SynthControlSpec {
  id: keyof StoredSynthPatch & string;
  name: string;
  min: number;
  max: number;
  scale?: 'linear' | 'log';
  unit?: string;
  /** Value shown when neither patch nor preset defines the field. */
  fallback: number;
}

interface SynthEnumControlSpec {
  id: 'engineMode' | 'waveform' | 'filterModel' | 'filterOutput' | 'body';
  name: string;
  table: keyof Pick<
    SynthEnumTables,
    'engineModes' | 'waveforms' | 'filterModels' | 'filterOutputs' | 'bodyTypes'
  >;
}

/**
 * Primary NativeSynth patch fields exposed as quick controls. The frozen
 * patch ABI treats numeric 0/omitted as "keep the base value", so unset
 * fields display the preset's value (when resolvable) or the documented
 * engine default.
 */
const SYNTH_QUICK_CONTROLS: ReadonlyArray<SynthControlSpec> = [
  {
    id: 'cutoffHz',
    name: 'Cutoff',
    min: 20,
    max: 20000,
    scale: 'log',
    unit: 'Hz',
    fallback: 18000,
  },
  {
    id: 'resonanceQ',
    name: 'Resonance',
    min: 0.1,
    max: 20,
    scale: 'log',
    fallback: Math.SQRT1_2,
  },
  { id: 'drive', name: 'Drive', min: 0, max: 1, fallback: 0 },
  { id: 'ampAttackMs', name: 'Attack', min: 0, max: 5000, unit: 'ms', fallback: 5 },
  { id: 'ampDecayMs', name: 'Decay', min: 0, max: 5000, unit: 'ms', fallback: 60 },
  { id: 'ampSustain', name: 'Sustain', min: 0, max: 1, fallback: 0.7 },
  { id: 'ampReleaseMs', name: 'Release', min: 0, max: 5000, unit: 'ms', fallback: 120 },
  { id: 'gain', name: 'Gain', min: 0, max: 2, fallback: 1 },
];

/** Amp/body-oriented controls for plucked-string presets such as guitar/bass. */
const PLUCKED_STRING_QUICK_CONTROLS: ReadonlyArray<SynthControlSpec> = [
  { id: 'drive', name: 'Pre Drive', min: 0, max: 1, fallback: 0 },
  { id: 'bodyMix', name: 'Body', min: 0, max: 1, fallback: 0.35 },
  { id: 'busDrive', name: 'Amp Drive', min: 0, max: 1, fallback: 0 },
  { id: 'gain', name: 'Output', min: 0, max: 2, fallback: 1 },
  {
    id: 'cutoffHz',
    name: 'Tone',
    min: 20,
    max: 20000,
    scale: 'log',
    unit: 'Hz',
    fallback: 18000,
  },
  {
    id: 'resonanceQ',
    name: 'Cab Q',
    min: 0.1,
    max: 20,
    scale: 'log',
    fallback: Math.SQRT1_2,
  },
  { id: 'ampAttackMs', name: 'Pick', min: 0, max: 5000, unit: 'ms', fallback: 5 },
  { id: 'ampReleaseMs', name: 'Damp', min: 0, max: 5000, unit: 'ms', fallback: 120 },
];

/** NativeSynth enum fields exposed after the stable numeric quick controls. */
const SYNTH_ENUM_CONTROLS: ReadonlyArray<SynthEnumControlSpec> = [
  { id: 'engineMode', name: 'Engine', table: 'engineModes' },
  { id: 'waveform', name: 'Waveform', table: 'waveforms' },
  { id: 'filterModel', name: 'Filter Model', table: 'filterModels' },
  { id: 'filterOutput', name: 'Filter Output', table: 'filterOutputs' },
  { id: 'body', name: 'Body', table: 'bodyTypes' },
];

const WIND_OR_BRASS_PRESET_TOKENS = [
  'bassoon',
  'clarinet',
  'flute',
  'horn',
  'oboe',
  'reed',
  'sax',
  'trumpet',
  'trombone',
  'tuba',
];

function isPluckedStringPreset(
  presetName: string | undefined,
  basePatch: StoredSynthPatch | null,
): boolean {
  const lower = presetName?.toLowerCase() ?? '';
  if (WIND_OR_BRASS_PRESET_TOKENS.some((token) => lower.includes(token))) return false;
  if (
    lower.includes('guitar') ||
    lower.includes('bass') ||
    lower.includes('harp') ||
    lower.includes('pluck')
  ) {
    return true;
  }
  const mode = basePatch?.engineMode;
  return mode === 'karplus-strong' || mode === 3 || basePatch?.body === 'guitar';
}

/** Resolves the runtime NativeSynth enum tables, retaining complete fallbacks. */
function defaultResolveSynthEnums(): SynthEnumTables {
  try {
    const wasm = getWasmModule() as unknown as {
      synthEnumTables?: () => Partial<SynthEnumTables>;
    };
    return resolveSynthEnums(
      typeof wasm.synthEnumTables === 'function' ? wasm.synthEnumTables() : null,
    );
  } catch {
    return resolveSynthEnums(FALLBACK_SYNTH_ENUMS);
  }
}

/** Returns a patch enum value, with numeric ordinals resolved to labels. */
function patchEnumValue(
  patch: StoredSynthPatch | null,
  spec: SynthEnumControlSpec,
  options: ReadonlyArray<ProcessorEnumOption>,
): string | number | null {
  if (!patch) return null;
  const raw = (patch as Record<string, unknown>)[spec.id];
  if (raw === 'default' || raw === undefined || raw === null) return null;
  if (typeof raw === 'string' && options.some((option) => option.value === raw)) return raw;
  if (typeof raw === 'number') {
    const option = options.find((entry) => entry.value === raw);
    if (option) return option.value;
    const label = defaultResolveSynthEnums()[spec.table][raw];
    if (typeof label === 'string') return label;
  }
  return null;
}

/** Maps a synth enum table to SelectMenu options. */
function synthEnumOptions(
  spec: SynthEnumControlSpec,
  tables: SynthEnumTables,
): ReadonlyArray<ProcessorEnumOption> {
  return tables[spec.table].map((value) => ({
    value,
    label: value
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' '),
  }));
}

/** Builds the synth enum descriptors after numeric controls. */
function synthEnumControls(
  patch: StoredSynthPatch | null,
  basePatch: StoredSynthPatch | null,
): QuickControl[] {
  const tables = defaultResolveSynthEnums();
  return SYNTH_ENUM_CONTROLS.flatMap((spec) => {
    const options = synthEnumOptions(spec, tables);
    if (options.length === 0) return [];
    const value =
      patchEnumValue(patch, spec, options) ??
      patchEnumValue(basePatch, spec, options) ??
      options[0]?.value;
    if (value === undefined) return [];
    return [
      {
        kind: 'enum' as const,
        id: spec.id,
        name: spec.name,
        value,
        options,
        defaultValue: options[0]?.value ?? value,
      },
    ];
  });
}

/** Reads a synth patch field as a set value (omitted = keep base). */
function patchValue(patch: StoredSynthPatch | null, id: string): number | null {
  if (!patch) return null;
  const value = (patch as Record<string, unknown>)[id];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return decodePatchFieldValue(id as NumericPatchField, value);
}

/** Default preset resolver: the wasm catalog, when the module is loaded. */
function defaultResolvePresetPatch(preset: string): StoredSynthPatch | null {
  try {
    const wasm = getWasmModule() as unknown as {
      synthPresetPatch?: (name: string) => StoredSynthPatch;
    };
    if (typeof wasm.synthPresetPatch !== 'function') return null;
    return wasm.synthPresetPatch(preset);
  } catch {
    return null;
  }
}

/** Default insert-param resolver: the wasm catalog, when available. */
function defaultResolveInsertParams(processor: string): string[] {
  try {
    const wasm = getWasmModule() as unknown as {
      masteringInsertParamNames?: (name: string) => string[];
    };
    if (typeof wasm.masteringInsertParamNames !== 'function') return [];
    return wasm.masteringInsertParamNames(processor);
  } catch {
    return [];
  }
}

/** Default insert-metadata resolver: uses the loaded engine catalog when available. */
function defaultResolveInsertParamInfo(processor: string): QuickControlParamInfo[] {
  try {
    const wasm = getWasmModule() as unknown as {
      masteringInsertParamInfo?: (name: string) => QuickControlParamInfo[];
    };
    if (typeof wasm.masteringInsertParamInfo !== 'function') return [];
    return wasm.masteringInsertParamInfo(processor);
  } catch {
    return [];
  }
}

/** Returns the strip a quick-control insert target lives on, or throws. */
function requireStrip(target: MixerStripTarget): MixerStrip {
  const store = useProjectStore();
  if (target === 'master') return store.mixer.master;
  if (isMixerBusStripTarget(target)) {
    const busId = mixerBusIdFromTarget(target);
    const bus = store.mixer.buses.find((entry) => entry.id === busId);
    if (!bus) throw new RangeError(`Unknown mixer bus id: ${busId}`);
    return bus.strip ?? { gainDb: 0, pan: 0, inserts: [], sends: [] };
  }
  const track = store.tracks.find((t) => t.id === target);
  if (!track) throw new RangeError(`Unknown track id: ${target}`);
  return track.mixer ?? { gainDb: 0, pan: 0, inserts: [], sends: [] };
}

/** Returns the addressed insert slot, or throws RangeError. */
function requireInsertSlot(target: { trackId: MixerStripTarget; index: number }): InsertSlot {
  const strip = requireStrip(target.trackId);
  const slot = strip.inserts[target.index];
  if (!Number.isInteger(target.index) || !slot) {
    throw new RangeError(`Unknown insert index: ${target.index}`);
  }
  return slot;
}

/**
 * Lists the primary quick controls of an instrument or insert slot.
 *
 * Instrument targets expose the NativeSynth wrapper fields (cutoff,
 * resonance, envelope, drive, gain); values fall back from the explicit
 * patch fields to the resolved preset base to documented defaults. SF2
 * instruments expose no quick controls in this iteration.
 *
 * Insert targets expose every available parameter: the names come from the
 * resolver (wasm masteringInsertParamNames by default) merged with any
 * explicitly set params; ranges prefer the shared processor-param domain
 * catalog and fall back to naming conventions for unknown custom processors.
 *
 * @param target What the rack addresses.
 * @param resolvers Optional catalog resolvers (tests, custom catalogs).
 * @returns Quick-control descriptors (possibly empty).
 */
export function listQuickControls(
  target: QuickControlTarget,
  resolvers: QuickControlResolvers = {},
): QuickControl[] {
  if (target.type === 'instrument') {
    const store = useProjectStore();
    const track = store.tracks.find((t) => t.id === target.trackId);
    if (!track) throw new RangeError(`Unknown track id: ${target.trackId}`);
    const instrument = trackInstrument(track);
    if (instrument.kind === 'sf2') return [];
    const patch = instrument.kind === 'synth-patch' ? instrument.patch : null;
    const presetName = instrument.kind === 'synth-preset' ? instrument.preset : patch?.preset;
    const resolvePreset = resolvers.resolvePresetPatch ?? defaultResolvePresetPatch;
    const basePatch = presetName !== undefined ? resolvePreset(presetName) : null;
    const specs = isPluckedStringPreset(presetName, basePatch)
      ? PLUCKED_STRING_QUICK_CONTROLS
      : SYNTH_QUICK_CONTROLS;
    const numericControls = specs.map((spec) => {
      const value = patchValue(patch, spec.id) ?? patchValue(basePatch, spec.id) ?? spec.fallback;
      const control: QuickControl = {
        kind: 'number',
        id: spec.id,
        name: spec.name,
        value,
        min: spec.min,
        max: spec.max,
        defaultValue: spec.fallback,
      };
      if (spec.scale !== undefined) control.scale = spec.scale;
      if (spec.unit !== undefined) control.unit = spec.unit;
      return control;
    });
    // Enum fields appear once a patch/preset actually selects one. NativeSynth
    // has no parameter-info catalog, so an omitted enum remains an ABI
    // "keep" sentinel rather than a guessed default control.
    const enumControls = synthEnumControls(patch, basePatch).filter((control) => {
      if (control.kind !== 'enum') return false;
      return control.value !== control.defaultValue;
    });
    return [...numericControls, ...enumControls];
  }
  const slot = requireInsertSlot(target);
  const resolveParams = resolvers.resolveInsertParams ?? defaultResolveInsertParams;
  const catalogNames = resolveParams(slot.processor);
  const resolveInfo = resolvers.resolveInsertParamInfo ?? defaultResolveInsertParamInfo;
  const paramInfo = resolveInfo(slot.processor);
  return processorControls(slot.processor, catalogNames, slot.params, paramInfo);
}

/**
 * Sets one quick control as an undoable command, clamped to the control's
 * range. Instrument edits on a 'synth-preset' track promote the instrument to
 * a 'synth-patch' based on that preset, so the preset's character is kept
 * while the field overrides it.
 *
 * Continuous drags coalesce: pass `{ commit: false }` for every intermediate
 * value and let the final call (commit omitted or true) close the gesture —
 * the whole drag lands as one history entry.
 *
 * @param target What the rack addresses.
 * @param id Control id (from {@link listQuickControls}).
 * @param value New value (finite; clamped to the control range).
 * @param options Gesture coalescing flag.
 */
export function setQuickControl(
  target: QuickControlTarget,
  id: string,
  value: ProcessorControlValue,
  options?: CommandGestureOptions,
): void {
  if (target.type === 'instrument') {
    const store = useProjectStore();
    const track = store.tracks.find((t) => t.id === target.trackId);
    if (!track) throw new RangeError(`Unknown track id: ${target.trackId}`);
    const instrument = trackInstrument(track);
    if (instrument.kind === 'sf2') {
      throw new RangeError('SF2 instruments expose no quick controls');
    }
    if (instrument.kind === 'external-midi') {
      throw new RangeError('External MIDI instruments expose no quick controls');
    }
    const patch = instrument.kind === 'synth-patch' ? instrument.patch : null;
    const presetName = instrument.kind === 'synth-preset' ? instrument.preset : patch?.preset;
    const presetBasePatch = presetName !== undefined ? defaultResolvePresetPatch(presetName) : null;
    const numericSpec =
      SYNTH_QUICK_CONTROLS.find((entry) => entry.id === id) ??
      PLUCKED_STRING_QUICK_CONTROLS.find((entry) => entry.id === id);
    if (numericSpec) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new RangeError(`Quick control "${id}" requires a finite number`);
      }
      const control: QuickControl = {
        kind: 'number',
        id,
        name: numericSpec.name,
        value: numericSpec.fallback,
        min: numericSpec.min,
        max: numericSpec.max,
        defaultValue: numericSpec.fallback,
        ...(numericSpec.scale !== undefined ? { scale: numericSpec.scale } : {}),
        ...(numericSpec.unit !== undefined ? { unit: numericSpec.unit } : {}),
      };
      validateProcessorControlValue(control, value);
      const clamped = Math.min(numericSpec.max, Math.max(numericSpec.min, value));
      const basePatch: StoredSynthPatch =
        instrument.kind === 'synth-patch' ? { ...instrument.patch } : { preset: instrument.preset };
      const nextPatch = { ...basePatch, [id]: clamped } as StoredSynthPatch;
      setTrackInstrument(target.trackId, { kind: 'synth-patch', patch: nextPatch }, options);
      return;
    }
    const enumSpec = SYNTH_ENUM_CONTROLS.find((entry) => entry.id === id);
    if (!enumSpec) throw new RangeError(`Unknown instrument quick control: ${id}`);
    const optionsForEnum = synthEnumOptions(enumSpec, defaultResolveSynthEnums());
    const current =
      patchEnumValue(patch, enumSpec, optionsForEnum) ??
      patchEnumValue(presetBasePatch, enumSpec, optionsForEnum) ??
      optionsForEnum[0]?.value;
    const enumControl: QuickControl = {
      kind: 'enum',
      id,
      name: enumSpec.name,
      value: current ?? 'default',
      options: optionsForEnum,
      defaultValue: optionsForEnum[0]?.value ?? 'default',
    };
    validateProcessorControlValue(enumControl, value);
    const patchBase: StoredSynthPatch =
      instrument.kind === 'synth-patch' ? { ...instrument.patch } : { preset: instrument.preset };
    const nextPatch = { ...patchBase, [id]: value } as StoredSynthPatch;
    setTrackInstrument(target.trackId, { kind: 'synth-patch', patch: nextPatch }, options);
    return;
  }
  const slot = requireInsertSlot(target);
  const raw = slot.params[id];
  const paramInfo = defaultResolveInsertParamInfo(slot.processor).find((info) => info.name === id);
  const control = processorControl(slot.processor, id, raw, paramInfo);
  if (control) validateProcessorControlValue(control, value);
  else if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`Unknown insert control "${id}" requires a finite number`);
  }
  const rule = processorNumberSpec(slot.processor, id);
  // The app-side range catalog is a drawing/interaction convenience, not an
  // engine contract. Preserve values for an unknown processor parameter so a
  // harmless LFO rate such as 2 Hz is not silently turned into 20 Hz.
  const hasExplicitDomain = insertParamDomain(slot.processor, id) !== INSERT_PARAM_DOMAIN_FALLBACK;
  if (control?.kind !== 'number') {
    setInsertParam(target.trackId, target.index, id, value as number | boolean, options);
    return;
  }
  const next =
    hasExplicitDomain && typeof value === 'number'
      ? Math.min(rule.max, Math.max(rule.min, value))
      : (value as number);
  setInsertParam(target.trackId, target.index, id, next, options);
}
