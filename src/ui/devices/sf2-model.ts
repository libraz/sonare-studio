/**
 * Selection model of the SF2 tab in the instrument picker: a stored font plus
 * a MIDI bank/program choice, convertible to the 'sf2' TrackInstrument
 * variant.
 */

import type {
  Sf2ChannelProgram,
  Sf2EfxRealization,
  Sf2Instrument,
  TrackInstrument,
} from '@/project/instrument';

/** Highest MIDI bank number (MSB * 128 + LSB). */
export const MAX_SF2_BANK = 16383;

/** Highest MIDI program number. */
export const MAX_SF2_PROGRAM = 127;

/** Engine default linear master gain when an SF2 instrument sets none. */
export const SF2_DEFAULT_GAIN = 0.5;

/** Highest linear master gain the picker offers (+12 dB). */
export const MAX_SF2_GAIN = 4;

/** Engine default voice cap when an SF2 instrument sets none. */
export const SF2_DEFAULT_POLYPHONY = 48;

/** Lowest selectable voice cap. */
export const MIN_SF2_POLYPHONY = 1;

/** Highest selectable voice cap (the engine clamps here too). */
export const MAX_SF2_POLYPHONY = 64;

/** Default GS EFX realisation used by libsonare when the field is omitted. */
export const SF2_DEFAULT_EFX_REALIZATION: Sf2EfxRealization = 'modern';

/** Editable SF2 selection state. */
export interface Sf2Selection {
  /** Selected font id from the font store, or null when none is chosen. */
  fontId: string | null;
  /** MIDI bank number (integer in [0, 16383]). */
  bank: number;
  /** MIDI program number (integer in [0, 127]). */
  program: number;
  /** Linear master output gain (in [0, 4]). */
  gain: number;
  /** Max simultaneous voices (integer in [1, 64]). */
  polyphony: number;
  /**
   * Per-channel program overrides for multi-timbral (GM/GS module) rendering.
   * Empty keeps the instrument single-timbral (bank/program apply to every
   * channel the phrase uses).
   */
  channelMap: Sf2ChannelProgram[];
  /**
   * Render melodic GM programs the engine models physically through those
   * models rather than the SoundFont's samples. Drums stay SF2-first.
   */
  preferModel: boolean;
  /** GS insertion-effect SysEx realisation. */
  gsEfxRealization: Sf2EfxRealization;
}

/** GM percussion channel (0-based); channel 10 in 1-based MIDI terms. */
export const SF2_DRUM_CHANNEL = 9;

/** Clamps a raw channel input to a valid MIDI channel (0-15). */
export function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(15, Math.max(0, Math.round(value)));
}

/**
 * Normalizes a channel map: clamps each entry, drops duplicates (last wins),
 * and sorts by channel so the persisted order is stable.
 *
 * @param entries Raw channel-map entries.
 */
export function normalizeChannelMap(
  entries: ReadonlyArray<Sf2ChannelProgram>,
): Sf2ChannelProgram[] {
  const byChannel = new Map<number, Sf2ChannelProgram>();
  for (const entry of entries) {
    const channel = clampChannel(entry.channel);
    const normalized: Sf2ChannelProgram = { channel };
    if (entry.bank !== undefined) normalized.bank = clampBank(entry.bank);
    if (entry.program !== undefined) normalized.program = clampProgram(entry.program);
    byChannel.set(channel, normalized);
  }
  return [...byChannel.values()].sort((a, b) => a.channel - b.channel);
}

/** Clamps a raw bank input to a valid integer bank number. */
export function clampBank(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_SF2_BANK, Math.max(0, Math.round(value)));
}

/** Clamps a raw program input to a valid integer program number. */
export function clampProgram(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_SF2_PROGRAM, Math.max(0, Math.round(value)));
}

/** Clamps a raw gain input to the selectable linear range. */
export function clampGain(value: number): number {
  if (!Number.isFinite(value)) return SF2_DEFAULT_GAIN;
  return Math.min(MAX_SF2_GAIN, Math.max(0, value));
}

/** Clamps a raw polyphony input to a valid integer voice cap. */
export function clampPolyphony(value: number): number {
  if (!Number.isFinite(value)) return SF2_DEFAULT_POLYPHONY;
  return Math.min(MAX_SF2_POLYPHONY, Math.max(MIN_SF2_POLYPHONY, Math.round(value)));
}

/**
 * Seeds the selection from a track instrument: 'sf2' instruments restore
 * their font/bank/program, anything else starts empty at bank 0 / program 0.
 *
 * @param instrument The track's current instrument, if any.
 * @returns A fresh selection.
 */
export function createSf2Selection(instrument?: TrackInstrument | null): Sf2Selection {
  if (instrument?.kind === 'sf2') {
    return {
      fontId: instrument.fontId,
      bank: clampBank(instrument.bank ?? 0),
      program: clampProgram(instrument.program ?? 0),
      gain: clampGain(instrument.gain ?? SF2_DEFAULT_GAIN),
      polyphony: clampPolyphony(instrument.polyphony ?? SF2_DEFAULT_POLYPHONY),
      channelMap: normalizeChannelMap(instrument.channelMap ?? []),
      preferModel: instrument.preferModelForModeledFamilies === true,
      gsEfxRealization:
        instrument.gsEfxRealization === 'classic' ? 'classic' : SF2_DEFAULT_EFX_REALIZATION,
    };
  }
  return {
    fontId: null,
    bank: 0,
    program: 0,
    gain: SF2_DEFAULT_GAIN,
    polyphony: SF2_DEFAULT_POLYPHONY,
    channelMap: [],
    preferModel: false,
    gsEfxRealization: SF2_DEFAULT_EFX_REALIZATION,
  };
}

/**
 * Builds the 'sf2' instrument a selection describes. Bank, program, gain,
 * polyphony and the model preference are omitted at their engine defaults,
 * keeping default selections minimal in project documents and preserving the
 * engine's own fallbacks.
 *
 * @param selection Current selection.
 * @returns The instrument, or null when no font is selected.
 */
export function buildSf2Instrument(selection: Sf2Selection): Sf2Instrument | null {
  if (selection.fontId === null || selection.fontId.length === 0) return null;
  const instrument: Sf2Instrument = { kind: 'sf2', fontId: selection.fontId };
  const bank = clampBank(selection.bank);
  const program = clampProgram(selection.program);
  const gain = clampGain(selection.gain);
  const polyphony = clampPolyphony(selection.polyphony);
  if (bank !== 0) instrument.bank = bank;
  if (program !== 0) instrument.program = program;
  // Persist zero explicitly; sf2PlaybackConfig adapts the engine's reserved
  // zero/default sentinel so UI/model/live/export all retain mute semantics.
  if (gain !== SF2_DEFAULT_GAIN) instrument.gain = gain;
  if (polyphony !== SF2_DEFAULT_POLYPHONY) instrument.polyphony = polyphony;
  const channelMap = normalizeChannelMap(selection.channelMap);
  if (channelMap.length > 0) instrument.channelMap = channelMap;
  if (selection.preferModel) instrument.preferModelForModeledFamilies = true;
  // Modern is the engine default and stays omitted so old and new projects
  // share the same canonical document representation.
  if (selection.gsEfxRealization === 'classic') instrument.gsEfxRealization = 'classic';
  return instrument;
}
