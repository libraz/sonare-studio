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

import type { SynthPatch } from '@/wasm/index.js';
import {
  type CommandGestureOptions,
  isMixerBusStripTarget,
  type MixerStripTarget,
  mixerBusIdFromTarget,
  setInsertParam,
  setTrackInstrument,
} from './commands';
import { INSERT_PARAM_DOMAIN_FALLBACK, insertParamDomain } from './insert-param-domains';
import { trackInstrument } from './instrument';
import type { InsertSlot, MixerStrip } from './mixer';
import { getWasmModule, useProjectStore } from './store';

/** One quick-control descriptor (a knob in the device rack). */
export interface QuickControl {
  /** Parameter id (SynthPatch field name or insert param name). */
  id: string;
  /** Display name. */
  name: string;
  /** Current value. */
  value: number;
  /** Lower bound of the control range. */
  min: number;
  /** Upper bound of the control range. */
  max: number;
  /** Display unit (e.g. 'Hz', 'ms', 'dB'); omitted for unitless values. */
  unit?: string;
}

/** Addresses what a quick-control rack edits. */
export type QuickControlTarget =
  | { type: 'instrument'; trackId: number }
  | { type: 'insert'; trackId: MixerStripTarget; index: number };

/** Injectable catalog resolvers (default to the loaded wasm module). */
export interface QuickControlResolvers {
  /** Resolves a synth preset to its patch values; null when unknown. */
  resolvePresetPatch?: (preset: string) => SynthPatch | null;
  /** Resolves an insert processor name to its parameter names. */
  resolveInsertParams?: (processor: string) => string[];
}

/** Maximum number of controls a target exposes. */
const MAX_QUICK_CONTROLS = 8;

/** One entry of the NativeSynth quick-control table. */
interface SynthControlSpec {
  id: keyof SynthPatch & string;
  name: string;
  min: number;
  max: number;
  unit?: string;
  /** Value shown when neither patch nor preset defines the field. */
  fallback: number;
}

/**
 * Primary NativeSynth patch fields exposed as quick controls. The frozen
 * patch ABI treats numeric 0/omitted as "keep the base value", so unset
 * fields display the preset's value (when resolvable) or the documented
 * engine default.
 */
const SYNTH_QUICK_CONTROLS: ReadonlyArray<SynthControlSpec> = [
  { id: 'cutoffHz', name: 'Cutoff', min: 20, max: 20000, unit: 'Hz', fallback: 18000 },
  { id: 'resonanceQ', name: 'Resonance', min: 0.1, max: 20, fallback: Math.SQRT1_2 },
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
  { id: 'cutoffHz', name: 'Tone', min: 20, max: 20000, unit: 'Hz', fallback: 18000 },
  { id: 'resonanceQ', name: 'Cab Q', min: 0.1, max: 20, fallback: Math.SQRT1_2 },
  { id: 'ampAttackMs', name: 'Pick', min: 0, max: 5000, unit: 'ms', fallback: 5 },
  { id: 'ampReleaseMs', name: 'Damp', min: 0, max: 5000, unit: 'ms', fallback: 120 },
];

