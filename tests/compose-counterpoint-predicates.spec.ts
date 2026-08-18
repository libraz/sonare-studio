/**
 * The counterpoint readings taken from libcantus's predicate suite rather than
 * from the safety verdict's reason bitfield: the forbidden melodic leap, the
 * leading-tone resolution and the ottava battuta.
 *
 * Each is exercised by a fixture that fires it and a near miss that must not,
 * since all three answer a question a hand-built pair of notes can state
 * exactly. The card's priority chain and the four verdicts that were already
 * rendered are pinned alongside, because the chain is the only place where
 * adding a reading can silence one that used to show.
 */

import { isForbiddenMelodicLeap, ReasonFlag } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { buildTheoryCard, theoryLabelsFor } from '@/compose/explain';
import { buildGuidance, type GuidanceInput, type NoteAnalysis } from '@/compose/guidance';
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

const C_MAJOR_KEY: ScaleHighlightConfig = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
/** C natural minor {0,2,3,5,7,8,10}: the key that spells Ab and reads B as the leading tone. */
const C_MINOR_KEY: ScaleHighlightConfig = { enabled: true, rootPc: 0, modeMask: 1453 };
const FOUR_FOUR: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 4, denominator: 4 }];

function guidanceInput(partial: Partial<GuidanceInput>): GuidanceInput {
  return {
    notes: [],
    clipStartPpq: 0,
    clipLengthPpq: 8,
    chordSymbols: [],
    key: C_MAJOR_KEY,
    timeSignatures: FOUR_FOUR,
    ...partial,
  };
}

/** A two-note active line, so the reading is measured across exactly one step. */
function twoNoteLine(first: number, second: number): EditorNote[] {
  return [
    note({ id: 1, pitch: first, startPpq: 0, durationPpq: 1 }),
    note({ id: 2, pitch: second, startPpq: 1, durationPpq: 1 }),
  ];
}

/** The other voice as a track of its own, one note per slot. */
function otherVoice(pitches: number[]): { track: EditorTrack; notes: EditorNote[] } {
  return {
    track: track({ id: 2, name: 'Lower' }),
    notes: pitches.map((pitch, index) =>
      note({ id: 500 + index, pitch, startPpq: index, durationPpq: 1 }),
    ),
  };
}

/** The counterpoint findings of the second note of a two-note line. */
function findingsOf(input: Partial<GuidanceInput>): NoteAnalysis['counterpoint'] {
  return buildGuidance(guidanceInput(input)).byNoteId.get(2)?.counterpoint;
}

/** Every counterpoint line the card renders for an analysis, in order. */
function counterpointTexts(
  analysis: NoteAnalysis,
  pitch: number,
  locale: 'en' | 'ja' = 'en',
  level = 'normal',
): string[] {
  const card = buildTheoryCard(
    analysis,
    { pitch, keySet: true },
    theoryLabelsFor(MESSAGES[locale].theory, level, MESSAGES[locale].harmony.cadence),
  );
  const label = MESSAGES[locale].theory.lines.counterpoint;
  return card.lines.filter((line) => line.label === label).map((line) => line.text);
}

describe('forbidden melodic leap', () => {
  it('flags the augmented second of the minor key', () => {
    // Ab4 -> B4 in C minor: three semitones written as a second, which is the
    // step the harmonic minor puts in a line and strict counterpoint refuses.
    expect(findingsOf({ notes: twoNoteLine(68, 71), key: C_MINOR_KEY })?.forbiddenLeap).toBe(true);
  });

  it('leaves a plain minor third alone', () => {
    // A4 -> C5: the same kind of small leap, written as a third.
    expect(findingsOf({ notes: twoNoteLine(69, 72), key: C_MINOR_KEY })?.forbiddenLeap).toBe(
      undefined,
    );
  });

  it('reads the spelled question, which bare MIDI cannot state', () => {
    // The two notes above are three semitones apart, and three semitones alone
    // is a minor third: the library's integer form says so itself. Every
    // augmented second in a piece is lost the moment this call is handed
    // pitches instead of spellings, silently and with no failing verdict to
    // show for it, which is why the sounding answer is pinned here next to the
    // spelled one.
    expect(isForbiddenMelodicLeap(68, 71)).toBe(false);
    expect(findingsOf({ notes: twoNoteLine(68, 71), key: C_MINOR_KEY })?.forbiddenLeap).toBe(true);
  });

  it('flags a tritone and a seventh, which spelling cannot excuse', () => {
    expect(findingsOf({ notes: twoNoteLine(60, 66) })?.forbiddenLeap).toBe(true);
    expect(findingsOf({ notes: twoNoteLine(60, 70) })?.forbiddenLeap).toBe(true);
  });
});

