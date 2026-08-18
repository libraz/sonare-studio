import { NoteSafety, ReasonFlag } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { buildTheoryCard, theoryLabelsFor } from '@/compose/explain';
import { buildGuidance, type GuidanceInput, resolutionTargetOf } from '@/compose/guidance';
import type { EditorChordSymbol } from '@/project/chords';
import type { EditorNote, EditorTrack, TimeSignatureSegment } from '@/project/types';
import { MAJOR_MODE_MASK, type ScaleHighlightConfig } from '@/project/types';
import { MESSAGES } from '@/ui/i18n';

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

function chordSymbol(partial: Partial<EditorChordSymbol>): EditorChordSymbol {
  return { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0, ...partial };
}

const C_MAJOR_KEY: ScaleHighlightConfig = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
const E_FLAT_MAJOR_KEY: ScaleHighlightConfig = {
  enabled: true,
  rootPc: 3,
  modeMask: MAJOR_MODE_MASK,
};
const A_FLAT_MAJOR_KEY: ScaleHighlightConfig = {
  enabled: true,
  rootPc: 8,
  modeMask: MAJOR_MODE_MASK,
};
/** Natural minor {0,2,3,5,7,8,10}, the mask a detected minor key comes back as. */
const NATURAL_MINOR_MODE_MASK = 0b010110101101;
const D_MINOR_KEY: ScaleHighlightConfig = {
  enabled: true,
  rootPc: 2,
  modeMask: NATURAL_MINOR_MODE_MASK,
};
const FOUR_FOUR: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 4, denominator: 4 }];

function guidanceInput(partial: Partial<GuidanceInput>): GuidanceInput {
  return {
    notes: [],
    clipStartPpq: 0,
    clipLengthPpq: 4,
    chordSymbols: [],
    key: C_MAJOR_KEY,
    timeSignatures: FOUR_FOUR,
    ...partial,
  };
}