function isPluckedStringPreset(
  presetName: string | undefined,
  basePatch: SynthPatch | null,
): boolean {
  const lower = presetName?.toLowerCase() ?? '';
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

/** One insert-parameter range heuristic, matched by name pattern. */
interface ParamRangeRule {
  test: RegExp;
  min: number;
  max: number;
  unit?: string;
  fallback: number;
}

/**
 * Range heuristics for insert parameters: the wasm catalog exposes parameter
 * names only (masteringInsertParamNames), so ranges are inferred from the
 * camelCase naming conventions of the processor params.
 */
const PARAM_RANGE_RULES: ReadonlyArray<ParamRangeRule> = [
  { test: /thresholdDb$/i, min: -60, max: 0, unit: 'dB', fallback: -24 },
  { test: /Db$/, min: -24, max: 24, unit: 'dB', fallback: 0 },
  { test: /ratio$/i, min: 1, max: 20, fallback: 4 },
  { test: /Ms$/, min: 0, max: 5000, unit: 'ms', fallback: 10 },
  { test: /Hz$/, min: 20, max: 20000, unit: 'Hz', fallback: 1000 },
  // Filter Q factor: a standalone 'q' or a name ending in 'Q' (e.g.
  // 'resonanceQ', 'bandQ'). The start anchor must also end the string, or any
  // name merely starting with 'q' (e.g. 'quantize') would be misread as a Q.
  { test: /^q$|Q$/, min: 0.1, max: 18, fallback: Math.SQRT1_2 },
];

/** Fallback range for parameters no rule matches (normalized amounts). */
const DEFAULT_PARAM_RULE: Omit<ParamRangeRule, 'test'> = { min: 0, max: 1, fallback: 0 };

/** Returns the range rule for an insert parameter, preferring the shared domain catalog. */
function paramRule(processor: string, name: string): Omit<ParamRangeRule, 'test'> {
  const heuristic = PARAM_RANGE_RULES.find((rule) => rule.test.test(name)) ?? DEFAULT_PARAM_RULE;
  const domain = insertParamDomain(processor, name);
  if (domain !== INSERT_PARAM_DOMAIN_FALLBACK) {
    return {
      min: domain.min,
      max: domain.max,
      ...(domain.unit ? { unit: domain.unit } : {}),
      fallback: Math.min(domain.max, Math.max(domain.min, heuristic.fallback)),
    };
  }
  return heuristic;
}

/** Splits a camelCase parameter name into a capitalized display name. */
function humanizeParamName(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Reads a synth patch field as a set value (0/undefined = keep base). */
function patchValue(patch: SynthPatch | null, id: string): number | null {
  if (!patch) return null;
  const value = (patch as Record<string, unknown>)[id];
  return typeof value === 'number' && value !== 0 ? value : null;
}

/** Default preset resolver: the wasm catalog, when the module is loaded. */
function defaultResolvePresetPatch(preset: string): SynthPatch | null {
  try {
    const wasm = getWasmModule() as unknown as {
      synthPresetPatch?: (name: string) => SynthPatch;
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
 * Insert targets expose up to eight parameters: the names come from the
 * resolver (wasm masteringInsertParamNames by default) merged with any
 * explicitly set params; ranges are inferred from naming conventions.
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
    return specs.map((spec) => {
      const value = patchValue(patch, spec.id) ?? patchValue(basePatch, spec.id) ?? spec.fallback;
      const control: QuickControl = {
        id: spec.id,
        name: spec.name,
        value,
        min: spec.min,
        max: spec.max,
      };
      if (spec.unit !== undefined) control.unit = spec.unit;
      return control;
    });
  }
  const slot = requireInsertSlot(target);
  const resolveParams = resolvers.resolveInsertParams ?? defaultResolveInsertParams;
  const catalogNames = resolveParams(slot.processor);
  const setNames = Object.keys(slot.params).filter((name) => typeof slot.params[name] === 'number');
  const names = [...new Set([...catalogNames, ...setNames])].slice(0, MAX_QUICK_CONTROLS);
  return names.map((name) => {
    const rule = paramRule(slot.processor, name);
    const raw = slot.params[name];
    const control: QuickControl = {
      id: name,
      name: humanizeParamName(name),
      value: typeof raw === 'number' ? raw : rule.fallback,
      min: rule.min,
      max: rule.max,
    };
    if (rule.unit !== undefined) control.unit = rule.unit;
    return control;
  });
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
  value: number,
  options?: CommandGestureOptions,
): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Quick control value must be finite, got ${value}`);
  }
  if (target.type === 'instrument') {
    const spec =
      SYNTH_QUICK_CONTROLS.find((entry) => entry.id === id) ??
      PLUCKED_STRING_QUICK_CONTROLS.find((entry) => entry.id === id);
    if (!spec) throw new RangeError(`Unknown instrument quick control: ${id}`);
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
    const clamped = Math.min(spec.max, Math.max(spec.min, value));
    const basePatch: SynthPatch =
      instrument.kind === 'synth-patch' ? { ...instrument.patch } : { preset: instrument.preset };
    const patch = { ...basePatch, [id]: clamped } as SynthPatch;
    setTrackInstrument(target.trackId, { kind: 'synth-patch', patch }, options);
    return;
  }
  const slot = requireInsertSlot(target);
  const rule = paramRule(slot.processor, id);
  const clamped = Math.min(rule.max, Math.max(rule.min, value));
  setInsertParam(target.trackId, target.index, id, clamped, options);
}
