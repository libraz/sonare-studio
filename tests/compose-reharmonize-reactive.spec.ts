import { describe, expect, it } from 'vitest';
import {
  proposeReactiveReharmonization,
  type ReactiveMelodyNote,
} from '@/compose/reharmonize-reactive';
import type { EditorChordSymbol } from '@/project/chords';
import {
  MAJOR_MODE_MASK,
  type ScaleHighlightConfig,
  type TimeSignatureSegment,
} from '@/project/types';

const C_MAJOR: ScaleHighlightConfig = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
const FOUR_FOUR: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 4, denominator: 4 }];

/** A chord symbol over a PPQ region (quality 0 = major triad). */
function chord(startPpq: number, endPpq: number, rootPc: number, quality = 0): EditorChordSymbol {
  return { startPpq, endPpq, rootPc, quality };
}

/** A whole-bar melody note (a chord-tone arpeggio member). */
function mel(pitch: number, startPpq: number, durationPpq = 1): ReactiveMelodyNote {
  return { pitch, startPpq, durationPpq };
}

/** A C-major arpeggio (C E G) filling the bar starting at `bar` beats. */
function cMajorBar(bar: number): ReactiveMelodyNote[] {
  return [mel(60, bar), mel(64, bar + 1), mel(67, bar + 2), mel(72, bar + 3)];
}

/** A blatant clash with a C chord: a run of semitone-neighbour tones. */
function clashBar(bar: number): ReactiveMelodyNote[] {
  return [mel(61, bar), mel(66, bar + 1), mel(61, bar + 2), mel(66, bar + 3)];
}

describe('proposeReactiveReharmonization', () => {
  it('returns the current progression unchanged for empty inputs', () => {
    const current = [chord(0, 4, 0)];
    const empty = proposeReactiveReharmonization({
      current,
      melody: [],
      editedSpan: { startPpq: 0, endPpq: 4 },
      key: C_MAJOR,
      timeSignatures: FOUR_FOUR,
    });
    expect(empty.changed).toBe(false);
    expect(empty.proposal).toHaveLength(1);
    expect(empty.proposal[0]).toMatchObject({ rootPc: 0 });

    const noChords = proposeReactiveReharmonization({
      current: [],
      melody: cMajorBar(0),
      editedSpan: { startPpq: 0, endPpq: 4 },
      key: C_MAJOR,
      timeSignatures: FOUR_FOUR,
    });
    expect(noChords.changed).toBe(false);
    expect(noChords.proposal).toEqual([]);
  });

  it('keeps a chord that still fits its melody (hysteresis)', () => {
    // A C-major chord under a C-major arpeggio fits perfectly; even though it is
    // in scope, the pass must not disturb it.
    const current = [chord(0, 4, 0)];
    const result = proposeReactiveReharmonization({
      current,
      melody: cMajorBar(0),
      editedSpan: { startPpq: 0, endPpq: 4 },
      key: C_MAJOR,
      timeSignatures: FOUR_FOUR,
    });
    expect(result.changed).toBe(false);
    expect(result.changedIndices).toEqual([]);
    expect(result.proposal[0]).toMatchObject({ rootPc: 0, quality: 0 });
  });

  it('replaces an in-scope chord whose melody no longer fits it', () => {
    // The chord is B major but the melody is a clear C-major arpeggio; B major
    // clashes, so the pass proposes a different chord over that region.
    const current = [chord(0, 4, 11)];
    const result = proposeReactiveReharmonization({
      current,
      melody: cMajorBar(0),
      editedSpan: { startPpq: 0, endPpq: 4 },
      key: C_MAJOR,
      timeSignatures: FOUR_FOUR,
    });
    expect(result.changed).toBe(true);
    expect(result.changedIndices).toEqual([0]);
    expect(result.proposal[0].rootPc).not.toBe(11);
    // The region is preserved; only the chord identity changes.
    expect(result.proposal[0]).toMatchObject({ startPpq: 0, endPpq: 4 });
  });

  it('never changes a locked chord even when its melody clashes', () => {
    const current = [chord(0, 4, 11)];
    const result = proposeReactiveReharmonization({
      current,
      melody: cMajorBar(0),
      editedSpan: { startPpq: 0, endPpq: 4 },
      locked: [{ startPpq: 0, endPpq: 4 }],
      key: C_MAJOR,
      timeSignatures: FOUR_FOUR,
    });
    expect(result.changed).toBe(false);
    expect(result.proposal[0]).toMatchObject({ rootPc: 11 });
  });

  it('leaves chords outside the edited window untouched (local scope)', () => {
    // Three bars, all B major, but only the first bar's region is edited. The
    // third bar is out of the window (edit + one neighbour) and is preserved
    // even though its melody clashes with B major.
    const current = [chord(0, 4, 11), chord(4, 8, 11), chord(8, 12, 11)];
    const melody = [...cMajorBar(0), ...cMajorBar(4), ...cMajorBar(8)];
    const result = proposeReactiveReharmonization({
      current,
      melody,
      editedSpan: { startPpq: 0, endPpq: 2 },
      key: C_MAJOR,
      timeSignatures: FOUR_FOUR,
    });
    // The out-of-window third bar keeps B major regardless of fit.
    expect(result.proposal[2]).toMatchObject({ rootPc: 11 });
    expect(result.changedIndices).not.toContain(2);
    expect(result.proposal).toHaveLength(3);
  });

  it('preserves every region and the track length', () => {
    const current = [chord(0, 4, 11), chord(4, 8, 0)];
    const melody = [...cMajorBar(0), ...clashBar(4)];
    const result = proposeReactiveReharmonization({
      current,
      melody,
      editedSpan: { startPpq: 0, endPpq: 8 },
      key: C_MAJOR,
      timeSignatures: FOUR_FOUR,
    });
    expect(result.proposal).toHaveLength(2);
    expect(result.proposal[0]).toMatchObject({ startPpq: 0, endPpq: 4 });
    expect(result.proposal[1]).toMatchObject({ startPpq: 4, endPpq: 8 });
  });
});