describe('buildGuidance', () => {
  it('labels E over a C major chord as the quality-locked third, safe', () => {
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 10, pitch: 64, startPpq: 0, durationPpq: 1 })],
        chordSymbols: [chordSymbol({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 })],
      }),
    );
    expect(result.keySet).toBe(true);
    expect(result.chordPresent).toBe(true);
    const analysis = result.byNoteId.get(10);
    expect(analysis).toBeDefined();
    expect(analysis?.role?.role).toBe('third');
    expect(analysis?.role?.lock).toBe('quality');
    expect(analysis?.safety?.safety).toBe(NoteSafety.Safe);
    expect(analysis?.isScaleTone).toBe(true);
    expect(analysis?.degree).toBe(3);
  });

  it('counts scale degrees from 1 and answers -1 off the scale', () => {
    // The tonic and the leading tone bracket the scale, and C# is outside it:
    // the three answers a card has to tell apart. A degree counted from 0 would
    // put the tonic at 0 and make "not in the scale" indistinguishable from it.
    const result = buildGuidance(
      guidanceInput({
        notes: [
          note({ id: 1, pitch: 60, startPpq: 0, durationPpq: 1 }),
          note({ id: 2, pitch: 71, startPpq: 1, durationPpq: 1 }),
          note({ id: 3, pitch: 61, startPpq: 2, durationPpq: 1 }),
        ],
      }),
    );
    expect(result.byNoteId.get(1)?.degree).toBe(1);
    expect(result.byNoteId.get(2)?.degree).toBe(7);
    expect(result.byNoteId.get(3)?.degree).toBe(-1);
    expect(result.byNoteId.get(3)?.isScaleTone).toBe(false);
  });

  it('reads the scale-degree line straight off the degree, without an offset', () => {
    // The card used to add 1 to a degree that was counted from 0. Both ends of
    // that convention have to agree, and only a rendered line proves they do.
    const result = buildGuidance(
      guidanceInput({ notes: [note({ id: 1, pitch: 71, startPpq: 0, durationPpq: 1 })] }),
    );
    const analysis = result.byNoteId.get(1);
    expect(analysis).toBeDefined();
    if (analysis === undefined) return;
    const card = buildTheoryCard(
      analysis,
      { pitch: 71, keySet: true },
      theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence),
    );
    expect(card.lines.find((line) => line.label === 'Scale')?.text).toBe('Scale degree 7');
  });

  it('flags a note a semitone above a chord tone as not safe', () => {
    // F over C major sits a semitone above the third E: an avoid note.
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 20, pitch: 65, startPpq: 0, durationPpq: 1 })],
        chordSymbols: [chordSymbol({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 })],
      }),
    );
    const analysis = result.byNoteId.get(20);
    expect(analysis?.safety).toBeDefined();
    expect(analysis?.safety?.safety).not.toBe(NoteSafety.Safe);
  });

  it.each([
    ['m(add9)', chordSymbol({ quality: 11 }), 62],
    ['min9', chordSymbol({ quality: 6, extensions: [2] }), 62],
    ['7b9', chordSymbol({ quality: 4, extensions: [1] }), 61],
    ['13', chordSymbol({ quality: 4, extensions: [9] }), 69],
  ])('treats the %s extension as a chord tone in guidance', (_label, chord, pitch) => {
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 25, pitch })],
        chordSymbols: [chord],
      }),
    );
    expect(result.byNoteId.get(25)?.safety?.safety).toBe(NoteSafety.Safe);
  });

  it('never lets a percussion track downgrade a consonant melody note', () => {
    // The drum hits sit a semitone off the melody note; if they leaked into
    // otherVoices they would register as vertical dissonance.
    const drums = {
      track: track({ id: 2, name: 'Drums' }),
      notes: [
        note({ id: 100, pitch: 63, startPpq: 0, durationPpq: 4, channel: 9 }),
        note({ id: 101, pitch: 65, startPpq: 0, durationPpq: 4, channel: 9 }),
      ],
    };
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 30, pitch: 64, startPpq: 0, durationPpq: 1 })],
        chordSymbols: [chordSymbol({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 })],
        otherTracks: [drums],
      }),
    );
    const analysis = result.byNoteId.get(30);
    expect(analysis?.safety?.safety).toBe(NoteSafety.Safe);
  });

  it('emits a key-only segment when no progression exists', () => {
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 40, pitch: 62, startPpq: 0, durationPpq: 2 })],
      }),
    );
    expect(result.chordPresent).toBe(false);
    expect(result.segments).toHaveLength(1);
    expect([...result.segments[0].safetyByPc]).toEqual(new Array<number>(12).fill(NoteSafety.Safe));
    const analysis = result.byNoteId.get(40);
    expect(analysis?.degree).toBe(2); // D is the second degree of C major
    expect(analysis?.isScaleTone).toBe(true);
  });

  it('converts chord-segment spans to clip-relative beats', () => {
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 50, pitch: 60, startPpq: 0, durationPpq: 4 })],
        clipStartPpq: 8,
        chordSymbols: [chordSymbol({ startPpq: 8, endPpq: 12, rootPc: 0, quality: 0 })],
      }),
    );
    expect(result.chordPresent).toBe(true);
    expect(result.segments).toHaveLength(4);
    expect(result.segments[0].startBeat).toBe(0);
    expect(result.segments[0].endBeat).toBe(1);
    expect(result.segments[3].endBeat).toBe(4);
  });

  it('emits one independently evaluated tint row per metric pulse', () => {
    const result = buildGuidance(
      guidanceInput({ chordSymbols: [chordSymbol({ rootPc: 0, quality: 0 })] }),
    );
    expect(result.segments).toHaveLength(4);
    expect(result.segments[0].safetyByPc).not.toBe(result.segments[1].safetyByPc);
  });

  it('shifts segment beats into the source frame for a trimmed clip', () => {
    // A clip trimmed so its left edge shows source PPQ 2: the note-editing
    // surfaces draw notes in that source frame, so a chord sounding at the
    // clip's start must tint from beat 2 (source), not 0 (window).
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 51, pitch: 60, startPpq: 0, durationPpq: 4 })],
        clipStartPpq: 8,
        sourceOffsetPpq: 2,
        chordSymbols: [chordSymbol({ startPpq: 8, endPpq: 12, rootPc: 0, quality: 0 })],
      }),
    );
    expect(result.segments).toHaveLength(4);
    expect(result.segments[0].startBeat).toBe(2);
    expect(result.segments[0].endBeat).toBe(3);
    expect(result.segments[3].endBeat).toBe(6);
  });

  it('tints the full explicit window of a long empty clip', () => {
    const result = buildGuidance(
      guidanceInput({
        notes: [],
        clipStartPpq: 8,
        clipLengthPpq: 16,
        chordSymbols: [chordSymbol({ startPpq: 8, endPpq: 32 })],
      }),
    );
    expect(result.segments).toHaveLength(16);
    expect(result.segments[0]).toMatchObject({ startBeat: 0, endBeat: 1 });
    expect(result.segments[15]).toMatchObject({ startBeat: 15, endBeat: 16 });
  });

  it('clamps a chord tint at the clip end', () => {
    const result = buildGuidance(
      guidanceInput({
        clipLengthPpq: 3,
        chordSymbols: [chordSymbol({ startPpq: 0, endPpq: 8 })],
      }),
    );
    expect(result.segments).toHaveLength(3);
    expect(result.segments[2].endBeat).toBe(3);
  });
});

