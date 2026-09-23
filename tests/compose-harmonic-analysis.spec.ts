import type { KeyScale } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { analyzeHarmony } from '@/compose/harmonic-analysis';
import { DEFAULT_KEY_SCALE, keyScaleToScaleHighlight } from '@/compose/key';
import { buildKeyMap, type KeyMap } from '@/compose/key-map';
import { keyMarkerName } from '@/compose/key-name';
import type { EditorChordSymbol } from '@/project/chords';
import { type EditorMarker, MAJOR_MODE_MASK } from '@/project/types';

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
const G_MAJOR: KeyScale = { rootPc: 7, modeMask12: MAJOR_MODE_MASK };
const E_FLAT_MAJOR: KeyScale = { rootPc: 3, modeMask12: MAJOR_MODE_MASK };

/** One chord symbol per bar (4 PPQ each), starting at `offsetPpq`. */
function progression(chords: ReadonlyArray<[number, number]>, offsetPpq = 0): EditorChordSymbol[] {
  return chords.map(([rootPc, quality], index) => ({
    startPpq: offsetPpq + index * 4,
    endPpq: offsetPpq + index * 4 + 4,
    rootPc,
    quality,
  }));
}

/** A key map with a single declared region spanning the whole track. */
function singleKeyMap(key: KeyScale): KeyMap {
  return buildKeyMap(keyScaleToScaleHighlight(key), []);
}

/**
 * A single-region key map built directly from a key, bypassing
 * {@link buildKeyMap}'s fifths computation — needed for a malformed key,
 * which that computation cannot spell.
 */
function literalKeyMap(key: KeyScale | null): KeyMap {
  return {
    regions: [{ startPpq: 0, endPpq: Infinity, key, source: 'declared' }],
    at: () => key,
    keySetAt: () => key !== null,
    keyFifthsAt: () => 0,
  };
}

function marker(partial: Partial<EditorMarker>): EditorMarker {
  return { id: 1, ppq: 0, name: 'Marker', ...partial };
}

