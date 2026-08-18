import { describe, expect, it } from 'vitest';
import {
  KEY_MODE_CHOICES,
  keyFifthsForScaleHighlight,
  keyLabel,
  matchModeChoiceId,
  modeMaskForChoice,
  modeOrdinalForChoice,
} from '@/components/lists/key-modes';
import { keyScaleToKeyFifths } from '@/compose/key';
import { MAJOR_MODE_MASK } from '@/project/types';

/** Builds a 12-bit mask from semitone intervals above the root. */
function maskOf(intervals: number[]): number {
  return intervals.reduce((mask, interval) => mask | (1 << interval), 0);
}

/**
 * Each offered mode is a name into the shared scale vocabulary, so what these
 * pin is that the editor points at the right scale — not how the mask is
 * derived, which is no longer the editor's arithmetic to do.
 */
describe('modeMaskForChoice', () => {
  it('gives each offered mode the intervals that name it', () => {
    expect(modeMaskForChoice('major')).toBe(MAJOR_MODE_MASK);
    expect(modeMaskForChoice('minor')).toBe(maskOf([0, 2, 3, 5, 7, 8, 10]));
    expect(modeMaskForChoice('dorian')).toBe(maskOf([0, 2, 3, 5, 7, 9, 10]));
    expect(modeMaskForChoice('phrygian')).toBe(maskOf([0, 1, 3, 5, 7, 8, 10]));
    expect(modeMaskForChoice('lydian')).toBe(maskOf([0, 2, 4, 6, 7, 9, 11]));
    expect(modeMaskForChoice('mixolydian')).toBe(maskOf([0, 2, 4, 5, 7, 9, 10]));
    expect(modeMaskForChoice('locrian')).toBe(maskOf([0, 1, 3, 5, 6, 8, 10]));
  });

  it('provides harmonic and melodic minor masks with a raised leading tone', () => {
    expect(modeMaskForChoice('harmonicMinor')).toBe(maskOf([0, 2, 3, 5, 7, 8, 11]));
    expect(modeMaskForChoice('melodicMinor')).toBe(maskOf([0, 2, 3, 5, 7, 9, 11]));
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
    expect(modeOrdinalForChoice('harmonicMinor')).toBe(1);
    expect(modeOrdinalForChoice('melodicMinor')).toBe(1);
  });

  it('rejects unknown mode ids for ordinal conversion', () => {
    expect(() => modeOrdinalForChoice('bebop')).toThrow(RangeError);
  });
});

describe('keyFifthsForScaleHighlight', () => {
  it('uses the same signatures as score spelling for diatonic scale highlights', () => {
    expect(
      keyFifthsForScaleHighlight({
        enabled: true,
        rootPc: 10,
        modeMask: modeMaskForChoice('major'),
      }),
    ).toBe(-2);
    expect(
      keyFifthsForScaleHighlight({
        enabled: true,
        rootPc: 4,
        modeMask: modeMaskForChoice('minor'),
      }),
    ).toBe(1);
  });

  it('uses neutral spelling when highlighting is switched off', () => {
    expect(keyFifthsForScaleHighlight({ enabled: false, rootPc: 10, modeMask: 0 })).toBe(0);
  });

  // A custom scale still has a tonic, and the accidentals around it read better
  // against that tonic's signature than against C major's.
  it('signs a custom scale from its tonic', () => {
    expect(keyFifthsForScaleHighlight({ enabled: true, rootPc: 10, modeMask: 1 })).toBe(-2);
  });
});

describe('keyScaleToKeyFifths', () => {
  it('derives E major fifths directly from the KeyScale mask', () => {
    expect(keyScaleToKeyFifths({ rootPc: 4, modeMask12: MAJOR_MODE_MASK })).toBe(4);
  });

  /**
   * The raised seventh of a harmonic minor is an accidental, not part of the
   * signature, so the scale signs as its natural minor does. Reading it as C
   * major instead put every accidental in the piece against the wrong ground.
   */
  it('signs harmonic and melodic minor as the minor key they are', () => {
    expect(keyScaleToKeyFifths({ rootPc: 0, modeMask12: modeMaskForChoice('harmonicMinor') })).toBe(
      -3,
    );
    expect(keyScaleToKeyFifths({ rootPc: 0, modeMask12: modeMaskForChoice('melodicMinor') })).toBe(
      -3,
    );
    expect(keyScaleToKeyFifths({ rootPc: 0, modeMask12: modeMaskForChoice('minor') })).toBe(-3);
  });

  it('signs a custom KeyScale mask from its tonic', () => {
    expect(keyScaleToKeyFifths({ rootPc: 4, modeMask12: 1 })).toBe(4);
  });
});

describe('keyLabel', () => {
  const labels = {
    modes: { major: 'Major (Ionian)', minor: 'Minor (Aeolian)' },
    customScale: 'Custom scale',
  };

  it('labels diatonic keys with root and mode', () => {
    expect(keyLabel(0, 'major', labels)).toBe('C Major (Ionian)');
    expect(keyLabel(9, 'minor', labels)).toBe('A Minor (Aeolian)');
  });

  it('labels unmatched masks as custom', () => {
    expect(keyLabel(2, null, labels)).toBe('D Custom scale');
  });
});