describe('leading-tone resolution', () => {
  it('reports the seventh degree stepping up to the tonic', () => {
    expect(
      findingsOf({ notes: twoNoteLine(71, 72), key: C_MINOR_KEY })?.leadingToneResolution,
    ).toBe(true);
  });

  it('says nothing when the seventh is a whole step below the tonic', () => {
    // Bb4 -> C5 in C minor: the natural minor's own seventh, which does not
    // lead anywhere and is not resolving when it rises.
    expect(
      findingsOf({ notes: twoNoteLine(70, 72), key: C_MINOR_KEY })?.leadingToneResolution,
    ).toBe(undefined);
  });

  it('is withheld when no key was set', () => {
    // With highlighting off the analysis falls back to C major, and announcing
    // a resolution in a key nobody chose is a claim the card cannot support.
    const key: ScaleHighlightConfig = { enabled: false, rootPc: 0, modeMask: MAJOR_MODE_MASK };
    expect(findingsOf({ notes: twoNoteLine(71, 72), key })?.leadingToneResolution).toBe(undefined);
  });
});

describe('ottava battuta', () => {
  it('flags an octave reached by contrary motion with the upper voice leaping down', () => {
    // C6 -> E5 over G3 -> E4: the voices close on an octave from opposite
    // sides, the upper one arriving by a leap downward.
    const findings = findingsOf({
      notes: twoNoteLine(84, 76),
      otherTracks: [otherVoice([55, 64])],
    });
    expect(findings?.battuta).toBe(true);
  });

  it('leaves a stepwise arrival at the same octave alone', () => {
    // F5 -> E5 over the same rising lower voice: contrary motion into the same
    // octave, but the upper voice steps into it, which the rule allows.
    const findings = findingsOf({
      notes: twoNoteLine(77, 76),
      otherTracks: [otherVoice([55, 64])],
    });
    expect(findings?.battuta).toBe(undefined);
  });

  it('survives the contrary-motion dismissal the parallel reading applies', () => {
    // A5 -> A4 over A3 -> A4: octave classes on both sides, so the library
    // calls it a parallel and the suppression drops it as contrary motion —
    // correctly, since nothing runs parallel. The battuta is a different rule
    // about exactly that motion, and it must still be reported.
    const result = buildGuidance(
      guidanceInput({ notes: twoNoteLine(81, 69), otherTracks: [otherVoice([45, 57])] }),
    );
    const analysis = result.byNoteId.get(2);
    expect((analysis?.safety?.reasons ?? 0) & ReasonFlag.ParallelPerfect).toBe(0);
    expect(analysis?.counterpoint?.battuta).toBe(true);
  });
});