describe('analyzeHarmony', () => {
  it('detects an authentic cadence at the tonic arrival', () => {
    const analysis = analyzeHarmony(
      progression([
        [7, MAJOR],
        [0, MAJOR],
      ]),
      singleKeyMap(C_MAJOR),
    );
    expect(analysis.cadences).toEqual([{ atPpq: 4, type: 'authentic' }]);
  });

  it('detects a plagal cadence from the subdominant', () => {
    const analysis = analyzeHarmony(
      progression([
        [5, MAJOR],
        [0, MAJOR],
      ]),
      singleKeyMap(C_MAJOR),
    );
    expect(analysis.cadences).toEqual([{ atPpq: 4, type: 'plagal' }]);
  });

  it('detects a half cadence on the dominant', () => {
    const analysis = analyzeHarmony(
      progression([
        [0, MAJOR],
        [7, MAJOR],
      ]),
      singleKeyMap(C_MAJOR),
    );
    expect(analysis.cadences).toEqual([{ atPpq: 4, type: 'half' }]);
  });

  it('detects a deceptive cadence resolving to the submediant', () => {
    const analysis = analyzeHarmony(
      progression([
        [7, MAJOR],
        [9, MINOR],
      ]),
      singleKeyMap(C_MAJOR),
    );
    expect(analysis.cadences).toEqual([{ atPpq: 4, type: 'deceptive' }]);
  });

  it('reports the borrowing source of a parallel-minor chord', () => {
    const analysis = analyzeHarmony(progression([[5, MINOR]]), singleKeyMap(C_MAJOR));
    expect(analysis.byStartPpq.get(0)?.borrowed).toBe('parallelMinor');
  });

  it('reports the borrowing source of a parallel-major chord in a minor key', () => {
    const analysis = analyzeHarmony(progression([[5, MAJOR]]), singleKeyMap(C_MINOR));
    expect(analysis.byStartPpq.get(0)?.borrowed).toBe('parallelMajor');
  });

  it('reports the Neapolitan as its own source', () => {
    const analysis = analyzeHarmony(progression([[1, MAJOR]]), singleKeyMap(C_MAJOR));
    expect(analysis.byStartPpq.get(0)?.borrowed).toBe('neapolitan');
  });

  it('names an applied dominant with its slashed numeral', () => {
    const analysis = analyzeHarmony(
      progression([
        [2, DOM7],
        [7, MAJOR],
      ]),
      singleKeyMap(C_MAJOR),
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
      singleKeyMap(C_MAJOR),
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
      singleKeyMap(C_MAJOR),
    );
    expect(analysis.byStartPpq.size).toBe(0);
    expect(analysis.cadences).toEqual([]);
  });

  it('skips symbols the library cannot read instead of throwing', () => {
    const symbols: EditorChordSymbol[] = [
      { startPpq: 0, endPpq: 4, rootPc: Number.NaN, quality: MAJOR },
      { startPpq: 4, endPpq: 8, rootPc: 5, quality: MINOR },
    ];
    const analysis = analyzeHarmony(symbols, singleKeyMap(C_MAJOR));
    expect(analysis.byStartPpq.has(0)).toBe(false);
    expect(analysis.byStartPpq.get(4)?.borrowed).toBe('parallelMinor');
  });

  it('degrades to no annotations on a malformed key', () => {
    const analysis = analyzeHarmony(
      progression([
        [7, MAJOR],
        [0, MAJOR],
      ]),
      literalKeyMap({ rootPc: Number.NaN, modeMask12: Number.NaN }),
    );
    expect(analysis.byStartPpq.size).toBe(0);
    expect(analysis.cadences).toEqual([]);
  });

  it('returns an empty analysis for an empty chord track', () => {
    const analysis = analyzeHarmony([], singleKeyMap(C_MAJOR));
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
      singleKeyMap(C_MAJOR),
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
    const analysis = analyzeHarmony(aeolian, singleKeyMap(A_MINOR));
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
      singleKeyMap(C_MAJOR),
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
      singleKeyMap(C_MAJOR),
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
      singleKeyMap(C_MAJOR),
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
      singleKeyMap(C_MAJOR),
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

  describe('key-map regions', () => {
    it('reads each region against its own declared key', () => {
      const keyMap = buildKeyMap(keyScaleToScaleHighlight(C_MAJOR), [
        marker({ id: 1, ppq: 16, name: keyMarkerName(-3, false) }), // Eb major
      ]);
      // The same F-minor chord: borrowed in C major (before the marker), a
      // plain diatonic ii in Eb major (after it).
      const symbols: EditorChordSymbol[] = [
        { startPpq: 0, endPpq: 4, rootPc: 5, quality: MINOR },
        { startPpq: 16, endPpq: 20, rootPc: 5, quality: MINOR },
      ];
      const analysis = analyzeHarmony(symbols, keyMap);
      expect(analysis.byStartPpq.get(0)?.borrowed).toBe('parallelMinor');
      expect(analysis.byStartPpq.get(16)).toBeUndefined();
    });

    it('reads a region with no key set against the default key', () => {
      const keyMap = buildKeyMap(keyScaleToScaleHighlight(C_MAJOR, false), []);
      expect(keyMap.at(0)).toBeNull();
      const withDefault = analyzeHarmony(progression([[5, MINOR]]), keyMap);
      const withCMajor = analyzeHarmony(progression([[5, MINOR]]), singleKeyMap(DEFAULT_KEY_SCALE));
      expect(withDefault.byStartPpq).toEqual(withCMajor.byStartPpq);
    });

    it('carries the boundary relation on a region that does not itself modulate', () => {
      const keyMap = buildKeyMap(keyScaleToScaleHighlight(C_MAJOR), [
        marker({ id: 1, ppq: 16, name: keyMarkerName(1, false) }), // G major
      ]);
      const analysis = analyzeHarmony(progression([[7, MAJOR]], 16), keyMap);
      expect(analysis.keySpans).toEqual([
        { startPpq: 16, endPpq: Infinity, key: G_MAJOR, modulation: 'dominant' },
      ]);
    });

    it('omits the modulation field when the boundary keys share no named relation', () => {
      const keyMap = buildKeyMap(keyScaleToScaleHighlight(C_MAJOR), [
        marker({ id: 1, ppq: 16, name: keyMarkerName(-3, false) }), // Eb major
      ]);
      const analysis = analyzeHarmony(progression([[3, MAJOR]], 16), keyMap);
      expect(analysis.keySpans).toEqual([{ startPpq: 16, endPpq: Infinity, key: E_FLAT_MAJOR }]);
    });

    it('overrides only the first span of a region that also modulates internally', () => {
      const keyMap = buildKeyMap(keyScaleToScaleHighlight(A_MINOR), [
        marker({ id: 1, ppq: 100, name: keyMarkerName(0, false) }), // C major
      ]);
      // ii-V-I in C, then ii-V-I in G, starting after the marker.
      const analysis = analyzeHarmony(
        progression(
          [
            [2, MIN7],
            [7, DOM7],
            [0, MAJ7],
            [0, MAJ7],
            [9, MIN7],
            [2, DOM7],
            [7, MAJ7],
            [7, MAJ7],
          ],
          100,
        ),
        keyMap,
      );
      // A minor to C major is the marker's own move: the declared key hands
      // this to the region's first span. The second span's own detected move
      // (C to G) is untouched, pivot and shared chords included.
      expect(analysis.keySpans[0]).toEqual({
        startPpq: 100,
        endPpq: 116,
        key: C_MAJOR,
        modulation: 'relative',
      });
      expect(analysis.keySpans[1]?.key).toEqual(G_MAJOR);
      expect(analysis.keySpans[1]?.modulation).toBe('dominant');
      expect(analysis.keySpans[1]?.pivot?.romanFrom).toBe('I');
      expect((analysis.keySpans[1]?.sharedChords ?? []).length).toBeGreaterThan(0);
    });

    it('does not synthesize a boundary span for a marker region with no chords', () => {
      const keyMap = buildKeyMap(keyScaleToScaleHighlight(C_MAJOR), [
        marker({ id: 1, ppq: 16, name: keyMarkerName(1, false) }), // G major
      ]);
      const analysis = analyzeHarmony(progression([[0, MAJOR]]), keyMap);
      expect(analysis.keySpans).toEqual([]);
    });
  });
});
