import { describe, expect, it } from 'vitest';
import { separateVoices, type TidyNote, tidyNotes } from '@/compose/tidy-notes';
import type { EditorChordSymbol } from '@/project/chords';
import type { TimeSignatureSegment } from '@/project/types';

const FOUR_FOUR: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 4, denominator: 4 }];
const C = 0;
const F = 5;

function note(pitch: number, startPpq: number, durationPpq: number, velocity = 100): TidyNote {
  return { pitch, startPpq, durationPpq, velocity };
}

function major(rootPc: number, startPpq: number, endPpq: number): EditorChordSymbol {
  return { startPpq, endPpq, rootPc, quality: 0 };
}

function tidy(notes: TidyNote[], chords: EditorChordSymbol[] = [major(C, 0, 16)], endPpq?: number) {
  return tidyNotes(notes, { gridPpq: 0.25, timeSignatures: FOUR_FOUR, chords, endPpq });
}

function span(result: TidyNote[], pitch: number, startPpq: number): [number, number] | undefined {
  const found = result.find((entry) => entry.pitch === pitch && entry.startPpq === startPpq);
  return found && [found.startPpq, found.startPpq + found.durationPpq];
}

describe('tidyNotes', () => {
  it('joins a softer re-onset on a weaker beat into the tone it follows', () => {
    const result = tidy([note(72, 0, 1, 100), note(72, 1, 1, 70), note(74, 2, 1)]);
    expect(result).toHaveLength(2);
    expect(span(result, 72, 0)).toEqual([0, 2]);
  });

  it('keeps evenly struck repeated notes apart', () => {
    const result = tidy([note(72, 0, 0.75), note(72, 1, 0.75), note(72, 2, 0.75)]);
    expect(result.map((entry) => entry.startPpq)).toEqual([0, 1, 2]);
  });

  it('drops a faint one-step ghost off the beat and outside the harmony', () => {
    const result = tidy([note(72, 0, 1), note(73, 1.25, 0.25, 20), note(76, 2, 1), note(79, 3, 1)]);
    expect(result.map((entry) => entry.pitch)).toEqual([72, 76, 79]);
  });

  it('closes a melody rest shorter than a beat', () => {
    const result = tidy([note(76, 0, 0.5), note(77, 1, 0.5), note(79, 3, 1)]);
    expect(span(result, 76, 0)).toEqual([0, 1]);
  });

  it('holds a phrase-final note to the bar line', () => {
    const result = tidy([note(72, 0, 0.5)]);
    expect(span(result, 72, 0)).toEqual([0, 4]);
  });

  it('holds a strong-beat chord tone to the next strong beat', () => {
    const result = tidy([note(72, 0, 0.5), note(74, 3.5, 0.5)], [major(C, 0, 4)]);
    expect(span(result, 72, 0)).toEqual([0, 2]);
  });

  it('never holds a note across a chord change its pitch class leaves', () => {
    const chords = [major(C, 0, 2), major(F, 2, 4), major(C, 4, 8)];
    const result = tidy(
      [note(52, 0, 0.25), note(52, 4, 1), note(79, 0, 4), note(77, 4, 4)],
      chords,
    );
    expect(span(result, 52, 0)).toEqual([0, 2]);
  });

  it('separates a piano texture and gives the broken-chord figure one length', () => {
    // Right-hand melody over an Alberti left hand, the figure struck short.
    const melody = [note(76, 0, 0.5), note(79, 2, 0.5), note(77, 4, 0.5), note(76, 6, 2)];
    const alberti = [0, 4].flatMap((bar) => [
      note(48, bar, 0.25),
      note(55, bar + 0.5, 0.25),
      note(52, bar + 1, 0.25),
      note(55, bar + 1.5, 0.25),
      note(48, bar + 2, 0.25),
      note(55, bar + 2.5, 0.25),
      note(52, bar + 3, 0.25),
      note(55, bar + 3.5, 0.25),
    ]);
    const result = tidy([...melody, ...alberti], [major(C, 0, 8)]);

    const inner = result.filter((entry) => entry.pitch === 55 || entry.pitch === 52);
    expect(new Set(inner.map((entry) => entry.durationPpq))).toEqual(new Set([0.5]));
    expect(span(result, 48, 0)).toEqual([0, 2]);
    expect(span(result, 76, 0)).toEqual([0, 2]);
    expect(result.map((entry) => entry.pitch).sort()).toEqual(
      [...melody, ...alberti].map((entry) => entry.pitch).sort(),
    );
  });

  it('drops a softer overtone struck with a lower note but keeps a firm octave', () => {
    const result = tidy([
      note(48, 0, 2, 90),
      note(60, 0, 1, 50),
      note(55, 2, 2, 80),
      note(67, 2, 2, 80),
    ]);
    expect(result.map((entry) => entry.pitch)).toEqual([48, 55, 67]);
  });

  it('reads the figure length from firm strokes, not faint misread onsets', () => {
    const strokes = [0, 1, 2, 3].flatMap((beat) => [
      note(64, beat, 0.25, 90),
      note(48, beat, 1, 90),
    ]);
    const faint = [0.25, 1.25, 2.25].map((at) => note(55, at, 0.25, 40));
    const result = tidy([note(84, 0, 4, 100), ...strokes, ...faint], [major(C, 0, 4)]);
    expect(result.filter((entry) => entry.pitch === 64).map((entry) => entry.durationPpq)).toEqual([
      1, 1, 1, 1,
    ]);
  });

  it('never extends a note past the clip end', () => {
    const result = tidy([note(72, 0, 0.5)], [major(C, 0, 8)], 1);
    expect(span(result, 72, 0)).toEqual([0, 1]);
  });

  it('reads the harmony from the notes when there is no chord track', () => {
    const result = tidy([note(72, 0, 0.5), note(64, 0, 0.5), note(55, 0, 0.5), note(74, 3, 1)], []);
    expect(span(result, 72, 0)?.[1]).toBeGreaterThanOrEqual(2);
  });

  it('carries every other field through untouched', () => {
    const [result] = tidyNotes([{ ...note(72, 0.1, 1), channel: 3, id: 9 }], {
      gridPpq: 0.25,
      timeSignatures: FOUR_FOUR,
    });
    expect(result).toMatchObject({ channel: 3, id: 9, pitch: 72, startPpq: 0 });
  });
});

describe('separateVoices', () => {
  const bars = (ppq: number) => Math.floor(ppq / 4);

  it('treats a single line as melody throughout', () => {
    const line = [60, 62, 64, 65].map((pitch, index) => ({ pitch, start: index, end: index + 1 }));
    expect(separateVoices(line, bars)).toEqual(['melody', 'melody', 'melody', 'melody']);
  });

  it('keeps a chord under a held melody note in the accompaniment', () => {
    const voices = separateVoices(
      [
        { pitch: 79, start: 0, end: 4 },
        { pitch: 64, start: 1, end: 2 },
        { pitch: 60, start: 1, end: 2 },
      ],
      bars,
    );
    expect(voices).toEqual(['melody', 'inner', 'bass']);
  });
});
