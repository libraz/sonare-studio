/**
 * Transient-onset helpers for the sample editor: turn the detector's onset times
 * into frame positions, and snap or slice a frame to those positions. Pure data
 * module: no DOM, no wasm, no store access (the wasm call itself lives in
 * wasm-ops.ts).
 */

import type { SampleRange } from './ops';

/**
 * Converts onset times in seconds to sorted, deduplicated frame indices inside
 * [0, totalFrames). Non-finite, negative and out-of-range entries are dropped.
 *
 * @param seconds Onset times in seconds (the detector's output).
 * @param sampleRate Sample rate in Hz (> 0).
 * @param totalFrames Total frames; onsets at or past this are dropped.
 * @returns Frame positions in ascending order.
 */
export function onsetSecondsToFrames(
  seconds: ArrayLike<number>,
  sampleRate: number,
  totalFrames: number,
): number[] {
  const frames = new Set<number>();
  for (let i = 0; i < seconds.length; i++) {
    const value = seconds[i];
    if (!Number.isFinite(value) || value < 0) continue;
    const frame = Math.round(value * sampleRate);
    if (frame < 0 || frame >= totalFrames) continue;
    frames.add(frame);
  }
  return [...frames].sort((a, b) => a - b);
}

/**
 * Turns silence-split intervals (a flat [start0, end0, start1, end1, …] list of
 * sample positions bounding the non-silent regions) into interior cut markers:
 * every distinct boundary strictly inside (0, totalFrames), sorted ascending.
 * Boundaries at 0 or at/after the end are dropped (they need no cut), as are
 * non-finite and out-of-range entries. The markers feed the same overlay as the
 * transient onsets, so a click picks the slice (silent or not) between two cuts.
 *
 * @param boundaries Flat interval bounds in samples (the detector's output).
 * @param totalFrames Total frames; only cuts inside (0, totalFrames) are kept.
 * @returns Cut positions in ascending order.
 */
export function silenceSplitMarkers(boundaries: ArrayLike<number>, totalFrames: number): number[] {
  const frames = new Set<number>();
  for (let i = 0; i < boundaries.length; i++) {
    const frame = boundaries[i];
    if (!Number.isFinite(frame) || frame <= 0 || frame >= totalFrames) continue;
    frames.add(Math.round(frame));
  }
  return [...frames].sort((a, b) => a - b);
}

/** One detected note region: where it sounds, and at what pitch. */
export interface DetectedNote {
  /** First frame of the note. */
  startFrame: number;
  /** One past the note's last frame. */
  endFrame: number;
  /** Detected pitch as a (fractional) MIDI note number. */
  midi: number;
}

/**
 * Turns detected note regions into overlay cut markers: both edges of every
 * note, so a click picks the note itself rather than the note plus whatever
 * follows it. Legato notes share an edge, and the whole-file bounds need no
 * cut, so the result is deduplicated and restricted to (0, totalFrames).
 *
 * @param notes Detected note regions in ascending order.
 * @param totalFrames Total frames; only cuts inside (0, totalFrames) are kept.
 * @returns Cut positions in ascending order.
 */
export function noteRegionMarkers(
  notes: ReadonlyArray<DetectedNote>,
  totalFrames: number,
): number[] {
  const frames = new Set<number>();
  for (const note of notes) {
    for (const edge of [note.startFrame, note.endFrame]) {
      if (!Number.isFinite(edge) || edge <= 0 || edge >= totalFrames) continue;
      frames.add(Math.round(edge));
    }
  }
  return [...frames].sort((a, b) => a - b);
}

/**
 * Snaps a frame to the nearest onset within `tolerance` frames, returning the
 * frame unchanged when none is close enough. On a tie the earlier onset wins.
 *
 * @param frame Frame to snap.
 * @param onsets Onset frames in ascending order.
 * @param tolerance Maximum snap distance in frames (>= 0).
 * @returns The snapped frame, or the original when nothing is in range.
 */
export function snapFrameToOnsets(
  frame: number,
  onsets: ReadonlyArray<number>,
  tolerance: number,
): number {
  let best = frame;
  let bestDist = tolerance + 1;
  for (const onset of onsets) {
    const dist = Math.abs(onset - frame);
    if (dist < bestDist) {
      best = onset;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Returns the slice between the onset at or before `frame` and the next onset;
 * the last slice runs to `totalFrames`. Returns null when no onset sits at or
 * before the frame, or the resulting slice would be empty.
 *
 * @param frame Frame the slice must contain.
 * @param onsets Onset frames in ascending order.
 * @param totalFrames Total frames (the trailing slice ends here).
 * @returns The slice range, or null when there is none.
 */
export function sliceRangeAt(
  frame: number,
  onsets: ReadonlyArray<number>,
  totalFrames: number,
): SampleRange | null {
  let startFrame = -1;
  let endFrame = totalFrames;
  for (const onset of onsets) {
    if (onset <= frame) startFrame = onset;
    else {
      endFrame = onset;
      break;
    }
  }
  if (startFrame < 0 || endFrame <= startFrame) return null;
  return { startFrame, endFrame };
}
