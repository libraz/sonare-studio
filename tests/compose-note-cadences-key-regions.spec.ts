import type { KeyScale } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { analyzeHarmony } from '@/compose/harmonic-analysis';
import { keyScaleToScaleHighlight } from '@/compose/key';
import { buildKeyMap } from '@/compose/key-map';
import { keyMarkerName } from '@/compose/key-name';
import { cadenceArrivals } from '@/compose/note-cadences';
import type { EditorChordSymbol } from '@/project/chords';
import { MAJOR_MODE_MASK } from '@/project/types';

const MAJOR = 0;
const DOM7 = 4;
const MAJ7 = 5;
const MIN7 = 6;
const C_MAJOR: KeyScale = { rootPc: 0, modeMask12: MAJOR_MODE_MASK };

describe('cadenceArrivals on a chord track with key markers', () => {
  // C major up to the Eb marker at 16, then ii-V-I in Eb. Read in C throughout
  // the Eb chords are borrowed and arrive nowhere; read in the marker's key
  // they close on an authentic cadence.
  const symbols: EditorChordSymbol[] = [
    { startPpq: 0, endPpq: 4, rootPc: 0, quality: MAJOR },
    { startPpq: 16, endPpq: 20, rootPc: 5, quality: MIN7 },
    { startPpq: 20, endPpq: 24, rootPc: 10, quality: DOM7 },
    { startPpq: 24, endPpq: 28, rootPc: 3, quality: MAJ7 },
    { startPpq: 28, endPpq: 32, rootPc: 3, quality: MAJ7 },
  ];
  const keyMap = buildKeyMap(keyScaleToScaleHighlight(C_MAJOR), [
    { id: 1, ppq: 16, name: keyMarkerName(-3, false) },
  ]);

  it('reports the cadences the chord lane draws, region by region', () => {
    const lane = analyzeHarmony(symbols, keyMap).cadences.map(({ atPpq, type }) => ({
      atPpq,
      type,
    }));
    expect(lane).toContainEqual({ atPpq: 24, type: 'authentic' });
    const { arrivals, inferred } = cadenceArrivals(symbols, [], keyMap, []);
    expect(inferred).toBe(false);
    expect(arrivals).toEqual(lane);
  });

  it('rereads the track when only the key map changes', () => {
    const withoutMarker = buildKeyMap(keyScaleToScaleHighlight(C_MAJOR), []);
    const inC = cadenceArrivals(symbols, [], withoutMarker, []).arrivals;
    expect(inC).not.toContainEqual({ atPpq: 24, type: 'authentic' });
    expect(cadenceArrivals(symbols, [], keyMap, []).arrivals).toContainEqual({
      atPpq: 24,
      type: 'authentic',
    });
  });
});