describe('counterpoint (voice-relative, no chord progression)', () => {
  it('reports the interval and consonance against the bass without any chord', () => {
    // A single other voice a perfect fifth below the active note; no progression.
    const lower = { track: track({ id: 2, name: 'Bass' }), notes: [note({ id: 200, pitch: 55 })] };
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 80, pitch: 62, startPpq: 0, durationPpq: 1 })],
        otherTracks: [lower],
      }),
    );
    expect(result.chordPresent).toBe(false);
    const analysis = result.byNoteId.get(80);
    expect(analysis?.vertical).toEqual({ toBass: 7, consonance: 'perfect' });
  });

  it('treats a perfect fourth above the bass as dissonant in three voices', () => {
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 81, pitch: 65, startPpq: 0, durationPpq: 1 })],
        otherTracks: [
          { track: track({ id: 2, name: 'Bass' }), notes: [note({ id: 201, pitch: 60 })] },
          { track: track({ id: 3, name: 'Alto' }), notes: [note({ id: 202, pitch: 69 })] },
        ],
      }),
    );

    expect(result.byNoteId.get(81)?.vertical).toEqual({ toBass: 5, consonance: 'dissonant' });
  });

  it('flags parallel perfect fifths between two voices with no chord', () => {
    // Active voice C4->D4 over a voice a fifth below (F3->G3): parallel fifths.
    const lower = {
      track: track({ id: 2, name: 'Bass' }),
      notes: [
        note({ id: 210, pitch: 53, startPpq: 0, durationPpq: 1 }),
        note({ id: 211, pitch: 55, startPpq: 1, durationPpq: 1 }),
      ],
    };
    const result = buildGuidance(
      guidanceInput({
        notes: [
          note({ id: 90, pitch: 60, startPpq: 0, durationPpq: 1 }),
          note({ id: 91, pitch: 62, startPpq: 1, durationPpq: 1 }),
        ],
        otherTracks: [lower],
      }),
    );
    const analysis = result.byNoteId.get(91);
    expect(analysis?.safety).toBeDefined();
    expect((analysis?.safety?.reasons ?? 0) & ReasonFlag.ParallelPerfect).toBeTruthy();
  });

  it('keeps quiet about a line doubled at the octave', () => {
    // Two voices an octave apart for five slots running: this is one line
    // reinforced, the texture of an organ or a horn section, and calling every
    // note of it a parallel octave says nothing the composer can act on.
    const lower = {
      track: track({ id: 2, name: 'Tenor' }),
      notes: [60, 62, 64, 62, 60].map((pitch, index) =>
        note({ id: 300 + index, pitch, startPpq: index, durationPpq: 1 }),
      ),
    };
    const result = buildGuidance(
      guidanceInput({
        clipLengthPpq: 8,
        notes: [72, 74, 76, 74, 72].map((pitch, index) =>
          note({ id: 100 + index, pitch, startPpq: index, durationPpq: 1 }),
        ),
        otherTracks: [lower],
      }),
    );
    for (let index = 0; index < 5; index++) {
      const analysis = result.byNoteId.get(100 + index);
      expect(analysis?.safety).toBeDefined();
      expect((analysis?.safety?.reasons ?? 0) & ReasonFlag.ParallelPerfect).toBe(0);
    }
  });

  it('still flags two voices that only meet at an octave for one step', () => {
    // The same octave, held for a single step before the voices part company:
    // two independent lines falling into a parallel, which is the finding.
    const lower = {
      track: track({ id: 2, name: 'Tenor' }),
      notes: [60, 62, 67].map((pitch, index) =>
        note({ id: 310 + index, pitch, startPpq: index, durationPpq: 1 }),
      ),
    };
    const result = buildGuidance(
      guidanceInput({
        notes: [72, 74, 77].map((pitch, index) =>
          note({ id: 110 + index, pitch, startPpq: index, durationPpq: 1 }),
        ),
        otherTracks: [lower],
      }),
    );
    expect(
      (result.byNoteId.get(111)?.safety?.reasons ?? 0) & ReasonFlag.ParallelPerfect,
    ).toBeTruthy();
  });

  it('still flags parallel fifths between two voices that are not doubling', () => {
    // E4 -> D4 over A3 -> G3: a perfect fifth carried by similar motion between
    // voices that hold no fixed separation on either side of it.
    const lower = {
      track: track({ id: 2, name: 'Tenor' }),
      notes: [
        note({ id: 320, pitch: 57, startPpq: 0, durationPpq: 1 }),
        note({ id: 321, pitch: 55, startPpq: 1, durationPpq: 1 }),
        note({ id: 322, pitch: 59, startPpq: 2, durationPpq: 1 }),
      ],
    };
    const result = buildGuidance(
      guidanceInput({
        notes: [
          note({ id: 120, pitch: 64, startPpq: 0, durationPpq: 1 }),
          note({ id: 121, pitch: 62, startPpq: 1, durationPpq: 1 }),
          note({ id: 122, pitch: 67, startPpq: 2, durationPpq: 1 }),
        ],
        otherTracks: [lower],
      }),
    );
    expect(
      (result.byNoteId.get(121)?.safety?.reasons ?? 0) & ReasonFlag.ParallelPerfect,
    ).toBeTruthy();
  });

  it('does not call contrary motion between two octaves a parallel', () => {
    // A5 -> Bb4 against A3 -> Bb3: the octave classes match on both sides, but
    // the voices move in opposite directions, so nothing runs parallel.
    const lower = {
      track: track({ id: 2, name: 'Tenor' }),
      notes: [
        note({ id: 330, pitch: 57, startPpq: 0, durationPpq: 1 }),
        note({ id: 331, pitch: 58, startPpq: 1, durationPpq: 1 }),
      ],
    };
    const result = buildGuidance(
      guidanceInput({
        notes: [
          note({ id: 130, pitch: 81, startPpq: 0, durationPpq: 1 }),
          note({ id: 131, pitch: 70, startPpq: 1, durationPpq: 1 }),
        ],
        otherTracks: [lower],
      }),
    );
    const analysis = result.byNoteId.get(131);
    expect(analysis?.safety).toBeDefined();
    expect((analysis?.safety?.reasons ?? 0) & ReasonFlag.ParallelPerfect).toBe(0);
  });

  it('does not measure a parallel across a rest longer than the bar', () => {
    // The voice's previous note is what a parallel is measured against, and
    // after a long rest that note is bars away: the same fifths one bar apart
    // are a progression, six beats apart they are a coincidence.
    const lower = (endBeat: number) => ({
      track: track({ id: 2, name: 'Tenor' }),
      notes: [
        note({ id: 340, pitch: 53, startPpq: 0, durationPpq: 1 }),
        note({ id: 341, pitch: 55, startPpq: endBeat, durationPpq: 1 }),
      ],
    });
    const withinBar = buildGuidance(
      guidanceInput({
        clipLengthPpq: 16,
        notes: [
          note({ id: 140, pitch: 60, startPpq: 0, durationPpq: 1 }),
          note({ id: 141, pitch: 62, startPpq: 4, durationPpq: 1 }),
        ],
        otherTracks: [lower(4)],
      }),
    );
    const acrossBars = buildGuidance(
      guidanceInput({
        clipLengthPpq: 16,
        notes: [
          note({ id: 150, pitch: 60, startPpq: 0, durationPpq: 1 }),
          note({ id: 151, pitch: 62, startPpq: 6, durationPpq: 1 }),
        ],
        otherTracks: [lower(6)],
      }),
    );
    expect(
      (withinBar.byNoteId.get(141)?.safety?.reasons ?? 0) & ReasonFlag.ParallelPerfect,
    ).toBeTruthy();
    expect((acrossBars.byNoteId.get(151)?.safety?.reasons ?? 0) & ReasonFlag.ParallelPerfect).toBe(
      0,
    );
  });

  it('leaves the other counterpoint verdicts to the library', () => {
    // Only the parallel-perfect bit is ever cleared. Each of the remaining
    // voice-relative readings is fired here from its own fixture, so a
    // suppression that reached past its own flag would fail one of them.
    const hidden = buildGuidance(
      guidanceInput({
        notes: [
          note({ id: 160, pitch: 62, startPpq: 0, durationPpq: 1 }),
          note({ id: 161, pitch: 72, startPpq: 1, durationPpq: 1 }),
        ],
        otherTracks: [
          {
            track: track({ id: 2, name: 'Bass' }),
            notes: [
              note({ id: 350, pitch: 55, startPpq: 0, durationPpq: 1 }),
              note({ id: 351, pitch: 60, startPpq: 1, durationPpq: 1 }),
            ],
          },
        ],
      }),
    );
    const crossing = buildGuidance(
      guidanceInput({
        notes: [
          note({ id: 170, pitch: 62, startPpq: 0, durationPpq: 1 }),
          note({ id: 171, pitch: 58, startPpq: 1, durationPpq: 1 }),
        ],
        otherTracks: [
          {
            track: track({ id: 2, name: 'Alto' }),
            // Held across both slots, so the voice the candidate crosses is
            // still sounding when it lands under it.
            notes: [note({ id: 360, pitch: 60, startPpq: 0, durationPpq: 2 })],
          },
        ],
      }),
    );
    // The upper voice holds C5 while the bass steps C4 -> D4 onto beat 2: a
    // dissonant seventh on a strong beat, prepared as a consonance.
    const suspension = buildGuidance(
      guidanceInput({
        notes: [
          note({ id: 180, pitch: 72, startPpq: 1, durationPpq: 1 }),
          note({ id: 181, pitch: 72, startPpq: 2, durationPpq: 1 }),
        ],
        otherTracks: [
          {
            track: track({ id: 2, name: 'Bass' }),
            notes: [
              note({ id: 370, pitch: 60, startPpq: 1, durationPpq: 1 }),
              note({ id: 371, pitch: 62, startPpq: 2, durationPpq: 1 }),
            ],
          },
        ],
      }),
    );
    expect(
      (hidden.byNoteId.get(161)?.safety?.reasons ?? 0) & ReasonFlag.HiddenParallel,
    ).toBeTruthy();
    expect(
      (crossing.byNoteId.get(171)?.safety?.reasons ?? 0) & ReasonFlag.VoiceCrossing,
    ).toBeTruthy();
    const held = suspension.byNoteId.get(181)?.safety?.reasons ?? 0;
    expect(held & ReasonFlag.Suspension).toBeTruthy();
    expect(held & ReasonFlag.VerticalDissonance).toBeTruthy();
  });

  it('flags a suspension held over a moving bass with no chord', () => {
    // The upper voice holds C5 while the bass steps C4->D4, turning a consonant
    // octave into a dissonant seventh on the downbeat: a textbook suspension,
    // chord-free. The dissonance must land on a strong beat (beat 2 here), where
    // suspensions resolve.
    const lower = {
      track: track({ id: 2, name: 'Bass' }),
      notes: [
        note({ id: 220, pitch: 60, startPpq: 1, durationPpq: 1 }),
        note({ id: 221, pitch: 62, startPpq: 2, durationPpq: 1 }),
      ],
    };
    const result = buildGuidance(
      guidanceInput({
        notes: [
          note({ id: 92, pitch: 72, startPpq: 1, durationPpq: 1 }),
          note({ id: 93, pitch: 72, startPpq: 2, durationPpq: 1 }),
        ],
        otherTracks: [lower],
      }),
    );
    const held = result.byNoteId.get(93);
    expect((held?.safety?.reasons ?? 0) & ReasonFlag.Suspension).toBeTruthy();
  });

  it('renders a counterpoint card line from the voice context', () => {
    const lower = { track: track({ id: 2, name: 'Bass' }), notes: [note({ id: 230, pitch: 55 })] };
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 94, pitch: 62, startPpq: 0, durationPpq: 1 })],
        otherTracks: [lower],
      }),
    );
    const analysis = result.byNoteId.get(94);
    expect(analysis).toBeDefined();
    if (analysis === undefined) return;
    const card = buildTheoryCard(
      analysis,
      { pitch: 62, keySet: true },
      theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence),
    );
    const cpLine = card.lines.find((line) => line.label === 'Counterpoint');
    expect(cpLine?.text).toBe('perfect 5th above the bass (perfect consonance)');
  });
});

