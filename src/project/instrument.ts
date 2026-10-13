/**
 * Per-track instrument model.
 *
 * A track instrument describes how the track's MIDI clips are rendered to
 * audio by the offline bounce (src/engine/instruments.ts). The three variants
 * map onto the libsonare Project bounce entry points:
 * - 'synth-preset' -> bounceWithSynthInstrument(presetName), or a binding
 *   object when the NativeSynth GM program resolver is enabled
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

/**
 * A NativeSynth patch as a project stores it: plain data, without the live
 * sample-bank handle a sample-engine patch can carry at the wasm boundary.
 */
export type StoredSynthPatch = Omit<SynthPatch, 'sampleBank'>;

/** Instrument variant: a NativeSynth catalog preset referenced by name. */
export interface SynthPresetInstrument {
  kind: 'synth-preset';
  /** Preset name from the NativeSynth catalog (synthPresetNames()). */
  preset: string;
  /** Resolve incoming MIDI bank/program messages through the NativeSynth GM bank. */
  useGmPrograms?: boolean;
  /** Original GM bank imported from SMF; export uses it before preset reverse-mapping. */
  gmBank?: number;
  /** Original GM program imported from SMF; export uses it before preset reverse-mapping. */
  gmProgram?: number;
}

/** Program used when a catalog preset is converted to a GM instrument or exported as SMF. */
export function gmProgramForPreset(preset: string): number {
  return PRESET_GM_PROGRAM[preset] ?? 4;
}

/** NativeSynth's named presets and their nearest standard GM address. */
const PRESET_GM_PROGRAM: Readonly<Record<string, number>> = {
  sine: 80,
  saw: 81,
  square: 80,
  triangle: 81,
  'saw-lead': 81,
  'square-lead': 80,
  'sub-bass': 38,
  'warm-pad': 89,
  'e-piano': 4,
  bell: 14,
  brass: 56,
  pluck: 104,
  'classical-guitar': 24,
  'steel-guitar': 25,
  'electric-guitar': 26,
  harp: 46,
  harpsichord: 6,
  'bass-acoustic': 32,
  'bass-fingered': 33,
  'bass-picked': 34,
  'bass-fretless': 35,
  'bass-slap': 36,
  marimba: 12,
  glass: 9,
  organ: 16,
  'drum-kit': 0,
  'acoustic-piano': 0,
  'church-organ': 19,
  'church-flute': 19,
  'church-bourdon': 19,
  'church-trumpet': 19,
  violin: 40,
  viola: 41,
  cello: 42,
  contrabass: 43,
  clarinet: 71,
  'soprano-sax': 64,
  'alto-sax': 65,
  'tenor-sax': 66,
  'baritone-sax': 67,
  oboe: 68,
  'english-horn': 69,
  bassoon: 70,
  trumpet: 56,
  trombone: 57,
  tuba: 58,
  'french-horn': 60,
  'muted-trumpet': 59,
  cornet: 56,
  flugelhorn: 56,
  euphonium: 57,
  'concert-flute': 73,
  piccolo: 72,
  recorder: 74,
  'pan-flute': 75,
  shakuhachi: 77,
  'tin-whistle': 78,
  ocarina: 79,
  'blown-bottle': 76,
  'harp-plucked': 46,
  koto: 107,
  sitar: 104,
  tanpura: 104,
  'choir-aah': 52,
  'choir-ooh': 53,
  'voice-eeh': 54,
  accordion: 21,
  harmonica: 22,
  bandoneon: 23,
  'reed-organ': 20,
};

/** Instrument variant: an editable NativeSynth patch (possibly preset-based). */
export interface SynthPatchInstrument {
  kind: 'synth-patch';
  /** NativeSynth patch; numeric 0/omitted fields keep the base preset value. */
  patch: StoredSynthPatch;
}

