/**
 * Selection model of the SF2 tab in the instrument picker: a stored font plus
 * a MIDI bank/program choice, convertible to the 'sf2' TrackInstrument
 * variant.
 */

import type { Sf2Instrument, TrackInstrument } from '@/project/instrument';

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
    };
  }
  return {
    fontId: null,
    bank: 0,
    program: 0,
    gain: SF2_DEFAULT_GAIN,
    polyphony: SF2_DEFAULT_POLYPHONY,
  };
}

/**
 * Builds the 'sf2' instrument a selection describes. Bank, program, gain and
 * polyphony are omitted at their engine defaults, keeping default selections
 * minimal in project documents and preserving the engine's own fallbacks.
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
  // gain 0 maps to the engine default too, so only a distinct positive gain is
  // worth persisting.
  if (gain > 0 && gain !== SF2_DEFAULT_GAIN) instrument.gain = gain;
  if (polyphony !== SF2_DEFAULT_POLYPHONY) instrument.polyphony = polyphony;
  return instrument;
}
