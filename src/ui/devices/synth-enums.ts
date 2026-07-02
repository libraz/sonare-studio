/**
 * NativeSynth enum tables for the patch editor UI.
 *
 * The authoritative tables come from the loaded wasm catalog
 * (synthEnumTables()); this module ships fallbacks matching the published
 * constants so selects can render before the module is loaded and in test
 * environments where the wasm binary is unavailable.
 */

import type { SynthEnumTables } from '@/wasm/index.js';

/** Fallback tables mirroring the published SYNTH_* constants. */
export const FALLBACK_SYNTH_ENUMS: SynthEnumTables = {
  engineModes: [
    'default',
    'subtractive',
    'fm',
    'karplus-strong',
    'modal',
    'additive',
    'percussion',
    'piano',
    'pipe-organ',
    'bowed-string',
    'reed',
    'brass',
    'flute',
  ],
  waveforms: ['default', 'sine', 'saw', 'square', 'triangle', 'noise'],
  filterModels: ['default', 'svf', 'moog-ladder', 'diode-ladder', 'sallen-key'],
  filterOutputs: ['default', 'lowpass', 'bandpass', 'highpass'],
  bodyTypes: ['default', 'none', 'guitar', 'violin', 'wood-tube', 'brass-bell'],
  modSources: [
    'none',
    'amp-env',
    'filter-env',
    'lfo1',
    'lfo2',
    'velocity',
    'key-track',
    'mod-wheel',
    'random',
  ],
  modDestinations: ['none', 'pitch-cents', 'cutoff-cents', 'amp-gain', 'pan-units'],
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
  const merged: SynthEnumTables = {
    engineModes: [...FALLBACK_SYNTH_ENUMS.engineModes],
    waveforms: [...FALLBACK_SYNTH_ENUMS.waveforms],
    filterModels: [...FALLBACK_SYNTH_ENUMS.filterModels],
    filterOutputs: [...FALLBACK_SYNTH_ENUMS.filterOutputs],
    bodyTypes: [...FALLBACK_SYNTH_ENUMS.bodyTypes],
    modSources: [...FALLBACK_SYNTH_ENUMS.modSources],
    modDestinations: [...FALLBACK_SYNTH_ENUMS.modDestinations],
  };
  if (!tables) return merged;
  for (const key of Object.keys(merged) as Array<keyof SynthEnumTables>) {
    const value = tables[key];
    if (Array.isArray(value) && value.length > 0) merged[key] = [...value];
  }
  return merged;
}
