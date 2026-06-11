/**
 * Per-track instrument model.
 *
 * A track instrument describes how the track's MIDI clips are rendered to
 * audio by the offline bounce (src/engine/instruments.ts). The three variants
 * map onto the libsonare Project bounce entry points:
 * - 'synth-preset' -> bounceWithSynthInstrument(presetName)
 * - 'synth-patch'  -> bounceWithSynthInstrument(patch) (NativeSynth SynthPatch)
 * - 'sf2'          -> loadSoundFont + bounceWithSf2Instrument (bank/program
 *   selection is injected as MIDI bank-select/program-change events)
 *
 * Instrument state is app-level track metadata: the wasm Project has no
 * per-track instrument API, so it lives on the store mirror and is persisted
 * by the project document (schema version 3).
 */

import type { SynthPatch } from '@/wasm/index.js';
import { canonicalJson, fnv1a32Hex } from './hash';

/** Instrument variant: a NativeSynth catalog preset referenced by name. */
export interface SynthPresetInstrument {
  kind: 'synth-preset';
  /** Preset name from the NativeSynth catalog (synthPresetNames()). */
  preset: string;
}

/** Instrument variant: an editable NativeSynth patch (possibly preset-based). */
export interface SynthPatchInstrument {
  kind: 'synth-patch';
  /** NativeSynth patch; numeric 0/omitted fields keep the base preset value. */
  patch: SynthPatch;
}

/** Instrument variant: a stored SoundFont (SF2) with optional program select. */
export interface Sf2Instrument {
  kind: 'sf2';
  /** SoundFont id in the font store (src/project/fonts.ts). */
  fontId: string;
  /** MIDI bank number (0-16383, MSB*128+LSB); omitted = bank 0. */
  bank?: number;
  /** MIDI program number (0-127); omitted = program 0. */
  program?: number;
}

/** Instrument used to render a track's MIDI clips. */
export type TrackInstrument = SynthPresetInstrument | SynthPatchInstrument | Sf2Instrument;

/** Preset rendered when a track carries no explicit instrument. */
export const DEFAULT_SYNTH_PRESET = 'e-piano';

/** Builds the default instrument (the historical 'e-piano' synth preset). */
export function defaultTrackInstrument(): SynthPresetInstrument {
  return { kind: 'synth-preset', preset: DEFAULT_SYNTH_PRESET };
}

/**
 * Returns a track's effective instrument: its own when set, otherwise the
 * default synth preset.
 */
export function trackInstrument(track: { instrument?: TrackInstrument }): TrackInstrument {
  return track.instrument ?? defaultTrackInstrument();
}

/** Deep-copies an instrument (instruments are plain JSON data). */
export function cloneInstrument(instrument: TrackInstrument): TrackInstrument {
  return JSON.parse(JSON.stringify(instrument)) as TrackInstrument;
}

/** Structural equality on instruments (field order insensitive). */
export function instrumentEquals(a: TrackInstrument, b: TrackInstrument): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** True when the instrument is exactly the default synth preset. */
export function isDefaultInstrument(instrument: TrackInstrument): boolean {
  return instrument.kind === 'synth-preset' && instrument.preset === DEFAULT_SYNTH_PRESET;
}

/**
 * Validates an instrument's fields, throwing RangeError on malformed input.
 *
 * @param instrument Instrument to validate.
 */
export function validateTrackInstrument(instrument: TrackInstrument): void {
  switch (instrument.kind) {
    case 'synth-preset':
      if (typeof instrument.preset !== 'string' || instrument.preset.length === 0) {
        throw new RangeError('Synth preset instrument requires a non-empty preset name');
      }
      return;
    case 'synth-patch':
      if (
        typeof instrument.patch !== 'object' ||
        instrument.patch === null ||
        Array.isArray(instrument.patch)
      ) {
        throw new RangeError('Synth patch instrument requires a patch object');
      }
      return;
    case 'sf2': {
      if (typeof instrument.fontId !== 'string' || instrument.fontId.length === 0) {
        throw new RangeError('SF2 instrument requires a non-empty fontId');
      }
      const { bank, program } = instrument;
      if (bank !== undefined && (!Number.isInteger(bank) || bank < 0 || bank > 16383)) {
        throw new RangeError(`SF2 bank must be an integer in [0, 16383], got ${bank}`);
      }
      if (program !== undefined && (!Number.isInteger(program) || program < 0 || program > 127)) {
        throw new RangeError(`SF2 program must be an integer in [0, 127], got ${program}`);
      }
      return;
    }
    default: {
      const exhaustive: never = instrument;
      throw new RangeError(`Unknown instrument kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Deterministic identity segment for prerender cache keys.
 *
 * The segment covers everything in the instrument that influences the bounced
 * audio: preset name, the full patch content (canonicalized and hashed), or
 * the SoundFont id plus bank/program. The synth-preset form intentionally
 * matches the historical `preset=<name>` cache-key segment.
 *
 * @param instrument Instrument to identify.
 * @returns A stable key segment.
 */
export function instrumentCacheSegment(instrument: TrackInstrument): string {
  switch (instrument.kind) {
    case 'synth-preset':
      return `preset=${encodeURIComponent(instrument.preset)}`;
    case 'synth-patch':
      return `patch=${fnv1a32Hex(canonicalJson(instrument.patch))}`;
    case 'sf2':
      return `sf2=${encodeURIComponent(instrument.fontId)}:${instrument.bank ?? -1}:${
        instrument.program ?? -1
      }`;
    default: {
      const exhaustive: never = instrument;
      throw new RangeError(`Unknown instrument kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
