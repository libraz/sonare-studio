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
  /** Linear master output gain (> 0); omitted = engine default (0.5). */
  gain?: number;
  /** Max simultaneous voices (integer in [1, 64]); omitted = engine default (48). */
  polyphony?: number;
}

/**
 * Instrument variant: the track's MIDI is sent to an external device over a Web
 * MIDI output port instead of being rendered by a built-in synth. Realtime
 * only — the offline bounce has no external device, so an external-midi track
 * is silent in audio exports (its notes still export to SMF).
 */
export interface ExternalMidiInstrument {
  kind: 'external-midi';
  /** Web MIDI output port id (a navigator.requestMIDIAccess outputs key). */
  outputPortId: string;
  /** MIDI channel transmitted to the device (0-15). */
  channel: number;
  /** When true, forward MIDI clock + transport to the port for tempo sync. */
  sendClock?: boolean;
}

/** Instrument used to render a track's MIDI clips. */
export type TrackInstrument =
  | SynthPresetInstrument
  | SynthPatchInstrument
  | Sf2Instrument
  | ExternalMidiInstrument;

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

/**
 * Returns the instrument currently used by a track after applying project-level
 * External MIDI inheritance. A track only inherits when it explicitly opts into
 * project mode and a project route exists; otherwise normal track instrument
 * fallback applies.
 */
export function effectiveTrackInstrument(
  track: { instrument?: TrackInstrument; externalMidiMode?: 'project' },
  projectExternalMidi: ExternalMidiInstrument | null | undefined,
): TrackInstrument {
  if (track.externalMidiMode === 'project' && projectExternalMidi) return projectExternalMidi;
  return trackInstrument(track);
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
      const { gain, polyphony } = instrument;
      if (gain !== undefined && (!Number.isFinite(gain) || gain <= 0)) {
        throw new RangeError(`SF2 gain must be a positive number, got ${gain}`);
      }
      if (
        polyphony !== undefined &&
        (!Number.isInteger(polyphony) || polyphony < 1 || polyphony > 64)
      ) {
        throw new RangeError(`SF2 polyphony must be an integer in [1, 64], got ${polyphony}`);
      }
      return;
    }
    case 'external-midi': {
      if (typeof instrument.outputPortId !== 'string' || instrument.outputPortId.length === 0) {
        throw new RangeError('External MIDI instrument requires a non-empty outputPortId');
      }
      if (
        !Number.isInteger(instrument.channel) ||
        instrument.channel < 0 ||
        instrument.channel > 15
      ) {
        throw new RangeError(
          `External MIDI channel must be an integer in [0, 15], got ${instrument.channel}`,
        );
      }
      if (instrument.sendClock !== undefined && typeof instrument.sendClock !== 'boolean') {
        throw new RangeError('External MIDI sendClock must be a boolean when present');
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
/**
 * Engine player config (master gain + voice cap) an SF2 instrument plays with.
 *
 * Only the fields the instrument sets explicitly are returned; anything it
 * leaves unset is omitted so the engine applies its own defaults (gain 0.5,
 * 48 voices). The same config drives live playback (setSf2Instrument) and the
 * offline bounce (bounceWithSf2Instrument).
 *
 * @param instrument SF2 instrument to read.
 * @returns A config object with only the explicitly-set gain/polyphony fields.
 */
export function sf2PlaybackConfig(instrument: Sf2Instrument): {
  gain?: number;
  polyphony?: number;
} {
  const config: { gain?: number; polyphony?: number } = {};
  if (instrument.gain !== undefined) config.gain = instrument.gain;
  if (instrument.polyphony !== undefined) config.polyphony = instrument.polyphony;
  return config;
}

export function instrumentCacheSegment(instrument: TrackInstrument): string {
  switch (instrument.kind) {
    case 'synth-preset':
      return `preset=${encodeURIComponent(instrument.preset)}`;
    case 'synth-patch':
      return `patch=${fnv1a32Hex(canonicalJson(instrument.patch))}`;
    case 'sf2':
      return `sf2=${encodeURIComponent(instrument.fontId)}:${instrument.bank ?? -1}:${
        instrument.program ?? -1
      }:${instrument.gain ?? -1}:${instrument.polyphony ?? -1}`;
    case 'external-midi':
      // External-MIDI tracks are not bounced; this segment exists only to keep
      // the cache key exhaustive over the instrument union.
      return `ext=${encodeURIComponent(instrument.outputPortId)}:${instrument.channel}:${
        instrument.sendClock ? 1 : 0
      }`;
    default: {
      const exhaustive: never = instrument;
      throw new RangeError(`Unknown instrument kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
