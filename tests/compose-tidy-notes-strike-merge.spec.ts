import { describe, expect, it } from 'vitest';
import { type TidyNote, tidyNotes } from '@/compose/tidy-notes';
import type { TimeSignatureSegment } from '@/project/types';

const FOUR_FOUR: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 4, denominator: 4 }];

function tidy(notes: TidyNote[]): TidyNote[] {
  return tidyNotes(notes, { gridPpq: 0.25, timeSignatures: FOUR_FOUR });
}

describe('tidyNotes duplicate strikes', () => {
  const loudShort: TidyNote = { pitch: 60, startPpq: 0, durationPpq: 1, velocity: 110 };
  const softLong: TidyNote = { pitch: 60, startPpq: 0, durationPpq: 2, velocity: 60 };

  it('merge to the louder strike over the longer span in either input order', () => {
    for (const order of [
      [loudShort, softLong],
      [softLong, loudShort],
    ]) {
      const result = tidy(order);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ startPpq: 0, durationPpq: 2, velocity: 110 });
    }
  });
});
