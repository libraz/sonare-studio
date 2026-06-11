import { describe, expect, it } from 'vitest';
import {
  buildSf2Instrument,
  clampBank,
  clampProgram,
  createSf2Selection,
  MAX_SF2_BANK,
  MAX_SF2_PROGRAM,
} from '@/ui/devices/sf2-model';

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

describe('createSf2Selection', () => {
  it('starts empty for non-sf2 instruments', () => {
    expect(createSf2Selection(null)).toEqual({ fontId: null, bank: 0, program: 0 });
    expect(createSf2Selection({ kind: 'synth-preset', preset: 'e-piano' })).toEqual({
      fontId: null,
      bank: 0,
      program: 0,
    });
  });

  it('restores font, bank and program from an sf2 instrument', () => {
    expect(createSf2Selection({ kind: 'sf2', fontId: 'abc123', bank: 128, program: 35 })).toEqual({
      fontId: 'abc123',
      bank: 128,
      program: 35,
    });
  });

  it('defaults omitted bank/program to 0', () => {
    expect(createSf2Selection({ kind: 'sf2', fontId: 'abc123' })).toEqual({
      fontId: 'abc123',
      bank: 0,
      program: 0,
    });
  });
});

describe('buildSf2Instrument', () => {
  it('returns null without a selected font', () => {
    expect(buildSf2Instrument({ fontId: null, bank: 0, program: 5 })).toBeNull();
    expect(buildSf2Instrument({ fontId: '', bank: 0, program: 5 })).toBeNull();
  });

  it('omits bank and program when 0 (the bounce defaults)', () => {
    expect(buildSf2Instrument({ fontId: 'abc', bank: 0, program: 0 })).toEqual({
      kind: 'sf2',
      fontId: 'abc',
    });
  });

  it('carries explicit bank/program selections, clamped', () => {
    expect(buildSf2Instrument({ fontId: 'abc', bank: 99999, program: 12 })).toEqual({
      kind: 'sf2',
      fontId: 'abc',
      bank: MAX_SF2_BANK,
      program: 12,
    });
  });
});
