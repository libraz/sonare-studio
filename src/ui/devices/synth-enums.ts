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
    'plucked-string',
    'vocal',
    'free-reed',
    'harpsichord',
    'sample',
  ],
  waveforms: ['default', 'sine', 'saw', 'square', 'triangle', 'noise'],
  // Custom built-in waves are discovered from the WASM catalog. There is no
  // stable static list to offer before it is loaded.
  builtinWaveforms: [],
  filterModels: ['default', 'svf', 'moog-ladder', 'diode-ladder', 'sallen-key'],
  filterOutputs: ['default', 'lowpass', 'bandpass', 'highpass'],
  bodyTypes: ['default', 'none', 'guitar', 'violin', 'wood-tube', 'brass-bell', 'vocal'],
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
    'breath',
    'aftertouch',
    'expression-cc',
    'pitch-bend',
  ],
  modDestinations: [
    'none',
    'pitch-cents',
    'cutoff-cents',
    'amp-gain',
    'pan-units',
    'resonance-q',
    'vibrato-depth-cents',
    'filter-env-depth',
    'lfo1-rate-scale',
    'excitation-force',
    'excitation-position',
    'excitation-brightness',
    'spectrum-morph',
  ],
  controllerInputs: [
    'control-change',
    'channel-pressure',
    'poly-pressure',
    'pitch-bend',
    'velocity',
  ],
  controllerAxes: [
    'none',
    'excitation',
    'position',
    'brightness',
    'morph',
    'loudness',
    'pitch-cents',
    'vibrato-depth',
  ],
  articulations: ['poly', 'mono-retrigger', 'mono-legato'],
  mpeDimensions: ['bend', 'pressure', 'timbre'],
  noteTrackings: ['last', 'lowest', 'highest', 'all'],
};

/**
 * Voice seed modes mirroring the published SYNTH_RETRIGGERS: 'note' restarts
 * each voice's randomness from the note, so a repeated note renders the same
 * samples; 'free' keeps it running.
 */
export const SYNTH_RETRIGGER_OPTIONS: readonly string[] = ['default', 'free', 'note'];

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
