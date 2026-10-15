import { HARMONIC_MINOR_MASK, MAJOR_MASK } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { keyScaleToKeyFifths } from '@/compose/key';
import { proposeKeyChanges } from '@/compose/key-changes';
import { buildKeyMap, sameKeyName } from '@/compose/key-map';
import { keyMarkerName } from '@/compose/key-name';
import type { VoiceLine } from '@/compose/voice-context';
import { type EditorNote, MAJOR_MODE_MASK, type TimeSignatureSegment } from '@/project/types';

/** One chord's worth of arpeggiated quarter notes, matching the design's probe fixture. */
function arp(
  root: number,
  startBeat: number,
  beatsPerChord: number,
  chords: ReadonlyArray<ReadonlyArray<number>>,
  base = 60,
): EditorNote[] {
  const out: EditorNote[] = [];
  let beat = startBeat;
  let id = 1;
  for (const chord of chords) {
    for (let i = 0; i < beatsPerChord; i++) {
      const pitchClasses = chord.map((offset) => offset + root);
      out.push({
        id: id++,
        pitch: base + pitchClasses[i % pitchClasses.length],
        velocity: 80,
        startPpq: beat,
        durationPpq: 1,
        channel: 0,
      });
      beat += 1;
    }
  }
  return out;
}

const I = [0, 4, 7];
const IV = [5, 9, 12];
const V = [7, 11, 14];

const FOUR_FOUR: ReadonlyArray<TimeSignatureSegment> = [
  { startPpq: 0, numerator: 4, denominator: 4 },
];
const THREE_FOUR: ReadonlyArray<TimeSignatureSegment> = [
  { startPpq: 0, numerator: 3, denominator: 4 },
];

function lines(notes: ReadonlyArray<EditorNote>): VoiceLine[] {
  return [{ trackId: 1, role: 'melodic', notes }];
}

const NO_KEY = buildKeyMap({ enabled: false, rootPc: 0, modeMask: MAJOR_MODE_MASK }, []);

