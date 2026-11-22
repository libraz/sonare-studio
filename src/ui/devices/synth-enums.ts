/**
 * NativeSynth enum tables for the patch editor UI.
 *
 * The authoritative tables come from the loaded wasm catalog
 * (synthEnumTables()); this module ships fallbacks matching the published
 * constants so selects can render before the module is loaded and in test
 * environments where the wasm binary is unavailable.
 */

import {
  ARTICULATIONS,
  BUILTIN_SYNTH_WAVEFORMS,
  CONTROLLER_AXES,
  CONTROLLER_INPUTS,
  MPE_DIMENSIONS,
  NOTE_TRACKINGS,
  PART_RIG_MODES,
  SAMPLE_KEY_TRACKS,
  SAMPLE_LOOP_MODES,
  SYNTH_BODY_TYPES,
  SYNTH_ENGINE_MODES,
  SYNTH_FILTER_MODELS,
  SYNTH_FILTER_OUTPUTS,
  SYNTH_LFO_SHAPES,
  SYNTH_MOD_DESTINATIONS,
  SYNTH_MOD_SOURCES,
  SYNTH_OSC_WAVEFORMS,
  SYNTH_RETRIGGERS,
  type SynthEnumTables,
} from '@/wasm/index.js';

/** Fallback tables built from the core's exported SYNTH_* constants. */
export const FALLBACK_SYNTH_ENUMS: SynthEnumTables = {
  engineModes: [...SYNTH_ENGINE_MODES],
  waveforms: [...SYNTH_OSC_WAVEFORMS],
  builtinWaveforms: [...BUILTIN_SYNTH_WAVEFORMS],
  filterModels: [...SYNTH_FILTER_MODELS],
  filterOutputs: [...SYNTH_FILTER_OUTPUTS],
  bodyTypes: [...SYNTH_BODY_TYPES],
  modSources: [...SYNTH_MOD_SOURCES],
  modDestinations: [...SYNTH_MOD_DESTINATIONS],
  controllerInputs: [...CONTROLLER_INPUTS],
  controllerAxes: [...CONTROLLER_AXES],
  articulations: [...ARTICULATIONS],
  mpeDimensions: [...MPE_DIMENSIONS],
  noteTrackings: [...NOTE_TRACKINGS],
  sampleLoopModes: [...SAMPLE_LOOP_MODES],
  sampleKeyTracks: [...SAMPLE_KEY_TRACKS],
  retriggers: [...SYNTH_RETRIGGERS],
  lfoShapes: [...SYNTH_LFO_SHAPES],
  partRigModes: [...PART_RIG_MODES],
  sampleDescLoopModes: SAMPLE_LOOP_MODES.filter((mode) => mode !== 'default'),
};

/**
 * Merges runtime enum tables over the fallbacks. Empty or missing table
 * entries keep the fallback so a partial (or absent) catalog never produces
 * empty selects.
 *
 * @param tables Runtime tables (e.g. from wasm synthEnumTables()), or null.
 * @returns Complete tables, never empty.
 */
export function resolveSynthEnums(tables?: Partial<SynthEnumTables> | null): SynthEnumTables {
  const merged = Object.fromEntries(
    Object.entries(FALLBACK_SYNTH_ENUMS).map(([key, values]) => [key, [...values]]),
  ) as unknown as SynthEnumTables;
  if (!tables) return merged;
  for (const key of Object.keys(merged) as Array<keyof SynthEnumTables>) {
    const value = tables[key];
    if (Array.isArray(value) && value.length > 0) merged[key] = [...value];
  }
  return merged;
}
