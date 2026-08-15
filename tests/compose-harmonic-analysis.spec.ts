import type { KeyScale } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { analyzeHarmony } from '@/compose/harmonic-analysis';
import type { EditorChordSymbol } from '@/project/chords';
import { MAJOR_MODE_MASK } from '@/project/types';

/** Editor quality ordinals used by the progressions below. */
const MAJOR = 0;
const MINOR = 1;
const DOM7 = 4;

const C_MAJOR: KeyScale = { rootPc: 0, modeMask12: MAJOR_MODE_MASK };
/** C natural minor: the parallel mode of C major. */
const C_MINOR: KeyScale = { rootPc: 0, modeMask12: 0b0101_1010_1101 };

/** One chord symbol per bar, in order, each four PPQ long. */
function progression(chords: ReadonlyArray<[number, number]>): EditorChordSymbol[] {
  return chords.map(([rootPc, quality], index) => ({
    startPpq: index * 4,
    endPpq: index * 4 + 4,
    rootPc,
    quality,
  }));
}

describe('analyzeHarmony', () => {
  it('detects an authentic cadence at the tonic arrival', () => {
    const analysis = analyzeHarmony(
      progression([
        [7, MAJOR],
        [0, MAJOR],
      ]),
      C_MAJOR,
    );
    expect(analysis.cadences).toEqual([{ atPpq: 4, type: 'authentic' }]);
  });

  it('detects a plagal cadence from the subdominant', () => {
    const analysis = analyzeHarmony(
      progression([
        [5, MAJOR],
        [0, MAJOR],
      ]),
      C_MAJOR,
    );
    expect(analysis.cadences).toEqual([{ atPpq: 4, type: 'plagal' }]);
  });

  it('detects a half cadence on the dominant', () => {
    const analysis = analyzeHarmony(
      progression([
        [0, MAJOR],
        [7, MAJOR],
      ]),
      C_MAJOR,
    );
    expect(analysis.cadences).toEqual([{ atPpq: 4, type: 'half' }]);
  });

  it('detects a deceptive cadence resolving to the submediant', () => {
    const analysis = analyzeHarmony(
      progression([
        [7, MAJOR],
        [9, MINOR],
      ]),
      C_MAJOR,
    );
    expect(analysis.cadences).toEqual([{ atPpq: 4, type: 'deceptive' }]);
  });

  it('reports the borrowing source of a parallel-minor chord', () => {
    const analysis = analyzeHarmony(progression([[5, MINOR]]), C_MAJOR);
    expect(analysis.byStartPpq.get(0)?.borrowed).toBe('parallelMinor');
  });

  it('reports the borrowing source of a parallel-major chord in a minor key', () => {
    const analysis = analyzeHarmony(progression([[5, MAJOR]]), C_MINOR);
    expect(analysis.byStartPpq.get(0)?.borrowed).toBe('parallelMajor');
  });

  it('reports the Neapolitan as its own source', () => {
    const analysis = analyzeHarmony(progression([[1, MAJOR]]), C_MAJOR);
    expect(analysis.byStartPpq.get(0)?.borrowed).toBe('neapolitan');
  });

  it('names an applied dominant with its slashed numeral', () => {
    const analysis = analyzeHarmony(
      progression([
        [2, DOM7],
        [7, MAJOR],
      ]),
      C_MAJOR,
    );
    expect(analysis.byStartPpq.get(0)?.appliedRoman).toBe('V7/V');
    expect(analysis.byStartPpq.get(0)?.borrowed).toBeUndefined();
  });

  it('annotates a repeated chord identically at every position', () => {
    const analysis = analyzeHarmony(
      progression([
        [5, MINOR],
        [0, MAJOR],
        [5, MINOR],
      ]),
      C_MAJOR,
    );
    expect(analysis.byStartPpq.get(0)).toEqual(analysis.byStartPpq.get(8));
  });

  it('leaves a plain diatonic progression unannotated', () => {
    const analysis = analyzeHarmony(
      progression([
        [0, MAJOR],
        [9, MINOR],
        [2, MINOR],
      ]),
      C_MAJOR,
    );
    expect(analysis.byStartPpq.size).toBe(0);
    expect(analysis.cadences).toEqual([]);
  });

  it('skips symbols the library cannot read instead of throwing', () => {
    const symbols: EditorChordSymbol[] = [
      { startPpq: 0, endPpq: 4, rootPc: Number.NaN, quality: MAJOR },
      { startPpq: 4, endPpq: 8, rootPc: 5, quality: MINOR },
    ];
    const analysis = analyzeHarmony(symbols, C_MAJOR);
    expect(analysis.byStartPpq.has(0)).toBe(false);
    expect(analysis.byStartPpq.get(4)?.borrowed).toBe('parallelMinor');
  });

  it('degrades to no annotations on a malformed key', () => {
    const analysis = analyzeHarmony(
      progression([
        [7, MAJOR],
        [0, MAJOR],
      ]),
      { rootPc: Number.NaN, modeMask12: Number.NaN },
    );
    expect(analysis.byStartPpq.size).toBe(0);
    expect(analysis.cadences).toEqual([]);
  });

  it('returns an empty analysis for an empty chord track', () => {
    const analysis = analyzeHarmony([], C_MAJOR);
    expect(analysis.byStartPpq.size).toBe(0);
    expect(analysis.cadences).toEqual([]);
  });
});