describe('proposeKeyChanges', () => {
  it('finds the boundary of a modulation from C to G over 8 bars each (4/4)', () => {
    const notes = [
      ...arp(0, 0, 4, [I, IV, V, I, I, IV, V, I]),
      ...arp(7, 32, 4, [I, IV, V, I, I, IV, V, I]),
    ];
    const proposals = proposeKeyChanges(lines(notes), FOUR_FOUR, NO_KEY);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({ startPpq: 0, key: { rootPc: 0 }, selected: false });
    expect(proposals[1]).toMatchObject({ startPpq: 32, key: { rootPc: 7 }, selected: true });
  });

  it('finds the boundary of a modulation from C (12 bars) to F (4 bars), 4/4', () => {
    const vi = [9, 12, 16];
    const notes = [
      ...arp(0, 0, 4, [I, vi, IV, V, I, vi, IV, V, I, IV, V, I]),
      ...arp(5, 48, 4, [I, IV, V, I]),
    ];
    const proposals = proposeKeyChanges(lines(notes), FOUR_FOUR, NO_KEY);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({ startPpq: 0, key: { rootPc: 0 } });
    expect(proposals[1]).toMatchObject({ startPpq: 48, key: { rootPc: 5 }, selected: true });
  });

  it('finds the boundary of a modulation from C to D over 8 bars each (3/4)', () => {
    const notes = [
      ...arp(0, 0, 3, [I, IV, V, I, I, IV, V, I]),
      ...arp(2, 24, 3, [I, IV, V, I, I, IV, V, I]),
    ];
    const proposals = proposeKeyChanges(lines(notes), THREE_FOUR, NO_KEY);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({ startPpq: 0, key: { rootPc: 0 } });
    expect(proposals[1]).toMatchObject({ startPpq: 24, key: { rootPc: 2 }, selected: true });
  });

  it('reports no proposals for 16 bars of C with no modulation, against a matching declared key', () => {
    const vi = [9, 12, 16];
    const notes = arp(0, 0, 4, [I, vi, IV, V, I, vi, IV, V, I, vi, IV, V, I, IV, V, I]);
    const declaredC = buildKeyMap({ enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK }, []);
    expect(proposeKeyChanges(lines(notes), FOUR_FOUR, declaredC)).toEqual([]);
  });

  it('leaves the first region unselected when it disagrees with the declared key', () => {
    const notes = [
      ...arp(0, 0, 4, [I, IV, V, I, I, IV, V, I]),
      ...arp(7, 32, 4, [I, IV, V, I, I, IV, V, I]),
    ];
    // Declared A minor: neither the C-major opening nor the G-major region matches it.
    const declaredAMinor = buildKeyMap(
      { enabled: true, rootPc: 9, modeMask: HARMONIC_MINOR_MASK },
      [],
    );
    const proposals = proposeKeyChanges(lines(notes), FOUR_FOUR, declaredAMinor);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({ startPpq: 0, selected: false });
    expect(proposals[1]).toMatchObject({ startPpq: 32, selected: true });
  });

  it('does not propose an extra region at beat 0 when the declared key is harmonic minor', () => {
    // A natural minor i-iv-v arpeggio: keyTimelineFromNotes only ever reports the
    // natural-minor mask, which sameKeyName treats as matching the harmonic-minor
    // declaration (same tonic, same major/minor quality).
    // Offsets already relative to A (base 57 = A3); root stays 0.
    const i = [0, 3, 7];
    const iv = [5, 8, 12];
    const v = [7, 10, 14];
    const notes = arp(0, 0, 4, [i, iv, v, i, i, iv, v, i, i, iv, v, i, iv, v, i, i], 57);
    const declaredAHarmonicMinor = buildKeyMap(
      { enabled: true, rootPc: 9, modeMask: HARMONIC_MINOR_MASK },
      [],
    );
    expect(proposeKeyChanges(lines(notes), FOUR_FOUR, declaredAHarmonicMinor)).toEqual([]);
  });

  it('proposes the return to the declared key after a modulation', () => {
    const progression = [I, IV, V, I, I, IV, V, I];
    const notes = [
      ...arp(0, 0, 4, progression),
      ...arp(7, 32, 4, progression),
      ...arp(0, 64, 4, progression),
    ];
    const declaredC = buildKeyMap({ enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK }, []);
    const proposals = proposeKeyChanges(lines(notes), FOUR_FOUR, declaredC);
    expect(proposals.map((proposal) => proposal.key.rootPc)).toEqual([7, 0]);

    const applied = buildKeyMap(
      { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK },
      proposals.map((proposal, index) => ({
        id: index + 1,
        ppq: proposal.startPpq,
        name: keyMarkerName(keyScaleToKeyFifths(proposal.key), proposal.key.rootPc === 9),
      })),
    );
    for (const proposal of proposals) {
      const inForce = applied.at(proposal.startPpq);
      expect(inForce !== null && sameKeyName(inForce, proposal.key)).toBe(true);
    }
  });

  it('lets an existing marker after a proposal take over before comparing later regions', () => {
    const progression = [I, IV, V, I, I, IV, V, I];
    const notes = [
      ...arp(0, 0, 4, progression),
      ...arp(7, 32, 4, progression),
      ...arp(0, 64, 4, progression),
    ];
    const declaredC = buildKeyMap({ enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK }, []);
    const withReturn = buildKeyMap({ enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK }, [
      { id: 1, ppq: 48, name: keyMarkerName(0, false) },
    ]);
    const proposals = proposeKeyChanges(lines(notes), FOUR_FOUR, declaredC);
    expect(proposeKeyChanges(lines(notes), FOUR_FOUR, withReturn).map((p) => p.key.rootPc)).toEqual(
      [7],
    );
    expect(proposals).toHaveLength(2);
  });

  it('returns no proposals for no notes', () => {
    expect(proposeKeyChanges([], FOUR_FOUR, NO_KEY)).toEqual([]);
  });

  it('labels a proposal with the conventional key name', () => {
    const notes = [
      ...arp(0, 0, 4, [I, IV, V, I, I, IV, V, I]),
      ...arp(7, 32, 4, [I, IV, V, I, I, IV, V, I]),
    ];
    const proposals = proposeKeyChanges(lines(notes), FOUR_FOUR, NO_KEY);
    expect(proposals[1].label).toBe('G major');
    expect(proposals[1].key.modeMask12).toBe(MAJOR_MASK);
  });
});
