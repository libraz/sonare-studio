/**
 * Transient slicing for arrangement audio clips.
 *
 * The sample editor already detects onsets inside one asset; this module turns
 * those onsets into timeline cut positions for a clip, and works out where the
 * resulting slices land once they are quantized to the editor grid. Pure data:
 * no wasm, no store, no history.
 */

import { type NormalizedTempoMap, ppqToSeconds, secondsToPpq } from './tempo-map';

/** Shortest slice a cut may produce, in PPQ (a 1/64 note). */
export const MIN_SLICE_PPQ = 0.0625;

/** The clip fields slicing needs. */
export interface SliceableClip {
  startPpq: number;
  lengthPpq: number;
  sourceOffsetPpq: number;
}

/** One slice on the timeline. */
export interface AudioSlice {
  startPpq: number;
  lengthPpq: number;
  /** Longest window the slice's remaining source material can fill. */
  maxLengthPpq?: number;
}

/**
 * Converts detected onset times into timeline cut positions inside a clip.
 * Onsets are measured from the start of the backing asset, so the clip's
 * source offset decides which of them fall inside its window. Cuts closer than
 * {@link MIN_SLICE_PPQ} to the clip edges or to each other are dropped.
 *
 * @param onsetSeconds Onset times in seconds, from the start of the asset.
 * @param clip Clip window on the timeline.
 * @param tempo Normalized tempo map used for the seconds/PPQ mapping.
 * @returns Ascending timeline positions, strictly inside the clip.
 */
export function transientCutsPpq(
  onsetSeconds: ArrayLike<number>,
  clip: SliceableClip,
  tempo: NormalizedTempoMap,
): number[] {
  const sourceStartPpq = clip.startPpq - clip.sourceOffsetPpq;
  const sourceStartSeconds = ppqToSeconds(tempo, Math.max(0, sourceStartPpq));
  const endPpq = clip.startPpq + clip.lengthPpq;
  const cuts: number[] = [];
  for (let index = 0; index < onsetSeconds.length; index += 1) {
    const seconds = onsetSeconds[index];
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    const ppq = secondsToPpq(tempo, sourceStartSeconds + seconds);
    if (ppq <= clip.startPpq + MIN_SLICE_PPQ || ppq >= endPpq - MIN_SLICE_PPQ) continue;
    const previous = cuts[cuts.length - 1];
    if (previous !== undefined && ppq - previous < MIN_SLICE_PPQ) continue;
    cuts.push(ppq);
  }
  return cuts.sort((a, b) => a - b);
}

/**
 * Places slices on the grid.
 *
 * Every slice keeps its own audio and moves to the nearest grid position; a
 * slice never overtakes its predecessor. Lengths are then closed up to the
 * next slice start so quantizing leaves neither gaps nor overlapping,
 * double-sounding material. The last slice keeps its own length.
 *
 * A slice is only lengthened as far as its own `maxLengthPpq` allows, so a
 * slice never claims material its asset does not have.
 *
 * @param slices Slices in timeline order.
 * @param snap Grid snap for a timeline position (meter-aware in the app).
 * @returns The placed slices, in the same order.
 */
export function quantizeSlices(
  slices: readonly AudioSlice[],
  snap: (ppq: number) => number,
): AudioSlice[] {
  const placed: AudioSlice[] = [];
  for (const [index, slice] of slices.entries()) {
    const previous = placed[index - 1];
    const floor = previous === undefined ? 0 : previous.startPpq + MIN_SLICE_PPQ;
    const startPpq = Math.max(floor, snap(slice.startPpq));
    placed.push({ startPpq, lengthPpq: slice.lengthPpq });
  }
  return placed.map((slice, index) => {
    const next = placed[index + 1];
    const limit = Math.max(MIN_SLICE_PPQ, slices[index].maxLengthPpq ?? Number.POSITIVE_INFINITY);
    const lengthPpq =
      next === undefined
        ? Math.min(slice.lengthPpq, limit)
        : Math.max(MIN_SLICE_PPQ, Math.min(next.startPpq - slice.startPpq, limit));
    return { startPpq: slice.startPpq, lengthPpq };
  });
}