describe('resolutionTargetOf', () => {
  it('returns the resolution pitch for a leading tone stepping up to the tonic', () => {
    // B (71) resolving up to C (72) over a G7 -> C: the analyzer marks B as a
    // leading tone whose resolveTo target is the following tonic.
    const result = buildGuidance(
      guidanceInput({
        notes: [
          note({ id: 70, pitch: 71, startPpq: 0, durationPpq: 1 }),
          note({ id: 71, pitch: 72, startPpq: 1, durationPpq: 1 }),
        ],
        chordSymbols: [
          chordSymbol({ startPpq: 0, endPpq: 1, rootPc: 7, quality: 4 }),
          chordSymbol({ startPpq: 1, endPpq: 4, rootPc: 0, quality: 0 }),
        ],
      }),
    );
    const analysis = result.byNoteId.get(70);
    expect(analysis).toBeDefined();
    if (analysis === undefined) return;
    expect(resolutionTargetOf(analysis)).toBe(72);
  });

  it('reads the voice-relative verdict when no chord-based label applies', () => {
    // A suspension heard in the voices alone carries no analyzer label, so its
    // target can only come from the safety verdict. Withholding the verdict for
    // a chordless note would silently drop the resolution arrow with it.
    const analysis = {
      degree: 1,
      isScaleTone: true,
      chordSounding: false,
      analyzed: { noteId: 1, labels: [] },
      safety: { reasons: ReasonFlag.Suspension, resolveTo: 71 },
    } as NoteAnalysis;
    expect(resolutionTargetOf(analysis)).toBe(71);
  });

  it('still analyzes a chordless suspension so its counterpoint reading survives', () => {
    // The upper voice holds C5 while the bass steps C4 -> D4: a suspension with
    // no chord anywhere. The verdict is what carries it, and the card's
    // counterpoint line reads it, so it must be computed even though the
    // safety line is withheld for want of a chord.
    const lower = {
      track: track({ id: 2, name: 'Bass' }),
      notes: [
        note({ id: 240, pitch: 60, startPpq: 1, durationPpq: 1 }),
        note({ id: 241, pitch: 62, startPpq: 2, durationPpq: 1 }),
      ],
    };
    const result = buildGuidance(
      guidanceInput({
        notes: [
          note({ id: 95, pitch: 72, startPpq: 1, durationPpq: 1 }),
          note({ id: 96, pitch: 72, startPpq: 2, durationPpq: 1 }),
        ],
        otherTracks: [lower],
      }),
    );
    const held = result.byNoteId.get(96);
    expect(held).toBeDefined();
    if (held === undefined) return;
    expect(held.chordSounding).toBe(false);
    expect(held.safety).toBeDefined();
    expect((held.safety?.reasons ?? 0) & ReasonFlag.Suspension).toBeTruthy();
    const card = buildTheoryCard(
      held,
      { pitch: 72, keySet: true },
      theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence),
    );
    const counterpoint = card.lines.filter((line) => line.label === 'Counterpoint');
    expect(counterpoint.some((line) => line.text.startsWith('Suspension'))).toBe(true);
    expect(card.lines.some((line) => line.label === 'Safety')).toBe(false);

    // The resolution pitch is read off the sounding chord, so this suspension
    // arrives without one and the verdict must still read as a whole sentence.
    expect(held.safety?.resolveTo).toBeUndefined();
    expect(counterpoint.map((line) => line.text)).toContain('Suspension — resolves by step');
  });

  it('returns undefined for a plain chord tone with no resolution obligation', () => {
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 72, pitch: 60, startPpq: 0, durationPpq: 4 })],
        chordSymbols: [chordSymbol({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 })],
      }),
    );
    const analysis = result.byNoteId.get(72);
    expect(analysis).toBeDefined();
    if (analysis === undefined) return;
    expect(resolutionTargetOf(analysis)).toBeUndefined();
  });
});

