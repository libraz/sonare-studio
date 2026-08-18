import { describe, expect, it } from 'vitest';
import { sectionsFromArrangement } from '@/compose/sections';
import type { TrackWithNotes } from '@/compose/tracks';
import type { EditorNote } from '@/project/types';

/**
 * Form recovery reads which spans restate which; it never names a span a verse
 * or a chorus. These tests pin the shape of the answer, the exclusions, and the
 * positioning, not the library's likeness judgement.
 */

let nextId = 1;

function note(pitch: number, startPpq: number, durationPpq = 1): EditorNote {
  return { id: nextId++, pitch, startPpq, durationPpq, velocity: 100, channel: 0 };
}

/** A bar of four quarter notes at `bar`, over the given root-relative shape. */
function bar(index: number, pitches: ReadonlyArray<number>): EditorNote[] {
  return pitches.map((pitch, beat) => note(pitch, index * 4 + beat));
}

function track(name: string, notes: EditorNote[], extra: Record<string, unknown> = {}) {
  return {
    track: { id: 1, name, color: '#fff', kind: 'midi', mute: false, solo: false, ...extra },
    notes,
  } as unknown as TrackWithNotes;
}

/** Eight bars: four of one idea, four of another, so the form is A then B. */
function twoIdeas(): EditorNote[] {
  const a = [60, 64, 67, 64];
  const b = [65, 69, 72, 69];
  return [
    ...bar(0, a),
    ...bar(1, a),
    ...bar(2, a),
    ...bar(3, a),
    ...bar(4, b),
    ...bar(5, b),
    ...bar(6, b),
    ...bar(7, b),
  ];
}

describe('sectionsFromArrangement', () => {
  it('reads nothing from an arrangement with no notes', () => {
    expect(sectionsFromArrangement([track('Piano', [])])).toEqual({
      sections: [],
      excludedTrackNames: [],
    });
  });

  it('positions sections in absolute PPQ, contiguously and in time order', () => {
    const { sections } = sectionsFromArrangement([track('Piano', twoIdeas())], undefined, 2);

    expect(sections.length).toBeGreaterThan(0);
    expect(sections[0]?.startPpq).toBe(0);
    for (const [index, section] of sections.entries()) {
      expect(section.endPpq).toBeGreaterThan(section.startPpq);
      const previous = sections[index - 1];
      if (previous !== undefined) expect(section.startPpq).toBe(previous.endPpq);
    }
  });

  it('labels a restatement with the letter of what it restates', () => {
    const { sections } = sectionsFromArrangement([track('Piano', twoIdeas())], undefined, 2);

    for (const [index, section] of sections.entries()) {
      const first = sections[section.firstOccurrence];
      expect(first?.label).toBe(section.label);
      expect(section.firstOccurrence).toBeLessThanOrEqual(index);
      expect(section.similarity).toBeGreaterThanOrEqual(0);
      expect(section.similarity).toBeLessThanOrEqual(1);
    }
    // Letters are assigned in order of first appearance, so the piece opens on A.
    expect(sections[0]?.label).toBe('A');
    expect(sections[0]?.firstOccurrence).toBe(0);
  });

  // A drum part repeats almost everywhere; pooling it would make every span a
  // restatement of the first one.
  it('excludes percussion tracks and reports them by name', () => {
    const drums = track('Drums', bar(0, [36, 38, 36, 38]), { percussion: true });
    const report = sectionsFromArrangement([track('Piano', twoIdeas()), drums]);

    expect(report.excludedTrackNames).toEqual(['Drums']);
  });

  it('reads nothing when every track is percussion', () => {
    const drums = track('Drums', bar(0, [36, 38, 36, 38]), { percussion: true });
    expect(sectionsFromArrangement([drums])).toEqual({
      sections: [],
      excludedTrackNames: ['Drums'],
    });
  });

  // The meter map decides where the bar lines are, so the same 24 quarter notes
  // are eight bars in 3/4 and six in 4/4.
  it('counts bars in the meter the project is written in', () => {
    const notes = Array.from({ length: 24 }, (_, index) => note(60 + (index % 3), index));
    const barsIn = (numerator: number): number => {
      const { sections } = sectionsFromArrangement(
        [track('Piano', notes)],
        [{ startPpq: 0, numerator, denominator: 4 }],
        2,
      );
      return sections.reduce((total, section) => total + section.bars, 0);
    };

    expect(barsIn(3)).toBe(8);
    expect(barsIn(4)).toBe(6);
  });

  // A meter change starts a new bar, so a piece that changes metre is still
  // measured against its own bar lines rather than the opening signature's.
  it('follows a meter change part way through the piece', () => {
    const notes = Array.from({ length: 24 }, (_, index) => note(60 + (index % 3), index));
    const { sections } = sectionsFromArrangement(
      [track('Piano', notes)],
      [
        { startPpq: 0, numerator: 4, denominator: 4 },
        { startPpq: 12, numerator: 3, denominator: 4 },
      ],
      2,
    );

    // Three bars of 4/4 then four of 3/4.
    expect(sections.reduce((total, section) => total + section.bars, 0)).toBe(7);
  });
});
