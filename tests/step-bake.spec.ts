import { describe, expect, it } from 'vitest';
import type { EditorNote } from '@/project/types';
import {
  type BakedNote,
  bakePattern,
  isEmptyPlan,
  patternFromNotes,
  planNoteReplacement,
} from '@/ui/step-sequencer/bake';
import {
  createDrumPattern,
  createPitchPattern,
  withRowMuted,
  withStep,
  withSwing,
} from '@/ui/step-sequencer/pattern';

/** Wraps baked notes as editor notes with sequential ids. */
function asEditorNotes(baked: ReadonlyArray<BakedNote>, firstId = 1): EditorNote[] {
  return baked.map((note, i) => ({ id: firstId + i, ...note }));
}

describe('bakePattern', () => {
  it('bakes active steps of a drum pattern onto channel 9', () => {
    let pattern = createDrumPattern();
    const kickRow = pattern.rows.length - 1; // pitch 36
    pattern = withStep(pattern, kickRow, 0, { active: true, velocity: 110 });
    pattern = withStep(pattern, kickRow, 8, { active: true, velocity: 90 });

    const notes = bakePattern(pattern);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toEqual({
      pitch: 36,
      velocity: 110,
      startPpq: 0,
      durationPpq: 0.5 * 0.25,
      channel: 9,
    });
    expect(notes[1].startPpq).toBe(2);
    expect(notes[1].velocity).toBe(90);
  });

  it('bakes pitch-mode patterns onto channel 0', () => {
    let pattern = createPitchPattern(48);
    pattern = withStep(pattern, 0, 0, { active: true });
    const notes = bakePattern(pattern);
    expect(notes).toEqual([
      { pitch: 59, velocity: 96, startPpq: 0, durationPpq: 0.125, channel: 0 },
    ]);
  });

  it('honors gate, offset, swing and the base PPQ', () => {
    let pattern = createDrumPattern();
    pattern = withSwing(pattern, 100);
    const row = 0;
    pattern = withStep(pattern, row, 1, { active: true, gate: 1, offset: 0.25 });
    const notes = bakePattern(pattern, { basePpq: 8 });
    expect(notes).toHaveLength(1);
    // base + step + swing (duration/3) + offset (duration/4)
    expect(notes[0].startPpq).toBeCloseTo(8 + 0.25 + 0.25 / 3 + 0.0625, 12);
    expect(notes[0].durationPpq).toBeCloseTo(0.25, 12);
  });

  it('skips muted rows and inactive steps', () => {
    let pattern = createDrumPattern();
    pattern = withStep(pattern, 0, 0, { active: true });
    pattern = withStep(pattern, 1, 0, { active: true });
    pattern = withRowMuted(pattern, 0, true);
    const notes = bakePattern(pattern);
    expect(notes).toHaveLength(1);
    expect(notes[0].pitch).toBe(pattern.rows[1].pitch);
  });

  it('sorts output by start position then pitch', () => {
    let pattern = createDrumPattern();
    pattern = withStep(pattern, 0, 4, { active: true });
    pattern = withStep(pattern, 9, 0, { active: true });
    pattern = withStep(pattern, 3, 0, { active: true });
    const notes = bakePattern(pattern);
    expect(notes.map((note) => note.startPpq)).toEqual([0, 0, 1]);
    expect(notes[0].pitch).toBeLessThan(notes[1].pitch);
  });
});

describe('planNoteReplacement', () => {
  const baked: BakedNote[] = [
    { pitch: 36, velocity: 100, startPpq: 0, durationPpq: 0.125, channel: 9 },
    { pitch: 38, velocity: 90, startPpq: 1, durationPpq: 0.125, channel: 9 },
  ];

  it('is empty when the clip already matches', () => {
    const plan = planNoteReplacement(asEditorNotes(baked), baked);
    expect(isEmptyPlan(plan)).toBe(true);
  });

  it('rewrites existing notes in place when counts match', () => {
    const existing = asEditorNotes([
      { pitch: 40, velocity: 64, startPpq: 0.5, durationPpq: 0.25, channel: 0 },
      { pitch: 41, velocity: 64, startPpq: 2, durationPpq: 0.25, channel: 0 },
    ]);
    const plan = planNoteReplacement(existing, baked);
    expect(plan.updates).toHaveLength(2);
    expect(plan.deleteIds).toHaveLength(0);
    expect(plan.additions).toHaveLength(0);
    expect(plan.updates[0]).toEqual({
      id: 1,
      pitch: 36,
      velocity: 100,
      startPpq: 0,
      durationPpq: 0.125,
      channel: 9,
    });
  });

  it('deletes surplus notes and adds missing ones', () => {
    const existing = asEditorNotes([
      ...baked,
      { pitch: 42, velocity: 80, startPpq: 2, durationPpq: 0.125, channel: 9 },
    ]);
    const shrink = planNoteReplacement(existing, baked);
    expect(shrink.updates).toHaveLength(0);
    expect(shrink.deleteIds).toEqual([3]);
    expect(shrink.additions).toHaveLength(0);

    const grow = planNoteReplacement(asEditorNotes(baked.slice(0, 1)), baked);
    expect(grow.updates).toHaveLength(0);
    expect(grow.deleteIds).toHaveLength(0);
    expect(grow.additions).toEqual([baked[1]]);
  });

  it('pairs by timeline order regardless of input order', () => {
    const existing = asEditorNotes([baked[1], baked[0]]);
    // ids were assigned in reversed order, so id 2 holds the earlier note
    const plan = planNoteReplacement(existing, baked);
    expect(isEmptyPlan(plan)).toBe(true);
  });
});

