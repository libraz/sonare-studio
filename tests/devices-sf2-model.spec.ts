import { describe, expect, it } from 'vitest';
import {
  buildSf2Instrument,
  clampBank,
  clampGain,
  clampPolyphony,
  clampProgram,
  createSf2Selection,
  MAX_SF2_BANK,
  MAX_SF2_GAIN,
  MAX_SF2_POLYPHONY,
  MAX_SF2_PROGRAM,
  MIN_SF2_POLYPHONY,
  SF2_DEFAULT_GAIN,
  SF2_DEFAULT_POLYPHONY,
} from '@/ui/devices/sf2-model';

/** Empty selection with both numeric extras at their engine defaults. */
const EMPTY = {
  fontId: null,
  bank: 0,
  program: 0,
  gain: SF2_DEFAULT_GAIN,
  polyphony: SF2_DEFAULT_POLYPHONY,
};

describe('clampBank / clampProgram', () => {
  it('clamps to the MIDI ranges and rounds to integers', () => {
    expect(clampBank(-5)).toBe(0);
    expect(clampBank(20000)).toBe(MAX_SF2_BANK);
    expect(clampBank(3.6)).toBe(4);
    expect(clampProgram(-1)).toBe(0);
    expect(clampProgram(500)).toBe(MAX_SF2_PROGRAM);
    expect(clampProgram(12.2)).toBe(12);
  });

  it('degrades non-finite input to 0', () => {
    expect(clampBank(Number.NaN)).toBe(0);
    expect(clampProgram(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('clampGain / clampPolyphony', () => {
  it('clamps gain to the linear range, keeping fractional values', () => {
    expect(clampGain(-2)).toBe(0);
    expect(clampGain(99)).toBe(MAX_SF2_GAIN);
    expect(clampGain(1.25)).toBe(1.25);
    expect(clampGain(Number.NaN)).toBe(SF2_DEFAULT_GAIN);
  });

  it('clamps polyphony to an integer voice cap', () => {
    expect(clampPolyphony(0)).toBe(MIN_SF2_POLYPHONY);
    expect(clampPolyphony(999)).toBe(MAX_SF2_POLYPHONY);
    expect(clampPolyphony(23.6)).toBe(24);
    expect(clampPolyphony(Number.NaN)).toBe(SF2_DEFAULT_POLYPHONY);
  });
});

describe('createSf2Selection', () => {
  it('starts empty for non-sf2 instruments', () => {
    expect(createSf2Selection(null)).toEqual(EMPTY);
    expect(createSf2Selection({ kind: 'synth-preset', preset: 'e-piano' })).toEqual(EMPTY);
  });

  it('restores font, bank, program, gain and polyphony from an sf2 instrument', () => {
    expect(
      createSf2Selection({
        kind: 'sf2',
        fontId: 'abc123',
        bank: 128,
        program: 35,
        gain: 1.5,
        polyphony: 24,
      }),
    ).toEqual({ fontId: 'abc123', bank: 128, program: 35, gain: 1.5, polyphony: 24 });
  });

  it('defaults omitted bank/program/gain/polyphony to their engine defaults', () => {
    expect(createSf2Selection({ kind: 'sf2', fontId: 'abc123' })).toEqual({
      fontId: 'abc123',
      bank: 0,
      program: 0,
      gain: SF2_DEFAULT_GAIN,
      polyphony: SF2_DEFAULT_POLYPHONY,
    });
  });
});

describe('buildSf2Instrument', () => {
  it('returns null without a selected font', () => {
    expect(buildSf2Instrument({ ...EMPTY, fontId: null, program: 5 })).toBeNull();
    expect(buildSf2Instrument({ ...EMPTY, fontId: '', program: 5 })).toBeNull();
  });

  it('omits bank/program/gain/polyphony at their engine defaults', () => {
    expect(buildSf2Instrument({ ...EMPTY, fontId: 'abc' })).toEqual({
      kind: 'sf2',
      fontId: 'abc',
    });
  });

  it('carries explicit bank/program selections, clamped', () => {
    expect(buildSf2Instrument({ ...EMPTY, fontId: 'abc', bank: 99999, program: 12 })).toEqual({
      kind: 'sf2',
      fontId: 'abc',
      bank: MAX_SF2_BANK,
      program: 12,
    });
  });

  it('carries explicit gain and polyphony, clamped, and drops zero gain', () => {
    expect(buildSf2Instrument({ ...EMPTY, fontId: 'abc', gain: 1.25, polyphony: 16 })).toEqual({
      kind: 'sf2',
      fontId: 'abc',
      gain: 1.25,
      polyphony: 16,
    });
    expect(buildSf2Instrument({ ...EMPTY, fontId: 'abc', gain: 99, polyphony: 999 })).toEqual({
      kind: 'sf2',
      fontId: 'abc',
      gain: MAX_SF2_GAIN,
      polyphony: MAX_SF2_POLYPHONY,
    });
    // Gain 0 maps to the engine default too, so it is not persisted.
    expect(buildSf2Instrument({ ...EMPTY, fontId: 'abc', gain: 0 })).toEqual({
      kind: 'sf2',
      fontId: 'abc',
    });
  });
});