/** One channel's program in a multi-timbral SF2 (GM/GS module) map. */
export interface Sf2ChannelProgram {
  /** MIDI channel (0-15; 9 = GM percussion). */
  channel: number;
  /** MIDI bank number (0-16383, MSB*128+LSB); omitted = bank 0. */
  bank?: number;
  /** MIDI program number (0-127); omitted = program 0. */
  program?: number;
}

/** How GS insertion-effect SysEx is realised by the SF2 player. */
export type Sf2EfxRealization = 'modern' | 'classic';

/** Instrument variant: a stored SoundFont (SF2) with optional program select. */
export interface Sf2Instrument {
  kind: 'sf2';
  /** SoundFont id in the font store (src/project/fonts.ts). */
  fontId: string;
  /** MIDI bank number (0-16383, MSB*128+LSB); omitted = bank 0. */
  bank?: number;
  /** MIDI program number (0-127); omitted = program 0. */
  program?: number;
  /** Linear master output gain (>= 0); omitted = engine default (0.5). */
  gain?: number;
  /** Max simultaneous voices (integer in [1, 64]); omitted = engine default (48). */
  polyphony?: number;
  /**
   * Per-channel program map for multi-timbral (GM/GS module) rendering. When
   * present, each listed channel receives its own bank-select + program-change
   * prelude; channels absent from the map fall back to the track-level
   * bank/program. Channel 9 (GM percussion) selects a drum/SFX kit via its bank
   * (GM2 uses bank MSB 120 with the kit in the LSB).
   */
  channelMap?: Sf2ChannelProgram[];
  /**
   * Render melodic GM programs the engine models physically through those
   * models instead of the SoundFont's samples; drums stay SF2-first either
   * way. Omitted = the engine default (SoundFont everywhere).
   *
   * This belongs to the instrument rather than to an app preference: it
   * changes rendered audio, so the same project has to make the same choice
   * on another machine, and the freeze/prerender cache keys off the
   * instrument (see {@link instrumentCacheSegment}).
   */
  preferModelForModeledFamilies?: boolean;
  /**
   * GS insertion-effect realisation. Omitted and 'modern' use libsonare's
   * current effect models; 'classic' uses the classic GS effect models.
   *
   * The modern value is intentionally omitted from saved selections and
   * playback configs so projects retain the engine default as their canonical
   * representation.
   */
  gsEfxRealization?: Sf2EfxRealization;
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
export const DEFAULT_SYNTH_PRESET = 'acoustic-piano';

/** Builds the default instrument (the {@link DEFAULT_SYNTH_PRESET} synth preset). */
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

/**
 * Continuous NativeSynth patch fields the engine drives from an automation
 * lane at audio-block precision. Structural fields (engine mode, waveform,
 * unison, polyphony, body, routings) swap DSP topology and are not
 * automatable.
 */
export const AUTOMATABLE_SYNTH_PARAMS = [
  'gain',
  'busDrive',
  'cutoffHz',
  'resonanceQ',
  'drive',
  'keyTrack',
  'envToCutoffCents',
  'velToCutoffCents',
  'ampAttackMs',
  'ampDecayMs',
  'ampSustain',
  'ampReleaseMs',
  'filterAttackMs',
  'filterDecayMs',
  'filterSustain',
  'filterReleaseMs',
  'lfoRateHz',
  'lfoToPitchCents',
  'lfo2RateHz',
  'glideMs',
  'bodyMix',
  'stereoSpread',
  'detuneCents',
  'driftCents',
  'pitchOffsetCents',
  'hpCutoffHz',
  'sampleHoldHz',
  'bitDepth',
  'driftRateHz',
  'ampDelayMs',
  'ampHoldMs',
  'filterDelayMs',
  'filterHoldMs',
] as const;

/** One continuous NativeSynth patch field an automation lane can drive. */
export type AutomatableSynthParam = (typeof AUTOMATABLE_SYNTH_PARAMS)[number];

/**
 * Automatable fields that reach voices already sounding. The rest are read
 * into each voice at note-on, so a lane moving them takes effect from the next
 * note (delay and hold apply when their envelope stage next starts).
 */
const SOUNDING_VOICE_SYNTH_PARAMS: ReadonlySet<string> = new Set([
  'gain',
  'busDrive',
  'cutoffHz',
  'resonanceQ',
  'envToCutoffCents',
  'lfoToPitchCents',
  'pitchOffsetCents',
]);

/** True for a NativeSynth patch field an automation lane can drive. */
export function isAutomatableSynthParam(name: string): name is AutomatableSynthParam {
  return (AUTOMATABLE_SYNTH_PARAMS as readonly string[]).includes(name);
}

/** True when a lane on this field moves voices that are already sounding. */
export function synthParamReachesSoundingVoices(name: string): boolean {
  return SOUNDING_VOICE_SYNTH_PARAMS.has(name);
}

/** True for an instrument the engine hosts as a NativeSynth (preset or patch). */
export function isNativeSynthInstrument(
  instrument: TrackInstrument,
): instrument is SynthPresetInstrument | SynthPatchInstrument {
  return instrument.kind === 'synth-preset' || instrument.kind === 'synth-patch';
}

/** Identity suffix for the optional NativeSynth GM program mode. */
function synthPresetGmIdentitySuffix(instrument: SynthPresetInstrument): string {
  if (instrument.useGmPrograms !== true) return '';
  return `:gm=1:${instrument.gmBank ?? -1}:${instrument.gmProgram ?? -1}`;
}

/** Identity suffix for the non-default GS EFX realisation. */
function sf2EfxIdentitySuffix(instrument: Sf2Instrument): string {
  return instrument.gsEfxRealization === 'classic' ? ':efx=classic' : '';
}

/**
 * A stable key identifying an instrument for destination de-duplication: two
 * tracks whose instruments produce the same key can share one engine playback
 * destination. Used by the MIDI sync (to pack tracks onto the limited internal
 * instrument destinations) and by the project-capacity check that mirrors it.
 */
export function instrumentDedupeKey(instrument: TrackInstrument): string {
  switch (instrument.kind) {
    case 'synth-preset':
      return `synth-preset:${instrument.preset}${synthPresetGmIdentitySuffix(instrument)}`;
    case 'synth-patch':
      return `synth-patch:${JSON.stringify(instrument.patch)}`;
    case 'sf2': {
      const channelMap =
        instrument.channelMap && instrument.channelMap.length > 0
          ? `:cm=${instrument.channelMap
              .map((c) => `${c.channel}/${c.bank ?? -1}/${c.program ?? -1}`)
              .sort()
              .join(',')}`
          : '';
      return `sf2:${instrument.fontId}:${instrument.bank ?? 'bank-default'}:${
        instrument.program ?? 'program-default'
      }:gain=${instrument.gain ?? 'gain-default'}:polyphony=${instrument.polyphony ?? 'polyphony-default'}:model=${instrument.preferModelForModeledFamilies === true ? 1 : 0}${sf2EfxIdentitySuffix(instrument)}${channelMap}`;
    }
    case 'external-midi':
      return `external-midi:${instrument.outputPortId}:ch${instrument.channel + 1}`;
    default: {
      const exhaustive: never = instrument;
      return JSON.stringify(exhaustive);
    }
  }
}

/** Deep-copies an instrument (instruments are plain JSON data). */
export function cloneInstrument(instrument: TrackInstrument): TrackInstrument {
  return JSON.parse(JSON.stringify(instrument)) as TrackInstrument;
}

/**
 * Deep-copies a persisted instrument, rewriting retired enum spellings to the
 * names the engine catalog reports so editor selects find their option.
 *
 * @param instrument Instrument read from a document or track preset.
 * @returns A fresh instrument in current spelling.
 */
export function loadInstrument(instrument: TrackInstrument): TrackInstrument {
  const out = cloneInstrument(instrument);
  // The engine still accepts 'moog-ladder' but reports 'transistor-ladder'.
  if (out.kind === 'synth-patch' && (out.patch.filterModel as string) === 'moog-ladder') {
    out.patch.filterModel = 'transistor-ladder';
  }
  return out;
}

/** Structural equality on instruments (field order insensitive). */
export function instrumentEquals(a: TrackInstrument, b: TrackInstrument): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** True when the instrument is exactly the default synth preset. */
export function isDefaultInstrument(instrument: TrackInstrument): boolean {
  return instrument.kind === 'synth-preset' && instrument.preset === DEFAULT_SYNTH_PRESET;
}

/** Throws RangeError unless engine params are absent or a record of finite numbers. */
function validateEngineParams(params: unknown): void {
  if (params === undefined) return;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new RangeError('Synth patch engineParams must be an object when present');
  }
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RangeError(`Synth patch engineParams.${key} must be a finite number`);
    }
  }
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
      if (instrument.useGmPrograms !== undefined && typeof instrument.useGmPrograms !== 'boolean') {
        throw new RangeError('Synth preset useGmPrograms must be a boolean when present');
      }
      if (
        instrument.gmBank !== undefined &&
        (!Number.isInteger(instrument.gmBank) || instrument.gmBank < 0 || instrument.gmBank > 16383)
      ) {
        throw new RangeError('Synth preset gmBank must be an integer in [0, 16383]');
      }
      if (
        instrument.gmProgram !== undefined &&
        (!Number.isInteger(instrument.gmProgram) ||
          instrument.gmProgram < 0 ||
          instrument.gmProgram > 127)
      ) {
        throw new RangeError('Synth preset gmProgram must be an integer in [0, 127]');
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
      if (instrument.patch.oneShot !== undefined && typeof instrument.patch.oneShot !== 'boolean') {
        throw new RangeError('Synth patch oneShot must be a boolean when present');
      }
      if (
        instrument.patch.gain !== undefined &&
        (!Number.isFinite(instrument.patch.gain) ||
          instrument.patch.gain < 0 ||
          instrument.patch.gain > 4)
      ) {
        throw new RangeError('Synth patch gain must be a finite number in [0, 4] when present');
      }
      validateEngineParams(instrument.patch.engineParams);
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
      if (instrument.channelMap !== undefined) {
        if (!Array.isArray(instrument.channelMap)) {
          throw new RangeError('SF2 channelMap must be an array when present');
        }
        const seenChannels = new Set<number>();
        for (const entry of instrument.channelMap) {
          if (!Number.isInteger(entry.channel) || entry.channel < 0 || entry.channel > 15) {
            throw new RangeError(
              `SF2 channelMap channel must be an integer in [0, 15], got ${entry.channel}`,
            );
          }
          if (seenChannels.has(entry.channel)) {
            throw new RangeError(
              `SF2 channelMap has a duplicate entry for channel ${entry.channel}`,
            );
          }
          seenChannels.add(entry.channel);
          if (
            entry.bank !== undefined &&
            (!Number.isInteger(entry.bank) || entry.bank < 0 || entry.bank > 16383)
          ) {
            throw new RangeError(
              `SF2 channelMap bank must be an integer in [0, 16383], got ${entry.bank}`,
            );
          }
          if (
            entry.program !== undefined &&
            (!Number.isInteger(entry.program) || entry.program < 0 || entry.program > 127)
          ) {
            throw new RangeError(
              `SF2 channelMap program must be an integer in [0, 127], got ${entry.program}`,
            );
          }
        }
      }
      const { gain, polyphony } = instrument;
      // Zero is a valid value meaning mute: the UI min is 0, the model accepts
      // it, and sf2PlaybackConfig maps it to the engine's smallest gain. Only
      // negative or non-finite values are rejected.
      if (gain !== undefined && (!Number.isFinite(gain) || gain < 0)) {
        throw new RangeError(`SF2 gain must be a non-negative number, got ${gain}`);
      }
      if (
        polyphony !== undefined &&
        (!Number.isInteger(polyphony) || polyphony < 1 || polyphony > 64)
      ) {
        throw new RangeError(`SF2 polyphony must be an integer in [1, 64], got ${polyphony}`);
      }
      if (
        instrument.preferModelForModeledFamilies !== undefined &&
        typeof instrument.preferModelForModeledFamilies !== 'boolean'
      ) {
        throw new RangeError('SF2 preferModelForModeledFamilies must be a boolean when present');
      }
      if (
        instrument.gsEfxRealization !== undefined &&
        instrument.gsEfxRealization !== 'modern' &&
        instrument.gsEfxRealization !== 'classic'
      ) {
        throw new RangeError(
          `SF2 gsEfxRealization must be 'modern' or 'classic', got ${String(instrument.gsEfxRealization)}`,
        );
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
 * matches the historical `preset=<name>` cache-key segment when GM mode is
 * disabled; GM mode appends its initial bank/program selection.
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
  preferModelForModeledFamilies?: boolean;
  gsEfxRealization?: Sf2EfxRealization;
} {
  const config: {
    gain?: number;
    polyphony?: number;
    preferModelForModeledFamilies?: boolean;
    gsEfxRealization?: Sf2EfxRealization;
  } = {};
  if (instrument.gain !== undefined) config.gain = instrument.gain;
  if (instrument.polyphony !== undefined) config.polyphony = instrument.polyphony;
  if (instrument.preferModelForModeledFamilies === true) {
    config.preferModelForModeledFamilies = true;
  }
  if (instrument.gsEfxRealization === 'classic') {
    config.gsEfxRealization = 'classic';
  }
  return config;
}

/**
 * Resolves the effective bank/program an SF2 instrument plays on a MIDI
 * channel: the {@link Sf2Instrument.channelMap} entry for that channel when it
 * sets anything, otherwise the track-level bank/program. Returns null when
 * neither the map nor the track selects a program for the channel, so the
 * caller emits no bank-select/program-change prelude and the engine keeps its
 * default (program 0, bank 0).
 *
 * @param instrument SF2 instrument to read.
 * @param channel MIDI channel (0-15).
 */
export function sf2ChannelProgram(
  instrument: Sf2Instrument,
  channel: number,
): { bank?: number; program?: number } | null {
  const mapped = instrument.channelMap?.find((entry) => entry.channel === channel);
  if (mapped && (mapped.bank !== undefined || mapped.program !== undefined)) {
    return { bank: mapped.bank, program: mapped.program };
  }
  if (instrument.bank !== undefined || instrument.program !== undefined) {
    return { bank: instrument.bank, program: instrument.program };
  }
  return null;
}

export function instrumentCacheSegment(instrument: TrackInstrument): string {
  switch (instrument.kind) {
    case 'synth-preset':
      return `preset=${encodeURIComponent(instrument.preset)}${synthPresetGmIdentitySuffix(instrument)}`;
    case 'synth-patch':
      return `patch=${fnv1a32Hex(canonicalJson(instrument.patch))}`;
    case 'sf2': {
      const channelMap =
        instrument.channelMap && instrument.channelMap.length > 0
          ? `:cm=${instrument.channelMap
              .map((c) => `${c.channel}/${c.bank ?? -1}/${c.program ?? -1}`)
              .sort()
              .join(',')}`
          : '';
      // The model preference changes the rendered timbre, so a cached bounce
      // taken with the other setting must not be reused.
      const model = instrument.preferModelForModeledFamilies === true ? ':model=1' : '';
      return `sf2=${encodeURIComponent(instrument.fontId)}:${instrument.bank ?? -1}:${
        instrument.program ?? -1
      }:${instrument.gain ?? -1}:${instrument.polyphony ?? -1}${channelMap}${model}${sf2EfxIdentitySuffix(instrument)}`;
    }
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
