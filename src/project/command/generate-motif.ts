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
  type ChordTimeline,
  developMotif,
  generateMotif,
  type MotifCell,
  type MotifContour,
  type MotifTransform,
  transformMotif,
} from '@libraz/libcantus';
import {
  createGenerationTargetFrame,
  type GenerationTargetFrame,
} from '@/compose/generation-target';
import { effectiveKeyScale } from '@/compose/key';
import { noteEventsToNewEditorNotes } from '@/compose/notes-io';
import type { RawNote } from '../midi-events';
import { audibleMidiProjector, audibleMidiSourceWindow } from '../midi-projection';
import { getProject, notesToProjectEvents, useProjectStore } from '../store';
import { isFourFourBarRange } from '../time-signature';
import type { EditorClip } from '../types';
import { addGeneratedTrack, materializeNote, type TrackPlan } from './generate-track';
import { executeAtomic } from './history';
import { requireEditableClip } from './utils';

/** Beats per bar the motif generator assumes (4/4). */
const BEATS_PER_BAR = 4;

/** NativeSynth preset for a motif landing on a fresh track. */
const MOTIF_PRESET = 'saw-lead';

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
export function appendOffset(
  notes: ReadonlyArray<{ startPpq: number; durationPpq: number }>,
): number {
  return notes.reduce((max, note) => Math.max(max, note.startPpq + note.durationPpq), 0);
}

/** Bar count the motif command generates for (validated). */
function motifBars(params: GenerateMotifParams): number {
  const bars = params.bars ?? 2;
  if (!Number.isInteger(bars) || bars <= 0) {
    throw new RangeError(`Motif bars must be a positive integer, got ${bars}`);
  }
  return bars;
}

/**
 * Runs the libcantus motif pipeline (generate, optional transform, develop
 * against the chord timeline) into a single cell, without writing anything.
 *
 * @throws RangeError when `bars` is not a positive integer.
 */
export function buildMotifCell(
  store: ReturnType<typeof useProjectStore>,
  params: GenerateMotifParams,
  target: GenerationTargetFrame,
): MotifCell {
  const bars = motifBars(params);
  if (!isFourFourBarRange(target.timeSignatures, target.startPpq, bars)) {
    throw new RangeError('Motif generation currently supports 4/4 bars only.');
  }
  const key = effectiveKeyScale(store.scaleHighlight);
  let cell: MotifCell = generateMotif({
    key,
    bars,
    ...(params.contour !== undefined ? { contour: params.contour } : {}),
    ...(params.jitter !== undefined ? { jitter: params.jitter } : {}),
    ctx: { seed: params.seed ?? 0 },
  });
  if (params.transform !== undefined) {
    cell = transformMotif(cell, params.transform, params.transformAmount, key);
  }
  const develop = params.develop ?? store.chords.length > 0;
  if (develop && store.chords.length > 0) {
    // developMotif works in target-local beats. Its chord query must therefore
    // add the absolute target start instead of querying song-start harmony.
    const targetTimeline: ChordTimeline = {
      at: (beat) => target.chordAt(target.startPpq + beat),
      segments: [],
    };
    cell = developMotif(cell, targetTimeline, key, bars);
  }
  return cell;
}

/**
 * Builds the motif plan for a fresh track (the no-active-clip / explicit
 * new-track case) without writing to the Project.
 *
 * @returns The plan, or null when the motif is empty.
 * @throws RangeError when `bars` is not a positive integer.
 */
export function buildMotifPlan(
  store: ReturnType<typeof useProjectStore>,
  params: GenerateMotifParams = {},
): TrackPlan | null {
  const lengthPpq = motifBars(params) * BEATS_PER_BAR;
  const target = createGenerationTargetFrame({
    startPpq: 0,
    endPpq: lengthPpq,
    chords: store.chords,
    timeSignatures: store.timeSignatures,
  });
  const cell = buildMotifCell(store, params, target);
  const fresh = noteEventsToNewEditorNotes(cell.notes, { channel: 0 });
  if (fresh.length === 0) return null;
  return {
    name: 'Motif',
    notes: fresh.map(materializeNote),
    lengthPpq,
    preset: MOTIF_PRESET,
  };
}

/**
 * Builds the merged note list for writing a motif into an existing clip
 * (append after its notes, or replace them). Returns null when appending an
 * empty motif (a no-op).
 */
export function buildMotifClipMerge(
  store: ReturnType<typeof useProjectStore>,
  clip: EditorClip,
  params: GenerateMotifParams,
  mode: 'append' | 'replace',
): RawNote[] | null {
  const audible = audibleMidiProjector(clip, { expandLoops: false });
  const sourceWindow = audibleMidiSourceWindow(clip);
  const offset =
    mode === 'replace'
      ? 0
      : audible.reduce(
          (max, occurrence) => Math.max(max, occurrence.clipStartPpq + occurrence.durationPpq),
          0,
        );
  const availablePpq = sourceWindow.lengthPpq - offset;
  if (!(availablePpq > 0)) return null;
  const target = createGenerationTargetFrame({
    startPpq: clip.startPpq + offset,
    endPpq: clip.startPpq + offset + availablePpq,
    chords: store.chords,
    timeSignatures: store.timeSignatures,
  });
  const cell = buildMotifCell(store, params, target);
  const existing = mode === 'replace' ? [] : clip.notes;
  const sourceOffset = clip.sourceOffsetPpq + offset;
  const bounded = cell.notes
    .filter((note) => note.startBeat < availablePpq)
    .map((note) => ({
      ...note,
      durationBeat: Math.min(note.durationBeat, availablePpq - note.startBeat),
    }))
    .filter((note) => note.durationBeat > 0);
  const fresh = noteEventsToNewEditorNotes(bounded, {
    channel: 0,
    beatOffset: -sourceOffset,
  });
  if (fresh.length === 0 && mode === 'append') return null;
  return [...existing.map(({ id: _id, ...note }) => note), ...fresh.map(materializeNote)];
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
  const clip = store.activeClip;
  const project = getProject();

  if (clip !== null) {
    requireEditableClip(store, clip.id);
    const mode = params.mode ?? 'append';
    const merged = buildMotifClipMerge(store, clip, params, mode);
    if (merged === null) return 0;
    executeAtomic((edit) => {
      edit(1, () => project.setMidiEvents(clip.id, notesToProjectEvents(merged)));
      store.refresh();
    });
    return merged.length - (mode === 'replace' ? 0 : clip.notes.length);
  }

  const plan = buildMotifPlan(store, params);
  if (plan === null) return 0;
  executeAtomic((edit) =>
    addGeneratedTrack(
      store,
      {
        name: plan.name,
        notes: plan.notes,
        startPpq: 0,
        lengthPpq: plan.lengthPpq,
        preset: plan.preset,
      },
      edit,
    ),
  );
  return plan.notes.length;
}
