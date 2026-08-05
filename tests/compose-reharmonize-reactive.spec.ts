import { harmonizeMelody } from '@libraz/libcantus';
import { describe, expect, it, vi } from 'vitest';
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

// Spy on the harmonizer while keeping its real behavior, so a test can inspect
// the harmonic-rhythm argument the reactive pass derives from the meter.
vi.mock('@libraz/libcantus', async (importActual) => {
  const actual = await importActual<typeof import('@libraz/libcantus')>();
  return { ...actual, harmonizeMelody: vi.fn(actual.harmonizeMelody) };
});

const C_MAJOR: ScaleHighlightConfig = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
const KEY_INFERENCE: ScaleHighlightConfig = {
  enabled: false,
  rootPc: 0,
  modeMask: MAJOR_MODE_MASK,
};
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

  it('defaults the harmonic rhythm to one bar of the governing meter', () => {
    /** Runs a fresh pass under `meter` and returns the harmonicRhythm libcantus saw. */
    function harmonicRhythmFor(meter: TimeSignatureSegment): number {
      vi.mocked(harmonizeMelody).mockClear();
      const barBeats = (meter.numerator * 4) / meter.denominator;
      proposeReactiveReharmonization({
        current: [chord(0, barBeats, 0)],
        // A clash forces the fresh harmonization pass to actually run.
        melody: clashBar(0),
        editedSpan: { startPpq: 0, endPpq: barBeats },
        key: C_MAJOR,
        timeSignatures: [meter],
      });
      expect(vi.mocked(harmonizeMelody)).toHaveBeenCalled();
      return vi.mocked(harmonizeMelody).mock.calls[0][0].harmonicRhythm as number;
    }

    // Quarter-note bar length, not a fixed 4 and not the compound beat count:
    // 4/4 → 4, 3/4 → 3, and 6/8 → 3 (would be 2 under beatsPerBar).
    expect(harmonicRhythmFor({ startPpq: 0, numerator: 4, denominator: 4 })).toBe(4);
    expect(harmonicRhythmFor({ startPpq: 0, numerator: 3, denominator: 4 })).toBe(3);
    expect(harmonicRhythmFor({ startPpq: 0, numerator: 6, denominator: 8 })).toBe(3);
  });

  it('rebases the reactive harmonic grid to the active clip origin', () => {
    vi.mocked(harmonizeMelody).mockClear();
    proposeReactiveReharmonization({
      current: [chord(10, 13, 11)],
      melody: clashBar(10),
      editedSpan: { startPpq: 10, endPpq: 13 },
      key: C_MAJOR,
      timeSignatures: [
        { startPpq: 0, numerator: 4, denominator: 4 },
        { startPpq: 8, numerator: 3, denominator: 4 },
      ],
      harmonicGridOriginPpq: 10,
    });

    const input = vi.mocked(harmonizeMelody).mock.calls[0][0];
    expect(input.harmonicRhythm).toBe(3);
    expect(input.melody[0]?.startBeat).toBe(0);
  });

  it('restarts fresh reactive harmonization at every meter boundary', () => {
    vi.mocked(harmonizeMelody).mockClear();
    proposeReactiveReharmonization({
      current: [chord(0, 4, 11), chord(4, 7, 11)],
      melody: [...clashBar(0), ...clashBar(4).slice(0, 3)],
      editedSpan: { startPpq: 0, endPpq: 7 },
      key: C_MAJOR,
      timeSignatures: [
        { startPpq: 0, numerator: 4, denominator: 4 },
        { startPpq: 4, numerator: 3, denominator: 4 },
      ],
    });

    expect(vi.mocked(harmonizeMelody).mock.calls.map(([input]) => input.harmonicRhythm)).toEqual([
      4, 3,
    ]);
  });

  it('starts a meter-changing reharmonization at the enclosing bar line', () => {
    vi.mocked(harmonizeMelody).mockClear();
    proposeReactiveReharmonization({
      current: [chord(0, 4, 11), chord(4, 7, 11)],
      melody: [mel(61, 2), mel(66, 3), ...clashBar(4).slice(0, 3)],
      editedSpan: { startPpq: 2, endPpq: 7 },
      key: C_MAJOR,
      timeSignatures: [
        { startPpq: 0, numerator: 4, denominator: 4 },
        { startPpq: 4, numerator: 3, denominator: 4 },
      ],
    });

    // The first melody note is on beat three, but libcantus receives its
    // absolute position relative to bar 1 (2), not a synthetic downbeat (0).
    expect(vi.mocked(harmonizeMelody).mock.calls[0]?.[0].melody[0]?.startBeat).toBe(2);
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

  it('keeps a fitting chord under a short weak-beat chromatic passing tone', () => {
    const result = proposeReactiveReharmonization({
      current: [chord(0, 4, 0)],
      melody: [mel(60, 0, 1), mel(66, 1, 0.25), mel(67, 2, 1)],
      editedSpan: { startPpq: 0, endPpq: 4 },
      key: C_MAJOR,
      timeSignatures: FOUR_FOUR,
    });

    expect(result.changed).toBe(false);
    expect(result.proposal[0]).toMatchObject({ rootPc: 0 });
  });

  it('uses the inferred key for hysteresis when key highlighting is disabled', () => {
    const current = [chord(0, 4, 4)]; // E major
    const eMajorMelody = [mel(64, 0), mel(68, 1), mel(71, 2), mel(76, 3)];
    const result = proposeReactiveReharmonization({
      current,
      melody: eMajorMelody,
      editedSpan: { startPpq: 0, endPpq: 4 },
      key: KEY_INFERENCE,
      timeSignatures: FOUR_FOUR,
    });

    expect(result.changed).toBe(false);
    expect(result.proposal[0]).toMatchObject({ rootPc: 4, quality: 0 });
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

  it('reharmonizes every occurrence a looping edit lands on (span list)', () => {
    // A looping clip repeats one source edit at several timeline windows, so the
    // caller passes one span per occurrence. Five bars are all B major and clash
    // with the C-major arpeggio; only the first and last windows are in the edit
    // list, spaced so their neighbour extension cannot reach the middle bar.
    const current = [
      chord(0, 4, 11),
      chord(4, 8, 11),
      chord(8, 12, 11),
      chord(12, 16, 11),
      chord(16, 20, 11),
    ];
    const melody = [
      ...cMajorBar(0),
      ...cMajorBar(4),
      ...cMajorBar(8),
      ...cMajorBar(12),
      ...cMajorBar(16),
    ];
    const result = proposeReactiveReharmonization({
      current,
      melody,
      editedSpan: [
        { startPpq: 0, endPpq: 2 },
        { startPpq: 16, endPpq: 18 },
      ],
      key: C_MAJOR,
      timeSignatures: FOUR_FOUR,
    });
    // Both listed windows reharmonize, not just the first.
    expect(result.changedIndices).toContain(0);
    expect(result.changedIndices).toContain(4);
    expect(result.proposal[0].rootPc).not.toBe(11);
    expect(result.proposal[4].rootPc).not.toBe(11);
    // The unlisted middle bar (out of every span's neighbour reach) is kept.
    expect(result.proposal[2]).toMatchObject({ rootPc: 11 });
    expect(result.changedIndices).not.toContain(2);
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
