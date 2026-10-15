/**
 * Zoom-dependent clip body rendering math for the arrangement canvas: picks
 * between mini-note and density-block content and computes their geometry in
 * clip-relative unit coordinates. Pure logic: no DOM, no framework imports.
 *
 * Clip notes are source-relative; the audible window of a clip is
 * [windowStartPpq, windowStartPpq + windowLengthPpq).
 */

import { visibleNotesInWindow } from '@/components/piano-roll/visible-notes';
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

interface PitchBounds {
  minPitch: number;
  maxPitch: number;
}

const pitchBoundsCache = new WeakMap<
  ReadonlyArray<ClipNoteSpan>,
  Map<string, PitchBounds | null>
>();

function pitchBoundsForWindow(
  notes: ReadonlyArray<ClipNoteSpan>,
  startPpq: number,
  endPpq: number,
): PitchBounds | null {
  const key = `${startPpq}:${endPpq}`;
  let cache = pitchBoundsCache.get(notes);
  if (!cache) {
    cache = new Map();
    pitchBoundsCache.set(notes, cache);
  }
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let minPitch = Number.POSITIVE_INFINITY;
  let maxPitch = Number.NEGATIVE_INFINITY;
  for (const note of notes) {
    if (note.startPpq >= endPpq || note.startPpq + note.durationPpq <= startPpq) continue;
    minPitch = Math.min(minPitch, note.pitch);
    maxPitch = Math.max(maxPitch, note.pitch);
  }
  if (minPitch === Number.POSITIVE_INFINITY) {
    cache.set(key, null);
    return null;
  }
  const bounds = { minPitch, maxPitch };
  cache.set(key, bounds);
  return bounds;
}

function miniNotePitchGeometry(bounds: PitchBounds): { top: number; span: number } {
  const span = Math.max(bounds.maxPitch - bounds.minPitch + 1, MIN_MINI_NOTE_PITCH_SPAN);
  return {
    span,
    // Center the actual pitch range inside the (possibly padded) span.
    top: (bounds.minPitch + bounds.maxPitch + 1) / 2 + span / 2,
  };
}

/**
 * Computes only the mini-note rectangles intersecting a visible sub-window.
 *
 * Returned rectangles remain in the full clip-window coordinate frame, so
 * horizontal scrolling never changes their pitch scaling or moves a note's
 * x-position. The start-sorted/prefix-max-end index is built once per note
 * array; subsequent viewport changes visit the candidate visible spans only.
 *
 * @param notes - Source-relative note spans.
 * @param windowStartPpq - Full clip window start in source-relative PPQ.
 * @param windowLengthPpq - Full clip window length in PPQ (> 0).
 * @param visibleStartPpq - Visible sub-window start in source-relative PPQ.
 * @param visibleEndPpq - Visible sub-window end in source-relative PPQ.
 * @returns Rectangles intersecting the visible sub-window, in input order.
 */
export function visibleMiniNoteRects(
  notes: ReadonlyArray<ClipNoteSpan>,
  windowStartPpq: number,
  windowLengthPpq: number,
  visibleStartPpq: number,
  visibleEndPpq: number,
): UnitRect[] {
  if (!(windowLengthPpq > 0)) return [];
  const windowEndPpq = windowStartPpq + windowLengthPpq;
  const visibleStart = Math.max(windowStartPpq, visibleStartPpq);
  const visibleEnd = Math.min(windowEndPpq, visibleEndPpq);
  if (!(visibleEnd > visibleStart)) return [];

  const bounds = pitchBoundsForWindow(notes, windowStartPpq, windowEndPpq);
  if (!bounds) return [];
  const { top, span } = miniNotePitchGeometry(bounds);
  const visible = visibleNotesInWindow(notes, {
    startPpq: visibleStart,
    endPpq: visibleEnd,
    minPitch: Number.NEGATIVE_INFINITY,
    maxPitch: Number.POSITIVE_INFINITY,
  });
  return visible.map((note) => {
    const start = Math.max(note.startPpq, windowStartPpq);
    const end = Math.min(note.startPpq + note.durationPpq, windowEndPpq);
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