describe('patternFromNotes (pull from clip)', () => {
  it('round-trips a baked pattern', () => {
    let pattern = createDrumPattern();
    pattern = withSwing(pattern, 60);
    pattern = withStep(pattern, 0, 0, { active: true, velocity: 101, gate: 0.8 });
    pattern = withStep(pattern, 3, 5, { active: true, velocity: 77, offset: 0.25 });
    pattern = withStep(pattern, 9, 15, { active: true, velocity: 55, gate: 0.2, offset: -0.25 });

    const notes = asEditorNotes(bakePattern(pattern));
    const { pattern: recovered, droppedNotes } = patternFromNotes(notes, pattern);

    expect(droppedNotes).toBe(0);
    expect(recovered.stepCount).toBe(pattern.stepCount);
    for (let r = 0; r < pattern.rows.length; r++) {
      for (let s = 0; s < pattern.stepCount; s++) {
        const expected = pattern.rows[r].steps[s];
        const actual = recovered.rows[r].steps[s];
        expect(actual.active).toBe(expected.active);
        if (!expected.active) continue;
        expect(actual.velocity).toBe(expected.velocity);
        expect(actual.gate).toBeCloseTo(expected.gate, 9);
        expect(actual.offset).toBeCloseTo(expected.offset, 9);
      }
    }
  });

  it('subtracts the base PPQ before snapping', () => {
    const notes: EditorNote[] = [
      { id: 1, pitch: 36, velocity: 100, startPpq: 8.25, durationPpq: 0.125, channel: 9 },
    ];
    const { pattern, droppedNotes } = patternFromNotes(notes, createDrumPattern(), 8);
    expect(droppedNotes).toBe(0);
    const kickRow = pattern.rows.find((row) => row.pitch === 36);
    expect(kickRow?.steps[1].active).toBe(true);
  });

  it('drops notes beyond the pattern span', () => {
    const notes: EditorNote[] = [
      { id: 1, pitch: 36, velocity: 100, startPpq: 0, durationPpq: 0.125, channel: 9 },
      { id: 2, pitch: 36, velocity: 100, startPpq: 12, durationPpq: 0.125, channel: 9 },
    ];
    const { pattern, droppedNotes } = patternFromNotes(notes, createDrumPattern());
    expect(droppedNotes).toBe(1);
    expect(pattern.rows.find((row) => row.pitch === 36)?.steps[0].active).toBe(true);
  });

  it('keeps the first note when two collide on one cell', () => {
    const notes: EditorNote[] = [
      { id: 1, pitch: 36, velocity: 100, startPpq: 0, durationPpq: 0.125, channel: 9 },
      { id: 2, pitch: 36, velocity: 50, startPpq: 0.05, durationPpq: 0.125, channel: 9 },
    ];
    const { pattern, droppedNotes } = patternFromNotes(notes, createDrumPattern());
    expect(droppedNotes).toBe(1);
    const kickRow = pattern.rows.find((row) => row.pitch === 36);
    expect(kickRow?.steps[0].velocity).toBe(100);
  });

  it('appends rows for pitches missing from the template', () => {
    const notes: EditorNote[] = [
      { id: 1, pitch: 56, velocity: 100, startPpq: 0, durationPpq: 0.125, channel: 9 },
      { id: 2, pitch: 90, velocity: 100, startPpq: 0.25, durationPpq: 0.125, channel: 9 },
    ];
    const { pattern, droppedNotes } = patternFromNotes(notes, createDrumPattern());
    expect(droppedNotes).toBe(0);
    const cowbell = pattern.rows.find((row) => row.pitch === 56);
    expect(cowbell?.name).toBe('Cowbell');
    expect(cowbell?.steps[0].active).toBe(true);
    // Outside the GM map the row falls back to the pitch name.
    expect(pattern.rows.find((row) => row.pitch === 90)?.name).toBe('F#6');
  });

  it('resets template steps and mutes before capturing', () => {
    let template = createDrumPattern();
    template = withStep(template, 0, 0, { active: true });
    template = withRowMuted(template, 0, true);
    const { pattern } = patternFromNotes([], template);
    expect(pattern.rows[0].muted).toBe(false);
    expect(pattern.rows.every((row) => row.steps.every((step) => !step.active))).toBe(true);
  });
});
