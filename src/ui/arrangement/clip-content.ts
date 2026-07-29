/**
 * Zoom-dependent clip body rendering math for the arrangement canvas: picks
 * between mini-note and density-block content and computes their geometry in
 * clip-relative unit coordinates. Pure logic: no DOM, no framework imports.
 *
 * Clip notes are source-relative; the audible window of a clip is
 * [windowStartPpq, windowStartPpq + windowLengthPpq).
 */

import { projectMidiClipNoteOccurrences } from '@/project/midi-projection';
import type { EditorClip } from '@/project/types';

/** Minimum px per beat (quarter note) before mini-notes are rendered. */
export const MINI_NOTES_MIN_PX_PER_BEAT = 10;

/** How a clip body visualizes its note content. */
export type ClipContentMode = 'mini-notes' | 'density';

/**
 * Picks the clip content mode for a zoom level: individual mini-note lines at
 * high zoom, per-bar density blocks at low zoom.
 *
 * @param pxPerBeat - Horizontal zoom in px per beat (quarter note).
 * @returns The content mode to render.
 */
export function clipContentMode(pxPerBeat: number): ClipContentMode {
  return pxPerBeat >= MINI_NOTES_MIN_PX_PER_BEAT ? 'mini-notes' : 'density';
}

/** A note's extent as needed for clip content rendering. */
export interface ClipNoteSpan {
  /** Note start in source-relative PPQ. */
  startPpq: number;
  /** Note length in PPQ. */
  durationPpq: number;
  /** MIDI pitch (0..127). */
  pitch: number;
}

/**
 * Expands the audible MIDI content that belongs in an arrangement clip body.
 *
 * The engine, score, and other timeline consumers all use the shared MIDI
 * projector for trim and loop semantics. Keeping this adapter here means the
 * arrangement canvas uses those exact occurrences instead of visualizing only
 * the first source window.
 */
export function arrangementMidiNoteSpans(
  clip: Pick<
    EditorClip,
    'id' | 'notes' | 'startPpq' | 'lengthPpq' | 'sourceOffsetPpq' | 'loopEnabled' | 'loopLengthPpq'
  >,
): ClipNoteSpan[] {
  return projectMidiClipNoteOccurrences(clip).map(({ startPpq, durationPpq, pitch }) => ({
    startPpq,
    durationPpq,
    pitch,
  }));
}

/** A rectangle in clip-body unit coordinates ([0, 1] on both axes, v down). */
export interface UnitRect {
  /** Left edge as a fraction of the clip width. */
  u: number;
  /** Top edge as a fraction of the clip height. */
  v: number;
  /** Width as a fraction of the clip width. */
  uWidth: number;
  /** Height as a fraction of the clip height. */
  vHeight: number;
}

/**
 * Minimum pitch span mini-notes are scaled to, so clips with few distinct
 * pitches do not blow single notes up to the full clip height.
 */
export const MIN_MINI_NOTE_PITCH_SPAN = 8;

/**
 * Computes mini-note rectangles for the notes audible in a clip window.
 *
 * Notes are clipped to the window and mapped into unit coordinates: u spans
 * the window, v spans the pitch range of the audible notes (padded to at
 * least {@link MIN_MINI_NOTE_PITCH_SPAN} semitones and centered), with higher
 * pitches towards v = 0.
 *
 * @param notes - Source-relative note spans.
 * @param windowStartPpq - Window start in source-relative PPQ.
 * @param windowLengthPpq - Window length in PPQ (> 0).
 * @returns One rect per audible note, in input order.
 */
export function miniNoteRects(
  notes: ReadonlyArray<ClipNoteSpan>,
  windowStartPpq: number,
  windowLengthPpq: number,
): UnitRect[] {
  if (!(windowLengthPpq > 0)) return [];
  const windowEnd = windowStartPpq + windowLengthPpq;
  const audible = notes.filter(
    (note) => note.startPpq < windowEnd && note.startPpq + note.durationPpq > windowStartPpq,
  );
  if (audible.length === 0) return [];
  let minPitch = Number.POSITIVE_INFINITY;
  let maxPitch = Number.NEGATIVE_INFINITY;
  for (const note of audible) {
    minPitch = Math.min(minPitch, note.pitch);
    maxPitch = Math.max(maxPitch, note.pitch);
  }
  const span = Math.max(maxPitch - minPitch + 1, MIN_MINI_NOTE_PITCH_SPAN);
  // Center the actual pitch range inside the (possibly padded) span.
  const top = (minPitch + maxPitch + 1) / 2 + span / 2;
  return audible.map((note) => {
    const start = Math.max(note.startPpq, windowStartPpq);
    const end = Math.min(note.startPpq + note.durationPpq, windowEnd);
    return {
      u: (start - windowStartPpq) / windowLengthPpq,
      v: (top - (note.pitch + 1)) / span,
      uWidth: (end - start) / windowLengthPpq,
      vHeight: 1 / span,
    };
  });
}

/**
 * Buckets the notes audible in a clip window into fixed-size time slots and
 * returns per-bucket densities normalized to [0, 1] (peak bucket = 1).
 *
 * A note contributes to every bucket it overlaps. An all-empty clip yields
 * all-zero buckets.
 *
 * @param notes - Source-relative note spans.
 * @param windowStartPpq - Window start in source-relative PPQ.
 * @param windowLengthPpq - Window length in PPQ (> 0).
 * @param bucketPpq - Bucket size in PPQ (> 0), typically one bar.
 * @returns Normalized densities, one entry per bucket covering the window.
 */
export function densityBuckets(
  notes: ReadonlyArray<ClipNoteSpan>,
  windowStartPpq: number,
  windowLengthPpq: number,
  bucketPpq: number,
): number[] {
  if (!(windowLengthPpq > 0) || !(bucketPpq > 0)) return [];
  const bucketCount = Math.ceil(windowLengthPpq / bucketPpq - 1e-9);
  const counts = new Array<number>(bucketCount).fill(0);
  const windowEnd = windowStartPpq + windowLengthPpq;
  for (const note of notes) {
    const start = Math.max(note.startPpq, windowStartPpq);
    const end = Math.min(note.startPpq + note.durationPpq, windowEnd);
    if (end <= start) continue;
    const first = Math.floor((start - windowStartPpq) / bucketPpq);
    const last = Math.min(bucketCount - 1, Math.ceil((end - windowStartPpq) / bucketPpq) - 1);
    for (let i = first; i <= last; i++) counts[i]++;
  }
  const peak = Math.max(0, ...counts);
  if (peak === 0) return counts;
  return counts.map((count) => count / peak);
}
