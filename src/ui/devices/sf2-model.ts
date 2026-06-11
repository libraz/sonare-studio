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

/** Editable SF2 selection state. */
export interface Sf2Selection {
  /** Selected font id from the font store, or null when none is chosen. */
  fontId: string | null;
  /** MIDI bank number (integer in [0, 16383]). */
  bank: number;
  /** MIDI program number (integer in [0, 127]). */
  program: number;
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
    };
  }
  return { fontId: null, bank: 0, program: 0 };
}

/**
 * Builds the 'sf2' instrument a selection describes. Bank and program are
 * omitted when 0 (the bounce default), keeping default selections minimal in
 * project documents.
 *
 * @param selection Current selection.
 * @returns The instrument, or null when no font is selected.
 */
export function buildSf2Instrument(selection: Sf2Selection): Sf2Instrument | null {
  if (selection.fontId === null || selection.fontId.length === 0) return null;
  const instrument: Sf2Instrument = { kind: 'sf2', fontId: selection.fontId };
  const bank = clampBank(selection.bank);
  const program = clampProgram(selection.program);
  if (bank !== 0) instrument.bank = bank;
  if (program !== 0) instrument.program = program;
  return instrument;
}
