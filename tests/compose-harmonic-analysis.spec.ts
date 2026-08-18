import type { KeyScale } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { analyzeHarmony } from '@/compose/harmonic-analysis';
import type { EditorChordSymbol } from '@/project/chords';
import { MAJOR_MODE_MASK } from '@/project/types';

/** Editor quality ordinals used by the progressions below. */
const MAJOR = 0;
const MINOR = 1;
const DOM7 = 4;
const MAJ7 = 5;
const MIN7 = 6;

/** Natural-minor interval mask (the parallel mode of the major scale). */
const MINOR_MODE_MASK = 0b0101_1010_1101;

const C_MAJOR: KeyScale = { rootPc: 0, modeMask12: MAJOR_MODE_MASK };
/** C natural minor: the parallel mode of C major. */
const C_MINOR: KeyScale = { rootPc: 0, modeMask12: MINOR_MODE_MASK };
const A_MINOR: KeyScale = { rootPc: 9, modeMask12: MINOR_MODE_MASK };
const E_FLAT_MAJOR: KeyScale = { rootPc: 3, modeMask12: MAJOR_MODE_MASK };

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
    expect(analysis.keySpans).toEqual([]);
  });

  it('reads a progression that stays in one key entirely in the declared key', () => {
    const analysis = analyzeHarmony(
      progression([
        [0, MAJOR],
        [5, MINOR],
        [2, DOM7],
        [7, MAJOR],
        [0, MAJOR],
      ]),
      C_MAJOR,
    );
    expect(analysis.keySpans).toEqual([]);
    expect([...analysis.byStartPpq]).toEqual([
      [4, { borrowed: 'parallelMinor' }],
      [8, { appliedRoman: 'V7/V' }],
    ]);
    expect(analysis.cadences).toEqual([
      { atPpq: 12, type: 'half' },
      { atPpq: 16, type: 'authentic' },
    ]);
  });

  it('keeps the declared key when detection reads the whole track as another one', () => {
    // An Aeolian progression detects as its relative major; the declared key is
    // what the user wrote, so nothing here may be read in C major (where E
    // would be an applied V/vi and E-to-Am no cadence at all).
    const aeolian = progression([
      [9, MINOR],
      [5, MAJOR],
      [7, MAJOR],
      [4, MAJOR],
      [9, MINOR],
      [5, MAJOR],
      [7, MAJOR],
      [4, MAJOR],
    ]);
    const analysis = analyzeHarmony(aeolian, A_MINOR);
    expect(analysis.keySpans).toEqual([]);
    expect(analysis.byStartPpq.size).toBe(0);
    expect(analysis.cadences).toContainEqual({ atPpq: 16, type: 'authentic' });
  });

  it('reads the chords after a modulation in the key they modulate to', () => {
    // ii-V-I in C, then ii-V-I in Eb.
    const analysis = analyzeHarmony(
      progression([
        [2, MIN7],
        [7, DOM7],
        [0, MAJ7],
        [0, MAJ7],
        [5, MIN7],
        [10, DOM7],
        [3, MAJ7],
        [3, MAJ7],
      ]),
      C_MAJOR,
    );
    expect(analysis.keySpans).toEqual([
      { startPpq: 0, endPpq: 16, key: C_MAJOR },
      // C major and E flat major share no diatonic triad, so there was nothing
      // to turn the move on: an empty list is the reading "this move is direct",
      // not a reading that failed.
      { startPpq: 16, endPpq: 32, key: E_FLAT_MAJOR, sharedChords: [] },
    ]);
    // Ebmaj7 is the tonic of the second span: it is what the authentic cadence
    // there resolves onto, and it carries none of the annotations it would as
    // the borrowed bIII of C major.
    expect(analysis.cadences).toEqual([
      { atPpq: 4, type: 'half' },
      { atPpq: 8, type: 'authentic' },
      { atPpq: 20, type: 'half' },
      { atPpq: 24, type: 'authentic' },
    ]);
    expect(analysis.byStartPpq.get(24)).toBeUndefined();
    // The same chords read in C major throughout: borrowed, and no cadence.
    const inC = analyzeHarmony(
      progression([
        [5, MIN7],
        [10, DOM7],
        [3, MAJ7],
        [3, MAJ7],
      ]),
      C_MAJOR,
    );
    expect(inC.byStartPpq.get(8)?.borrowed).toBe('parallelMinor');
    expect(inC.cadences).toEqual([]);
  });

  it('reads the same chord differently on either side of a modulation', () => {
    // F minor twice: borrowed from the parallel minor in C, plain ii in Eb.
    const analysis = analyzeHarmony(
      progression([
        [0, MAJ7],
        [5, MINOR],
        [7, DOM7],
        [0, MAJ7],
        [5, MIN7],
        [10, DOM7],
        [3, MAJ7],
        [5, MINOR],
        [10, DOM7],
        [3, MAJ7],
      ]),
      C_MAJOR,
    );
    expect(analysis.keySpans.map((span) => span.key)).toEqual([C_MAJOR, E_FLAT_MAJOR]);
    expect(analysis.byStartPpq.get(4)?.borrowed).toBe('parallelMinor');
    expect(analysis.byStartPpq.get(28)).toBeUndefined();
  });

  it('carries the relation and pivot of a modulation to a related key', () => {
    // ii-V-I in C, then ii-V-I in G: C major is I there and IV in the new key.
    const analysis = analyzeHarmony(
      progression([
        [2, MIN7],
        [7, DOM7],
        [0, MAJ7],
        [0, MAJ7],
        [9, MIN7],
        [2, DOM7],
        [7, MAJ7],
        [7, MAJ7],
      ]),
      C_MAJOR,
    );
    expect(analysis.keySpans[1]?.modulation).toBe('dominant');
    expect(analysis.keySpans[1]?.pivot?.romanFrom).toBe('I');
    expect(analysis.keySpans[1]?.pivot?.romanTo).toBe('IV');
    expect(analysis.keySpans[0]?.modulation).toBeUndefined();

    // Every chord that reads in both keys, so the move the piece made can be
    // held against the ones it could have made. The chord it did turn on is one
    // of them, since it reads in both keys by definition.
    const shared = analysis.keySpans[1]?.sharedChords ?? [];
    expect(shared.map((pivot) => `${pivot.romanFrom}=${pivot.romanTo}`)).toEqual([
      'I=IV',
      'iii=vi',
      'V=I',
      'vi=ii',
    ]);
    // The opening span was not moved into, so it has nothing to compare.
    expect(analysis.keySpans[0]?.sharedChords).toBeUndefined();
  });
});
