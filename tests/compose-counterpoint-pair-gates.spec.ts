/**
 * The two counterpoint readings that are about *which* pair of voices is being
 * asked about rather than about what a pair does.
 *
 * libcantus answers both questions for a pair in isolation, which is all a
 * predicate can do: whether the outer voices are the ones moving into a perfect
 * interval, and whether two voices are neighbours in the texture, are facts
 * about everything else sounding. Asking every pair instead reports faults in
 * writing that has none — a plain chorale comes back with three hidden
 * parallels, and any melody over a bass line with a spacing fault on every note
 * it has — so the fixtures below pin both the pair the rule keeps and the pair
 * it lets through, with the library's own verdict alongside.
 */

import { createsHiddenParallelPerfect, ReasonFlag } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { buildGuidance, type GuidanceInput, type NoteAnalysis } from '@/compose/guidance';
import type { TrackWithNotes } from '@/compose/tracks';
import type { EditorNote, EditorTrack, TimeSignatureSegment } from '@/project/types';
import { MAJOR_MODE_MASK, type ScaleHighlightConfig } from '@/project/types';

function note(partial: Partial<EditorNote>): EditorNote {
  return {
    id: 1,
    pitch: 60,
    velocity: 96,
    startPpq: 0,
    durationPpq: 1,
    channel: 0,
    ...partial,
  };
}

function track(partial: Partial<EditorTrack>): EditorTrack {
  return {
    id: 1,
    name: 'Track',
    color: '#fff',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: 0,
    ...partial,
  } as EditorTrack;
}

const C_MAJOR_KEY: ScaleHighlightConfig = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
const FOUR_FOUR: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 4, denominator: 4 }];

/**
 * One voice per track, every voice sounding one pitch per slot, so a slot is
 * one vertical of the texture. The first line is the active clip; the rest are
 * its context.
 */
function textureAt(slot: number, active: number[], others: number[][]): NoteAnalysis | undefined {
  const notes = active.map((pitch, index) =>
    note({ id: index + 1, pitch, startPpq: index, durationPpq: 1 }),
  );
  const otherTracks: TrackWithNotes[] = others.map((line, voice) => ({
    track: track({ id: voice + 2, name: `Voice ${voice + 2}` }),
    notes: line.map((pitch, index) =>
      note({ id: (voice + 1) * 100 + index, pitch, startPpq: index, durationPpq: 1 }),
    ),
  }));
  const input: GuidanceInput = {
    notes,
    clipStartPpq: 0,
    clipLengthPpq: active.length,
    chordSymbols: [],
    key: C_MAJOR_KEY,
    timeSignatures: FOUR_FOUR,
    otherTracks,
  };
  return buildGuidance(input).byNoteId.get(slot + 1);
}

/** Whether the safety verdict still carries the hidden-parallel reason. */
function hidden(analysis: NoteAnalysis | undefined): boolean {
  return ((analysis?.safety?.reasons ?? 0) & ReasonFlag.HiddenParallel) !== 0;
}

describe('hidden parallels', () => {
  // C3 -> F3 under B3 -> F4: similar motion into an octave with the upper voice
  // leaping a fifth into it. The library's own answer is pinned next to each
  // fixture, because what changes below is never that answer — only which pair
  // of voices the question is asked about.
  it('keeps a direct octave between the outer voices', () => {
    expect(createsHiddenParallelPerfect(59, 65, 48, 53)).toBe(true);
    expect(hidden(textureAt(1, [59, 65], [[48, 53]]))).toBe(true);
  });

  it('lets the same motion pass between two inner voices', () => {
    // The identical pair, now with a pedal below it and a voice held above: the
    // two that move are neither the top nor the bottom of the texture.
    expect(
      hidden(
        textureAt(
          1,
          [59, 65],
          [
            [48, 53],
            [36, 36],
            [84, 84],
          ],
        ),
      ),
    ).toBe(false);
  });

  it('keeps the step exception the library already applies', () => {
    // B3 -> C4 over C3 -> F3: the same arrival, reached by step. This one is
    // the library's to dismiss, and pinning it here is what tells the two
    // dismissals apart if the count ever moves.
    expect(createsHiddenParallelPerfect(64, 65, 48, 53)).toBe(false);
    expect(hidden(textureAt(1, [64, 65], [[48, 53]]))).toBe(false);
  });

  it('does not read a parallel across a rest longer than the bar', () => {
    // The same outer-voice pair, its two events six beats apart in 4/4. A voice
    // that has been silent for over a bar is not heard as moving into anything.
    const notes = [
      note({ id: 1, pitch: 59, startPpq: 0, durationPpq: 1 }),
      note({ id: 2, pitch: 65, startPpq: 6, durationPpq: 1 }),
    ];
    const other: TrackWithNotes = {
      track: track({ id: 2, name: 'Lower' }),
      notes: [
        note({ id: 101, pitch: 48, startPpq: 0, durationPpq: 1 }),
        note({ id: 102, pitch: 53, startPpq: 6, durationPpq: 1 }),
      ],
    };
    const result = buildGuidance({
      notes,
      clipStartPpq: 0,
      clipLengthPpq: 8,
      chordSymbols: [],
      key: C_MAJOR_KEY,
      timeSignatures: FOUR_FOUR,
      otherTracks: [other],
    });
    expect(hidden(result.byNoteId.get(2))).toBe(false);
  });
});

describe('spacing', () => {
  it('exempts a melody carried an eleventh above a bass line', () => {
    // Two voices, so the only pair there is is the bass one. This is the shape
    // of most homophony, and measuring it would put a fault on every note.
    const analysis = textureAt(1, [72, 74], [[48, 50]]);
    expect(analysis?.counterpoint?.wideSpacing).toBe(undefined);
  });

  it('reports an octave-and-a-half between the two upper voices', () => {
    // G5 over C4, with a tenor and a bass below: the gap the rule is about,
    // between voices that are neighbours in the texture.
    const analysis = textureAt(
      1,
      [79, 81],
      [
        [60, 60],
        [55, 57],
        [43, 45],
      ],
    );
    expect(analysis?.counterpoint?.wideSpacing).toBe(true);
  });

  it('leaves a chorale spaced within an octave alone', () => {
    const analysis = textureAt(
      1,
      [67, 69],
      [
        [60, 60],
        [55, 57],
        [43, 45],
      ],
    );
    expect(analysis?.counterpoint?.wideSpacing).toBe(undefined);
  });

  it('never reports the note at the bottom of the texture', () => {
    // The bass an octave and a half below the tenor, asked from the bass: the
    // pair is real and the exemption is what the bass is for.
    const analysis = textureAt(
      1,
      [36, 38],
      [
        [55, 57],
        [60, 60],
        [67, 69],
      ],
    );
    expect(analysis?.counterpoint?.wideSpacing).toBe(undefined);
  });

  it('reads one instant, so it holds for the first note of a clip', () => {
    // Every other reading here is measured across a step and cannot answer for
    // a note with nothing before it.
    const analysis = textureAt(
      0,
      [79, 81],
      [
        [60, 60],
        [55, 57],
        [43, 45],
      ],
    );
    expect(analysis?.counterpoint?.wideSpacing).toBe(true);
  });
});
