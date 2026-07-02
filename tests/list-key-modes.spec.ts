import { describe, expect, it } from 'vitest';
import {
  KEY_MODE_CHOICES,
  keyLabel,
  matchModeChoiceId,
  modeMaskForChoice,
  modeOrdinalForChoice,
  rotateModeMask,
} from '@/components/lists/key-modes';
import { MAJOR_MODE_MASK } from '@/project/types';

/** Builds a 12-bit mask from semitone intervals above the root. */
function maskOf(intervals: number[]): number {
  return intervals.reduce((mask, interval) => mask | (1 << interval), 0);
}

describe('rotateModeMask', () => {
  it('returns the input for a zero offset', () => {
    expect(rotateModeMask(MAJOR_MODE_MASK, 0)).toBe(MAJOR_MODE_MASK);
  });

  it('derives the natural minor mask from the major mask', () => {
    expect(rotateModeMask(MAJOR_MODE_MASK, 9)).toBe(maskOf([0, 2, 3, 5, 7, 8, 10]));
  });

  it('derives the dorian mask from the major mask', () => {
    expect(rotateModeMask(MAJOR_MODE_MASK, 2)).toBe(maskOf([0, 2, 3, 5, 7, 9, 10]));
  });

  it('normalizes negative offsets', () => {
    expect(rotateModeMask(MAJOR_MODE_MASK, -3)).toBe(rotateModeMask(MAJOR_MODE_MASK, 9));
  });
});

describe('modeMaskForChoice / matchModeChoiceId', () => {
  it('round-trips every diatonic mode', () => {
    for (const choice of KEY_MODE_CHOICES) {
      expect(matchModeChoiceId(modeMaskForChoice(choice.id))).toBe(choice.id);
    }
  });

  it('matches the major mask to the major mode', () => {
    expect(matchModeChoiceId(MAJOR_MODE_MASK)).toBe('major');
  });

  it('returns null for non-diatonic masks', () => {
    expect(matchModeChoiceId(0)).toBeNull();
    expect(matchModeChoiceId(maskOf([0, 3, 6, 9]))).toBeNull();
  });

  it('throws on unknown mode ids', () => {
    expect(() => modeMaskForChoice('bebop')).toThrow(RangeError);
  });

  it('maps mode ids to libsonare mode ordinals', () => {
    expect(modeOrdinalForChoice('major')).toBe(0);
    expect(modeOrdinalForChoice('minor')).toBe(1);
    expect(modeOrdinalForChoice('dorian')).toBe(2);
    expect(modeOrdinalForChoice('phrygian')).toBe(3);
    expect(modeOrdinalForChoice('lydian')).toBe(4);
    expect(modeOrdinalForChoice('mixolydian')).toBe(5);
    expect(modeOrdinalForChoice('locrian')).toBe(6);
  });

  it('rejects unknown mode ids for ordinal conversion', () => {
    expect(() => modeOrdinalForChoice('bebop')).toThrow(RangeError);
  });
});

describe('keyLabel', () => {
  it('labels diatonic keys with root and mode', () => {
    expect(keyLabel(0, 'major')).toBe('C Major (Ionian)');
    expect(keyLabel(9, 'minor')).toBe('A Minor (Aeolian)');
  });

  it('labels unmatched masks as custom', () => {
    expect(keyLabel(2, null)).toBe('D Custom scale');
  });
});
