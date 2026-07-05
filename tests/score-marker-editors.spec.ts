import { describe, expect, it } from 'vitest';
import {
  scoreEditPpq,
  scoreKeyMarkerName,
  scoreLyricMarkerName,
  scoreMeasureStartPpq,
} from '@/ui/score/marker-editors';

describe('score marker editors', () => {
  it('places score edits at the playhead when it is inside the clip', () => {
    expect(scoreEditPpq(9, 8, 16)).toBe(9);
    expect(scoreEditPpq(7.99, 8, 16)).toBe(8);
    expect(scoreEditPpq(24, 8, 16)).toBe(8);
    expect(scoreEditPpq(undefined, 8, 16)).toBe(8);
  });

  it('snaps key changes to the containing measure start', () => {
    expect(scoreMeasureStartPpq(9.5, 8, 4)).toBe(8);
    expect(scoreMeasureStartPpq(12.25, 8, 4)).toBe(12);
    expect(scoreMeasureStartPpq(Number.NaN, 8, 4)).toBe(8);
  });

  it('builds marker names consumed by the score notation pipeline', () => {
    expect(scoreLyricMarkerName('  sing  ')).toBe('Lyric: sing');
    expect(scoreLyricMarkerName('  glo  ', { verse: 2, syllabic: 'begin', extend: true })).toBe(
      'Lyric 2: begin: glo~',
    );
    expect(scoreLyricMarkerName('ria', { verse: 2, syllabic: 'end' })).toBe('Lyric 2: end: ria');
    expect(scoreKeyMarkerName('Bb', 'minor')).toBe('Key: Bb minor');
    expect(() => scoreLyricMarkerName('   ')).toThrow(RangeError);
    expect(() => scoreLyricMarkerName('x', { verse: 0 })).toThrow(RangeError);
    expect(() => scoreLyricMarkerName('x', { syllabic: 'bad' as never })).toThrow(RangeError);
    expect(() => scoreKeyMarkerName('H' as never, 'major')).toThrow(RangeError);
  });
});