describe('buildTheoryCard', () => {
  it('spells hover pitches with the active key signature', () => {
    const result = buildGuidance(
      guidanceInput({ notes: [note({ id: 59, pitch: 70 })], key: E_FLAT_MAJOR_KEY }),
    );
    const analysis = result.byNoteId.get(59);
    expect(analysis).toBeDefined();
    if (analysis === undefined) return;

    const card = buildTheoryCard(
      analysis,
      { pitch: 70, keySet: true, keyFifths: -3 },
      theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence),
    );
    expect(card.title).toMatch(/^Bb4/);
  });

  it('titles a raised leading tone the way the staff writes it', () => {
    // C# is chromatic in D minor, so the key signature on its own puts it on the
    // flat side and the card titled it Db4 — contradicting both the C#4 on the
    // staff and the card's own reading of the note as a leading tone. Spelling
    // the line settles it: the note steps up to a natural D, so it takes the
    // letter below that D.
    const result = buildGuidance(
      guidanceInput({
        notes: [
          note({ id: 1, pitch: 57, startPpq: 0, durationPpq: 1 }),
          note({ id: 2, pitch: 61, startPpq: 1, durationPpq: 1 }),
          note({ id: 3, pitch: 62, startPpq: 2, durationPpq: 1 }),
        ],
        key: D_MINOR_KEY,
      }),
    );
    const analysis = result.byNoteId.get(2);
    expect(analysis?.engraved).toEqual({ step: 'C', alter: 1, octave: 4 });
    if (analysis === undefined) return;
    const card = buildTheoryCard(
      analysis,
      { pitch: 61, keySet: true, keyFifths: -1 },
      theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence),
    );
    expect(card.title).toBe('C#4');
  });

  it('keeps the flat spelling in a key whose signature names it', () => {
    // Ab major spells Db itself, so the same pitch that reads C# in D minor has
    // to stay Db here: the reading follows the key and the line, not a blanket
    // preference for sharps.
    const result = buildGuidance(
      guidanceInput({
        notes: [
          note({ id: 1, pitch: 63, startPpq: 0, durationPpq: 1 }),
          note({ id: 2, pitch: 61, startPpq: 1, durationPpq: 1 }),
          note({ id: 3, pitch: 60, startPpq: 2, durationPpq: 1 }),
        ],
        key: A_FLAT_MAJOR_KEY,
      }),
    );
    const analysis = result.byNoteId.get(2);
    expect(analysis?.engraved).toEqual({ step: 'D', alter: -1, octave: 4 });
    if (analysis === undefined) return;
    const card = buildTheoryCard(
      analysis,
      { pitch: 61, keySet: true, keyFifths: -4 },
      theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence),
    );
    expect(card.title).toBe('Db4');
  });

  it('spells suspension resolution targets with the active key signature', () => {
    const analysis = {
      degree: 1,
      isScaleTone: true,
      safety: { reasons: ReasonFlag.Suspension, resolveTo: 70 },
    } as NoteAnalysis;

    const card = buildTheoryCard(
      analysis,
      { pitch: 72, keySet: true, keyFifths: -3 },
      theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence),
    );

    expect(card.lines.some((line) => line.text.includes('Bb4'))).toBe(true);
  });

  it('uses a spelling-neutral Japanese name for a six-semitone interval', () => {
    const analysis = {
      degree: 1,
      isScaleTone: true,
      vertical: { toBass: 6, consonance: 'dissonant' },
    } as NoteAnalysis;

    const card = buildTheoryCard(
      analysis,
      { pitch: 66, keySet: true },
      theoryLabelsFor(MESSAGES.ja.theory, 'normal', MESSAGES.ja.harmony.cadence),
    );

    expect(card.lines.some((line) => line.text.includes('三全音'))).toBe(true);
  });

  it('builds a titled card with a scale-degree line', () => {
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 60, pitch: 64, startPpq: 0, durationPpq: 1 })],
        chordSymbols: [chordSymbol({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 })],
      }),
    );
    const analysis = result.byNoteId.get(60);
    expect(analysis).toBeDefined();
    if (analysis === undefined) return;
    const card = buildTheoryCard(
      analysis,
      { pitch: 64, keySet: true, chordRoman: 'I', chordFunction: 'tonic' },
      theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence),
    );
    expect(card.title).toBe('E4 — 3rd');
    const scaleLine = card.lines.find((line) => line.label === 'Scale');
    expect(scaleLine?.text).toBe('Scale degree 3');
    const chordLine = card.lines.find((line) => line.label === 'Chord');
    expect(chordLine?.text).toBe('I — Tonic');
    expect(card.lines.length).toBeGreaterThan(0);
  });

  it('adds a color-tone line naming the chord scale and its available tensions', () => {
    const result = buildGuidance(
      guidanceInput({
        // A note over a Cmaj7 chord: ionian offers D and A as color tones and
        // F only as a note to pass through.
        notes: [note({ id: 61, pitch: 60, startPpq: 0, durationPpq: 1 })],
        chordSymbols: [chordSymbol({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 5 })],
      }),
    );
    const analysis = result.byNoteId.get(61);
    expect(analysis?.chordScale).toBeDefined();
    expect(analysis?.chordScale?.rootPc).toBe(0);
    if (analysis === undefined) return;
    const card = buildTheoryCard(
      analysis,
      { pitch: 60, keySet: true },
      theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence),
    );
    const colorLine = card.lines.find((line) => line.label === 'Color');
    expect(colorLine).toBeDefined();
    expect(colorLine?.text).toBe('C Ionian · tensions D, A · passing F · or Lydian');
    expect(colorLine?.term?.term).toBe('Chord scale');
  });

  it('keeps passing tones and avoid notes apart on the color-tone line', () => {
    const result = buildGuidance(
      guidanceInput({
        // Cm6/E fits the half-whole octatonic, the one reading that reports all
        // three groups at once: F# is free color, A# may only be passed
        // through, and C# may not be played at all.
        notes: [note({ id: 62, pitch: 60, startPpq: 0, durationPpq: 1 })],
        chordSymbols: [
          chordSymbol({
            startPpq: 0,
            endPpq: 4,
            rootPc: 0,
            quality: 1,
            extensions: [9],
            bassPc: 4,
          }),
        ],
      }),
    );
    const analysis = result.byNoteId.get(62);
    expect(analysis?.chordScale?.scaleName).toBe('octatonicHalfWhole');
    expect(analysis?.chordScale?.tensions).toEqual([6]);
    expect(analysis?.chordScale?.passing).toEqual([10]);
    expect(analysis?.chordScale?.avoid).toEqual([1]);
    if (analysis === undefined) return;
    const card = buildTheoryCard(
      analysis,
      { pitch: 60, keySet: true },
      theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence),
    );
    const colorLine = card.lines.find((line) => line.label === 'Color');
    // Freest first: tensions, then passing, then avoid.
    expect(colorLine?.text).toBe('C Octatonic (half-whole) · tensions F# · passing A# · avoid C#');
  });

  it('names the chord scale on its root even with no tensions, passing or avoid notes', () => {
    const analysis = {
      degree: 2,
      isScaleTone: true,
      chordScale: { scaleName: 'dorian', rootPc: 2, tensions: [], passing: [], avoid: [] },
    } as NoteAnalysis;
    const card = buildTheoryCard(
      analysis,
      { pitch: 62, keySet: true },
      theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence),
    );
    const colorLine = card.lines.find((line) => line.label === 'Color');
    expect(colorLine?.text).toBe('D Dorian');
  });

  it('spells the chord-scale root with the key signature and localizes its name', () => {
    const analysis = {
      degree: 1,
      isScaleTone: true,
      chordScale: { scaleName: 'melodicMinor', rootPc: 10, tensions: [], passing: [], avoid: [] },
    } as NoteAnalysis;
    const card = buildTheoryCard(
      analysis,
      { pitch: 70, keySet: true, keyFifths: -2 },
      theoryLabelsFor(MESSAGES.ja.theory, 'normal', MESSAGES.ja.harmony.cadence),
    );
    const colorLine = card.lines.find((line) => line.label === 'カラー');
    expect(colorLine?.text).toBe('Bb 旋律的短音階');
  });

  it('falls back to the raw scale name when the locale has no name for it', () => {
    const analysis = {
      degree: 1,
      isScaleTone: true,
      chordScale: { scaleName: 'bebopDominant', rootPc: 0, tensions: [], passing: [], avoid: [] },
    } as NoteAnalysis;
    const card = buildTheoryCard(
      analysis,
      { pitch: 60, keySet: true },
      theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence),
    );
    const colorLine = card.lines.find((line) => line.label === 'Color');
    expect(colorLine?.text).toBe('C bebopDominant');
  });

  it('localizes the card from the Japanese message bundle', () => {
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 60, pitch: 64, startPpq: 0, durationPpq: 1 })],
        chordSymbols: [chordSymbol({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 })],
      }),
    );
    const analysis = result.byNoteId.get(60);
    expect(analysis).toBeDefined();
    if (analysis === undefined) return;
    const card = buildTheoryCard(
      analysis,
      { pitch: 64, keySet: true, chordRoman: 'I', chordFunction: 'tonic' },
      theoryLabelsFor(MESSAGES.ja.theory, 'normal', MESSAGES.ja.harmony.cadence),
    );
    expect(card.title).toBe('E4 — 第3音');
    const scaleLine = card.lines.find((line) => line.label === 'スケール');
    expect(scaleLine?.text).toBe('スケール度数 3');
    const chordLine = card.lines.find((line) => line.label === 'コード');
    expect(chordLine?.text).toBe('I — トニック');
  });

  it('attaches a glossary term to the chord-function line', () => {
    const analysis = { degree: 3, isScaleTone: true } as NoteAnalysis;
    const card = buildTheoryCard(
      analysis,
      { pitch: 64, keySet: true, chordFunction: 'tonic' },
      theoryLabelsFor(MESSAGES.en.theory, 'beginner', MESSAGES.en.harmony.cadence),
    );
    const chordLine = card.lines.find((line) => line.label === 'Chord');
    expect(chordLine?.term?.term).toBe('Tonic');
    expect(chordLine?.term?.definition.length).toBeGreaterThan(0);
  });

  it('attaches a glossary term to a non-chord-tone line', () => {
    const analysis = {
      degree: 7,
      isScaleTone: true,
      analyzed: { noteId: 1, labels: [{ kind: 'leadingTone', resolveTo: 60 }] },
    } as NoteAnalysis;
    const card = buildTheoryCard(
      analysis,
      { pitch: 71, keySet: true },
      theoryLabelsFor(MESSAGES.en.theory, 'theory', MESSAGES.en.harmony.cadence),
    );
    const noteLine = card.lines.find((line) => line.label === 'Note');
    expect(noteLine?.term?.term).toBe('Leading tone');
    expect(noteLine?.term?.definition.length).toBeGreaterThan(0);
  });

  it('drops the safety line for a note no chord covers', () => {
    // Without a chord libcantus has nothing to weigh the note against and never
    // answers Safe, so a rendered verdict would tell the composer their note
    // clashes with a chord the piece does not contain.
    const result = buildGuidance(
      guidanceInput({ notes: [note({ id: 63, pitch: 62, startPpq: 0, durationPpq: 1 })] }),
    );
    const analysis = result.byNoteId.get(63);
    expect(analysis?.chordSounding).toBe(false);
    // The verdict itself is still analyzed; only its line is withheld.
    expect(analysis?.safety).toBeDefined();
    if (analysis === undefined) return;
    const card = buildTheoryCard(
      analysis,
      { pitch: 62, keySet: true },
      theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence),
    );
    expect(card.lines.some((line) => line.label === 'Safety')).toBe(false);
  });

  it('keeps the safety line for a note a chord does cover', () => {
    const result = buildGuidance(
      guidanceInput({
        notes: [
          note({ id: 64, pitch: 64, startPpq: 0, durationPpq: 1 }),
          // The progression stops at beat 2, leaving this note in a gap.
          note({ id: 65, pitch: 64, startPpq: 3, durationPpq: 1 }),
        ],
        chordSymbols: [chordSymbol({ startPpq: 0, endPpq: 2, rootPc: 0, quality: 0 })],
      }),
    );
    const covered = result.byNoteId.get(64);
    const inGap = result.byNoteId.get(65);
    expect(covered?.chordSounding).toBe(true);
    expect(inGap?.chordSounding).toBe(false);
    if (covered === undefined || inGap === undefined) return;
    const labels = theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence);
    const coveredCard = buildTheoryCard(covered, { pitch: 64, keySet: true }, labels);
    const gapCard = buildTheoryCard(inGap, { pitch: 64, keySet: true }, labels);
    expect(coveredCard.lines.find((line) => line.label === 'Safety')?.text).toBe('Fits here');
    expect(gapCard.lines.some((line) => line.label === 'Safety')).toBe(false);
  });

  it('marks the scale line when the key was estimated rather than set', () => {
    const analysis = { degree: 3, isScaleTone: true, chordSounding: false } as NoteAnalysis;
    const labels = theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence);
    const set = buildTheoryCard(analysis, { pitch: 64, keySet: true }, labels);
    const estimated = buildTheoryCard(
      analysis,
      { pitch: 64, keySet: true, keyEstimated: true },
      labels,
    );
    expect(set.lines.find((line) => line.label === 'Scale')?.text).toBe('Scale degree 3');
    expect(estimated.lines.find((line) => line.label === 'Scale')?.text).toBe(
      'Scale degree 3 (key estimated from the notes)',
    );
  });

  it('switches wording between explanation levels for the same note', () => {
    const analysis = {
      degree: 7,
      isScaleTone: true,
      analyzed: { noteId: 1, labels: [{ kind: 'leadingTone', resolveTo: 60 }] },
    } as NoteAnalysis;
    const beginner = buildTheoryCard(
      analysis,
      { pitch: 71, keySet: true },
      theoryLabelsFor(MESSAGES.en.theory, 'beginner', MESSAGES.en.harmony.cadence),
    );
    const theory = buildTheoryCard(
      analysis,
      { pitch: 71, keySet: true },
      theoryLabelsFor(MESSAGES.en.theory, 'theory', MESSAGES.en.harmony.cadence),
    );
    const beginnerNote = beginner.lines.find((line) => line.label === 'Note')?.text;
    const theoryNote = theory.lines.find((line) => line.label === 'Note')?.text;
    expect(beginnerNote).toBeDefined();
    expect(theoryNote).toBeDefined();
    expect(beginnerNote).not.toBe(theoryNote);
  });
});
