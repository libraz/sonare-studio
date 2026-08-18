import { describe, expect, it } from 'vitest';
import { ORNAMENT_MARKS, planOrnaments } from '@/compose/ornaments';
import type { EditorNote } from '@/project/types';

/**
 * A decoration is a reading of the passage, not a setting applied to it, so
 * these pin what the plan promises a caller: that it says which editor note
 * each mark lands on, that it answers honestly when the technique has nothing
 * to sit on, and that it never proposes to touch a note marked by hand.
 */

let nextId = 1;

function note(pitch: number, startPpq: number, durationPpq = 1): EditorNote {
  return { id: nextId++, pitch, startPpq, durationPpq, velocity: 100, channel: 0 };
}

/** A run of eighths, which gives weak positions for a ghost to fall on. */
function eighths(count = 16): EditorNote[] {
  const notes: EditorNote[] = [];
  for (let index = 0; index < count; index += 1) {
    notes.push(note(48 + (index % 4), index * 0.5, 0.5));
  }
  return notes;
}

/** Whole notes on the downbeat: strong positions only. */
function wholeNotes(count = 4): EditorNote[] {
  const notes: EditorNote[] = [];
  for (let index = 0; index < count; index += 1) {
    notes.push(note(60, index * 4, 4));
  }
  return notes;
}

describe('planOrnaments', () => {
  it('reads nothing from a passage with no notes', () => {
    expect(planOrnaments([], { mark: 'ghost', amount: 1 })).toEqual({
      marks: [],
      candidateCount: 0,
    });
  });

  it('marks notes of the passage and names the technique it was asked for', () => {
    const notes = eighths();
    const plan = planOrnaments(notes, { mark: 'ghost', amount: 1 });

    expect(plan.candidateCount).toBe(notes.length);
    expect(plan.marks.length).toBeGreaterThan(0);
    const ids = new Set(notes.map((entry) => entry.id));
    for (const mark of plan.marks) {
      expect(ids.has(mark.noteId)).toBe(true);
      expect(mark.articulation).toBe('ghost');
    }
    // Each note is named at most once.
    expect(new Set(plan.marks.map((mark) => mark.noteId)).size).toBe(plan.marks.length);
  });

  /**
   * The whole reason the panel shows a count: a technique that needs weak
   * positions has nothing to sit on in a passage that has none, and the honest
   * answer is none rather than a mark on the wrong beat.
   */
  it('marks nothing when the passage has no position the technique wants', () => {
    const plan = planOrnaments(wholeNotes(), { mark: 'ghost', amount: 1 });

    expect(plan.candidateCount).toBe(4);
    expect(plan.marks).toEqual([]);
  });

  it('raising the amount adds marks without moving the ones already placed', () => {
    const notes = eighths();
    const steps = [0.25, 0.5, 1].map((amount) =>
      planOrnaments(notes, { mark: 'ghost', amount }).marks.map((mark) => mark.noteId),
    );

    for (const [index, ids] of steps.entries()) {
      if (index === 0) continue;
      expect(ids.length).toBeGreaterThan(steps[index - 1].length);
      const wider = new Set(ids);
      for (const id of steps[index - 1]) expect(wider.has(id)).toBe(true);
    }
  });

  it('plans the same marks for the same seed and differs on another', () => {
    const notes = eighths();
    const ids = (seed: number) =>
      planOrnaments(notes, { mark: 'ghost', amount: 0.5, seed })
        .marks.map((mark) => mark.noteId)
        .join(',');

    expect(ids(7)).toBe(ids(7));
    expect(ids(7)).not.toBe(ids(8));
  });

  it('leaves the notes it was told to keep out of the plan entirely', () => {
    const notes = eighths();
    const all = planOrnaments(notes, { mark: 'ghost', amount: 1 });
    const kept = new Set([all.marks[0].noteId]);
    const plan = planOrnaments(notes, { mark: 'ghost', amount: 1, keep: kept });

    expect(plan.candidateCount).toBe(notes.length - 1);
    expect(plan.marks.map((mark) => mark.noteId)).not.toContain(all.marks[0].noteId);
  });

  // A note of no length never sounds, so the library drops it; counting it here
  // would pair every later note with the wrong editor id.
  it('ignores notes that never sound', () => {
    const notes = [...eighths(), note(60, 0, 0)];
    const plan = planOrnaments(notes, { mark: 'ghost', amount: 1 });

    expect(plan.candidateCount).toBe(notes.length - 1);
    expect(plan.marks.every((mark) => mark.articulation === 'ghost')).toBe(true);
  });

  it('offers every technique the library can apply, and each one can mark', () => {
    const notes = eighths();
    const marking = ORNAMENT_MARKS.filter(
      (mark) => planOrnaments(notes, { mark, amount: 1 }).marks.length > 0,
    );
    expect(marking).toEqual([...ORNAMENT_MARKS]);
  });

  /**
   * The ceiling governs the timing layer: strokes that come too fast to sustain
   * are left plain, so the same request thins out as the tempo rises.
   */
  it('drops decoration a fast tempo puts out of reach of a low ceiling', () => {
    const notes = eighths(32);
    const marks = (bpm: number, difficulty: number) =>
      planOrnaments(notes, { mark: 'ghost', amount: 1, bpm, difficulty }).marks.length;

    expect(marks(240, 1)).toBeLessThan(marks(240, 5));
    expect(marks(240, 1)).toBeLessThan(marks(80, 1));
  });
});
