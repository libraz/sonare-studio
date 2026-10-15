/**
 * Pattern <-> note conversion.
 *
 * Baking turns the pattern into plain note payloads (PPQ math honoring
 * resolution, swing, gate and per-step offsets); the editing component
 * writes them into the active MIDI clip through the project commands.
 * Unbaking ("Pull from clip") is the best-effort inverse: existing notes are
 * snapped onto the grid of a template pattern.
 */

import type { EditorNote, EditorNoteUpdate, NewEditorNote } from '@/project/types';
import { gmDrumName, pitchName } from './drum-map';
import {
  clampGate,
  clampVelocity,
  clonePattern,
  createStep,
  type PatternRow,
  type StepPattern,
} from './pattern';
import { nearestStepForPpq, stepDurationPpq, stepStartPpq } from './timing';

/** A generated note, relative to the clip source origin. */
export interface BakedNote {
  /** MIDI note number. */
  pitch: number;
  /** Note-on velocity (integer, 1-127). */
  velocity: number;
  /** Start in PPQ. */
  startPpq: number;
  /** Length in PPQ (> 0). */
  durationPpq: number;
  /** MIDI channel (9 in drum mode, 0 in pitch mode). */
  channel: number;
}

/** Options for {@link bakePattern}. */
export interface BakeOptions {
  /**
   * PPQ added to every note start (the active clip's sourceOffsetPpq, so the
   * pattern lands at the audible start of the clip). Default 0.
   */
  basePpq?: number;
}

/**
 * Converts a pattern into note payloads. Muted rows and inactive steps are
 * skipped; results are sorted by (startPpq, pitch).
 */
export function bakePattern(pattern: StepPattern, options: BakeOptions = {}): BakedNote[] {
  const basePpq = options.basePpq ?? 0;
  const channel = Math.min(15, Math.max(0, Math.round(pattern.channel)));
  const duration = stepDurationPpq(pattern.resolution);
  const notes: BakedNote[] = [];
  for (const row of pattern.rows) {
    if (row.muted) continue;
    row.steps.forEach((step, stepIndex) => {
      if (!step.active) return;
      notes.push({
        pitch: row.pitch,
        velocity: clampVelocity(step.velocity),
        startPpq: basePpq + stepStartPpq(stepIndex, pattern.resolution, pattern.swing, step.offset),
        durationPpq: clampGate(step.gate) * duration,
        channel,
      });
    });
  }
  notes.sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch);
  return notes;
}

/** Keeps baked notes inside a source window and trims tails at its right edge. */
export function trimBakedNotesToWindow(
  notes: ReadonlyArray<BakedNote>,
  startPpq: number,
  lengthPpq: number,
): BakedNote[] {
  const endPpq = startPpq + Math.max(0, lengthPpq);
  return notes
    .filter((note) => note.startPpq >= startPpq && note.startPpq < endPpq)
    .map((note) => ({
      ...note,
      durationPpq: Math.min(note.durationPpq, endPpq - note.startPpq),
    }))
    .filter((note) => note.durationPpq > 0);
}

/**
 * Command plan that replaces a clip's notes with a baked target list while
 * reusing as many existing editor note ids as possible. With the current
 * command API each non-empty member costs one undo entry, except additions
 * which cost one entry per note (there is no bulk-insert command yet), so
 * count-stable re-bakes (velocity/gate/offset/swing tweaks) undo in a single
 * step.
 */
export interface NoteReplacementPlan {
  /** Existing notes rewritten in place (one updateNotes call). */
  updates: EditorNoteUpdate[];
  /** Surplus existing notes (one deleteNotes call). */
  deleteIds: number[];
  /** Notes with no reusable id (one addNote call each). */
  additions: NewEditorNote[];
}

/** True when applying the plan would not issue any command. */
export function isEmptyPlan(plan: NoteReplacementPlan): boolean {
  return plan.updates.length === 0 && plan.deleteIds.length === 0 && plan.additions.length === 0;
}

/**
 * Diffs the clip's current notes against a baked target list.
 *
 * Both sides are ordered by (startPpq, pitch) and paired index-wise; paired
 * notes whose fields already match produce no update. Existing off-velocities
 * survive on reused ids (the update command cannot clear the field), which is
 * harmless because baked notes never set one.
 */