describe('counterpoint card lines', () => {
  it('names the single most salient fault when two readings fire', () => {
    // D4 -> Ab3 under a held C4: a diminished fifth (a forbidden leap) that
    // also lands below the voice above it. Both readings are recorded, and the
    // card names the voice crossing — the fault that describes the two voices
    // rather than the line the composer is already looking at.
    const result = buildGuidance(
      guidanceInput({
        notes: twoNoteLine(62, 56),
        otherTracks: [
          {
            track: track({ id: 2, name: 'Alto' }),
            notes: [note({ id: 600, pitch: 60, startPpq: 0, durationPpq: 2 })],
          },
        ],
      }),
    );
    const analysis = result.byNoteId.get(2);
    expect(analysis).toBeDefined();
    if (analysis === undefined) return;
    expect(analysis.counterpoint?.forbiddenLeap).toBe(true);
    expect((analysis.safety?.reasons ?? 0) & ReasonFlag.VoiceCrossing).toBeTruthy();
    expect(counterpointTexts(analysis, 56)).toContain('Voice crossing');
    expect(counterpointTexts(analysis, 56)).not.toContain(
      'Forbidden melodic leap from the previous note',
    );
  });

  it('shows the leading-tone resolution beside a fault instead of competing with it', () => {
    // The positive reading is not ranked against the faults: a correct
    // resolution must not hide a parallel octave, and a parallel octave must
    // not make the card silent about the resolution.
    const analysis = {
      degree: 1,
      isScaleTone: true,
      chordSounding: false,
      safety: { reasons: ReasonFlag.ParallelPerfect },
      counterpoint: { forbiddenLeap: true, leadingToneResolution: true },
    } as NoteAnalysis;
    expect(counterpointTexts(analysis, 72)).toEqual([
      'Parallel perfect interval',
      'Leading tone resolved up to the tonic here',
    ]);
  });

  it('renders each new verdict with its glossary term', () => {
    const labels = theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence);
    const cardFor = (counterpoint: NoteAnalysis['counterpoint']) =>
      buildTheoryCard(
        { degree: 1, isScaleTone: true, chordSounding: false, counterpoint } as NoteAnalysis,
        { pitch: 72, keySet: true },
        labels,
      ).lines.filter((line) => line.label === 'Counterpoint');

    expect(cardFor({ forbiddenLeap: true })[0]).toEqual({
      label: 'Counterpoint',
      text: 'Forbidden melodic leap from the previous note',
      term: MESSAGES.en.theory.glossary.forbiddenLeap,
    });
    expect(cardFor({ battuta: true })[0]).toEqual({
      label: 'Counterpoint',
      text: 'Battuta — octave by contrary motion, upper voice leaping down',
      term: MESSAGES.en.theory.glossary.battuta,
    });
    expect(cardFor({ leadingToneResolution: true })[0]).toEqual({
      label: 'Counterpoint',
      text: 'Leading tone resolved up to the tonic here',
      term: MESSAGES.en.theory.glossary.leadingToneResolution,
    });
    expect(cardFor({ wideSpacing: true })[0]).toEqual({
      label: 'Counterpoint',
      text: 'Wide spacing — over an octave to the neighbouring voice',
      term: MESSAGES.en.theory.glossary.wideSpacing,
    });
  });

  it('puts the spacing under the leap, being the standing condition of the two', () => {
    // Spacing holds for as long as the registers do and the leap is an event,
    // so on a note carrying both the card reports the event.
    const labels = theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence);
    const cardFor = (counterpoint: NoteAnalysis['counterpoint']) =>
      buildTheoryCard(
        { degree: 1, isScaleTone: true, chordSounding: false, counterpoint } as NoteAnalysis,
        { pitch: 72, keySet: true },
        labels,
      ).lines.filter((line) => line.label === 'Counterpoint');

    expect(cardFor({ forbiddenLeap: true, wideSpacing: true }).map((line) => line.text)).toEqual([
      'Forbidden melodic leap from the previous note',
    ]);
    expect(cardFor({ wideSpacing: true }).map((line) => line.text)).toEqual([
      'Wide spacing — over an octave to the neighbouring voice',
    ]);
  });

  it('writes the new verdicts in Japanese too', () => {
    const analysis = {
      degree: 1,
      isScaleTone: true,
      chordSounding: false,
      counterpoint: { battuta: true, leadingToneResolution: true },
    } as NoteAnalysis;
    expect(counterpointTexts(analysis, 72, 'ja')).toEqual([
      'バットゥータ — 反行でオクターヴに入り、上声が下行跳躍',
      '導音がここで主音へ解決',
    ]);
  });

  it('still renders the four verdicts that ride the safety reasons', () => {
    // Parallel fifths, a hidden perfect, a voice crossing and a suspension,
    // each from a fixture of its own: inserting readings into the chain must
    // not reorder or displace any of them.
    const parallel = buildGuidance(
      guidanceInput({ notes: twoNoteLine(60, 62), otherTracks: [otherVoice([53, 55])] }),
    );
    const hidden = buildGuidance(
      guidanceInput({ notes: twoNoteLine(62, 72), otherTracks: [otherVoice([55, 60])] }),
    );
    const crossing = buildGuidance(
      guidanceInput({
        notes: twoNoteLine(62, 58),
        otherTracks: [
          {
            track: track({ id: 2, name: 'Alto' }),
            notes: [note({ id: 610, pitch: 60, startPpq: 0, durationPpq: 2 })],
          },
        ],
      }),
    );
    const suspension = buildGuidance(
      guidanceInput({
        notes: [
          note({ id: 1, pitch: 72, startPpq: 1, durationPpq: 1 }),
          note({ id: 2, pitch: 72, startPpq: 2, durationPpq: 1 }),
        ],
        otherTracks: [
          {
            track: track({ id: 2, name: 'Bass' }),
            notes: [
              note({ id: 620, pitch: 60, startPpq: 1, durationPpq: 1 }),
              note({ id: 621, pitch: 62, startPpq: 2, durationPpq: 1 }),
            ],
          },
        ],
      }),
    );

    const verdicts = (result: ReturnType<typeof buildGuidance>, pitch: number): string[] => {
      const analysis = result.byNoteId.get(2);
      expect(analysis).toBeDefined();
      return analysis === undefined ? [] : counterpointTexts(analysis, pitch);
    };
    expect(verdicts(parallel, 62)).toContain('Parallel perfect interval');
    expect(verdicts(hidden, 72)).toContain('Hidden perfect interval');
    expect(verdicts(crossing, 58)).toContain('Voice crossing');
    expect(verdicts(suspension, 72)).toContain('Suspension — resolves by step');
  });
});
