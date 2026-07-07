/**
 * Motif generation command.
 *
 * Generates a short melodic cell with libcantus's `generateMotif`, optionally
 * transforms it (`transformMotif`) and develops it across bars against the
 * project's chord timeline (`developMotif`, so the line spells the sounding
 * harmony), then writes the notes to the active MIDI clip. With no active clip
 * the motif lands on a fresh track instead.
 *
 * libcantus lays out a motif in quarter-note beats (a bar is four beats) and
 * does not clamp generated or transposed pitches to the MIDI range; the
 * note-interchange adapter clamps them on the way in.
 */

import {
  developMotif,
  generateMotif,
  type MotifCell,
  type MotifContour,
  type MotifTransform,
  transformMotif,
} from '@libraz/libcantus';
import { buildChordTimeline } from '@/compose/chord-at-tick';
import { effectiveKeyScale } from '@/compose/key';
import { noteEventsToNewEditorNotes } from '@/compose/notes-io';
import type { RawNote } from '../midi-events';
import { getProject, notesToProjectEvents, useProjectStore } from '../store';
import { addGeneratedTrack, EDITS_PER_TRACK, materializeNote } from './generate-track';
import { execute } from './history';

/** Beats per bar the motif generator assumes (4/4). */
const BEATS_PER_BAR = 4;

/** Options for {@link generateMotifCommand}. */
export interface GenerateMotifParams {
  /** Number of four-beat bars to generate (default 2). */
  bars?: number;
  /** Melodic contour shape (default 'arch'). */
  contour?: MotifContour;
  /** Per-note diatonic-step variation probability in [0, 1] (default 0). */
  jitter?: number;
  /** Optional transform applied to the seed cell before development. */
  transform?: MotifTransform;
  /** Amount for the transform (semitones, degrees, or time factor). */
  transformAmount?: number;
  /**
   * Develop the motif against the project chord timeline so notes spell the
   * harmony (default true when a chord track exists).
   */
  develop?: boolean;
  /**
   * How to combine with the active clip's notes:
   *  - 'append' (default): keep existing notes, place the motif after them;
   *  - 'replace': overwrite the clip's notes with the motif.
   */
  mode?: 'append' | 'replace';
  /** Deterministic seed (default 0). */
  seed?: number;
}

/** Clip-relative offset in beats to append after the given notes. */
function appendOffset(notes: ReadonlyArray<{ startPpq: number; durationPpq: number }>): number {
  return notes.reduce((max, note) => Math.max(max, note.startPpq + note.durationPpq), 0);
}

/**
 * Generates a motif into the active MIDI clip, or a new track when none is
 * active.
 *
 * @param params Generation options (see {@link GenerateMotifParams}).
 * @returns The number of notes written (0 when the motif is empty).
 * @throws RangeError when `bars` is not a positive integer.
 */
export function generateMotifCommand(params: GenerateMotifParams = {}): number {
  const store = useProjectStore();
  const bars = params.bars ?? 2;
  if (!Number.isInteger(bars) || bars <= 0) {
    throw new RangeError(`Motif bars must be a positive integer, got ${bars}`);
  }
  const key = effectiveKeyScale(store.scaleHighlight);

  let cell: MotifCell = generateMotif({
    key,
    bars,
    ...(params.contour !== undefined ? { contour: params.contour } : {}),
    ...(params.jitter !== undefined ? { jitter: params.jitter } : {}),
    seed: params.seed ?? 0,
  });
  if (params.transform !== undefined) {
    cell = transformMotif(cell, params.transform, params.transformAmount, key);
  }
  const develop = params.develop ?? store.chords.length > 0;
  if (develop && store.chords.length > 0) {
    cell = developMotif(cell, buildChordTimeline(store.chords), key, bars);
  }

  const clip = store.activeClip;
  const project = getProject();

  if (clip !== null) {
    const mode = params.mode ?? 'append';
    const existing = mode === 'replace' ? [] : clip.notes;
    const offset = mode === 'replace' ? 0 : appendOffset(existing);
    const fresh = noteEventsToNewEditorNotes(cell.notes, { channel: 0, beatOffset: -offset });
    if (fresh.length === 0 && mode === 'append') return 0;
    const merged: RawNote[] = [
      ...existing.map(({ id: _id, ...note }) => note),
      ...fresh.map(materializeNote),
    ];
    execute(1, () => {
      project.setMidiEvents(clip.id, notesToProjectEvents(merged));
      store.refresh();
    });
    return fresh.length;
  }

  const fresh = noteEventsToNewEditorNotes(cell.notes, { channel: 0 });
  if (fresh.length === 0) return 0;
  const lengthPpq = bars * BEATS_PER_BAR;
  execute(EDITS_PER_TRACK, () =>
    addGeneratedTrack(store, {
      name: 'Motif',
      notes: fresh.map(materializeNote),
      startPpq: 0,
      lengthPpq,
    }),
  );
  return fresh.length;
}