export function planNoteReplacement(
  existing: ReadonlyArray<EditorNote>,
  target: ReadonlyArray<BakedNote>,
): NoteReplacementPlan {
  const sortedExisting = [...existing].sort(
    (a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch || a.id - b.id,
  );
  const updates: EditorNoteUpdate[] = [];
  const additions: NewEditorNote[] = [];
  const shared = Math.min(sortedExisting.length, target.length);
  for (let i = 0; i < shared; i++) {
    const current = sortedExisting[i];
    const next = target[i];
    if (
      current.pitch === next.pitch &&
      current.velocity === next.velocity &&
      current.startPpq === next.startPpq &&
      current.durationPpq === next.durationPpq &&
      current.channel === next.channel
    ) {
      continue;
    }
    updates.push({
      id: current.id,
      pitch: next.pitch,
      velocity: next.velocity,
      startPpq: next.startPpq,
      durationPpq: next.durationPpq,
      channel: next.channel,
    });
  }
  for (let i = shared; i < target.length; i++) {
    const next = target[i];
    additions.push({
      pitch: next.pitch,
      velocity: next.velocity,
      startPpq: next.startPpq,
      durationPpq: next.durationPpq,
      channel: next.channel,
    });
  }
  return {
    updates,
    deleteIds: sortedExisting.slice(shared).map((note) => note.id),
    additions,
  };
}

/** Result of {@link patternFromNotes}. */
export interface UnbakeResult {
  /** The recovered pattern (template settings, rebuilt steps/rows). */
  pattern: StepPattern;
  /**
   * Notes that could not be represented: outside the pattern span, or
   * colliding with an earlier note on the same cell.
   */
  droppedNotes: number;
}

/**
 * Best-effort inverse of {@link bakePattern}: snaps existing clip notes onto
 * the grid of a template pattern (its mode/stepCount/resolution/swing are
 * kept, all template steps are reset first).
 *
 * Pitches without a matching template row get appended as new rows labeled
 * with their GM drum name (drum mode) or pitch name. When two notes land on
 * the same cell the earlier one wins and the rest count as dropped.
 *
 * @param notes Clip notes (clip-source PPQ space).
 * @param template Pattern supplying grid settings and the starting row set.
 * @param basePpq PPQ subtracted from note starts (the clip's sourceOffsetPpq).
 */
export function patternFromNotes(
  notes: ReadonlyArray<EditorNote>,
  template: StepPattern,
  basePpq = 0,
): UnbakeResult {
  const channels = [...new Set(notes.map((note) => note.channel))].sort((a, b) => a - b);
  if (channels.length > 1) {
    throw new RangeError(
      `Step Sequencer supports one MIDI channel at a time; clip uses channels ${channels
        .map((channel) => channel + 1)
        .join(', ')}`,
    );
  }
  const pattern = clonePattern(template);
  if (channels.length === 1) pattern.channel = channels[0];
  for (const row of pattern.rows) {
    row.muted = false;
    row.steps = row.steps.map(() => createStep());
  }
  const rowsByPitch = new Map<number, PatternRow>(pattern.rows.map((row) => [row.pitch, row]));
  const duration = stepDurationPpq(pattern.resolution);
  let droppedNotes = 0;
  const ordered = [...notes].sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch);
  for (const note of ordered) {
    const snap = nearestStepForPpq(
      note.startPpq - basePpq,
      pattern.resolution,
      pattern.swing,
      pattern.stepCount,
    );
    if (!snap) {
      droppedNotes++;
      continue;
    }
    let row = rowsByPitch.get(note.pitch);
    if (!row) {
      const name =
        (pattern.mode === 'drum' ? gmDrumName(note.pitch) : null) ?? pitchName(note.pitch);
      row = {
        pitch: note.pitch,
        name,
        muted: false,
        steps: Array.from({ length: pattern.stepCount }, () => createStep()),
      };
      pattern.rows.push(row);
      rowsByPitch.set(note.pitch, row);
    }
    const cell = row.steps[snap.step];
    if (cell.active) {
      droppedNotes++;
      continue;
    }
    cell.active = true;
    cell.velocity = clampVelocity(note.velocity);
    cell.gate = clampGate(note.durationPpq / duration);
    cell.offset = snap.offset;
  }
  return { pattern, droppedNotes };
}
