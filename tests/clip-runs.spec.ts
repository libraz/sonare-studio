import { describe, expect, it } from 'vitest';
import { touchingClipRunIds } from '@/project/clip-runs';

const clip = (id: number, startPpq: number, lengthPpq: number) => ({ id, startPpq, lengthPpq });

describe('touchingClipRunIds', () => {
  it('joins clips that touch or overlap and stops at a gap, in start order', () => {
    const clips = [clip(4, 2000, 100), clip(1, 0, 480), clip(3, 900, 200), clip(2, 480, 500)];
    expect(touchingClipRunIds(clips, 3)).toEqual([1, 2, 3]);
    expect(touchingClipRunIds(clips, 4)).toEqual([4]);
  });

  it('treats an end within the tolerance of the next start as touching', () => {
    const clips = [clip(1, 0, 480 - 1e-7), clip(2, 480, 480)];
    expect(touchingClipRunIds(clips, 2)).toEqual([1, 2]);
  });

  it('compares neighbours pairwise, so a gap after a short clip ends the run', () => {
    // Clip 1 reaches past clip 3's start, but its neighbour 2 does not.
    const clips = [clip(1, 0, 2000), clip(2, 100, 100), clip(3, 1000, 100)];
    expect(touchingClipRunIds(clips, 1)).toEqual([1, 2]);
  });

  it('returns nothing for a clip that is not among the candidates', () => {
    expect(touchingClipRunIds([clip(1, 0, 480)], 9)).toEqual([]);
  });
});
