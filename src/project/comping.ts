/**
 * Comping helpers for audio clips with takes: comp-segment sanitization and
 * the expansion of a clip into playable audio segments. The expansion is the
 * single source of truth shared by live scheduling
 * (src/project/scheduling.ts) and the offline export renderer
 * (src/export/engine-render.ts), so a comped clip sounds identical live and
 * in exports.
 */

import { MAX_LOOP_OCCURRENCES, MIN_LOOP_WINDOW_PPQ } from './midi-projection';
import type { ClipCompSegment, ClipTake } from './types';

/** Default short comp-boundary crossfade used to avoid clicks at hard edits. */
export const DEFAULT_COMP_CROSSFADE_PPQ = 0.02;

/** The clip fields the comping helpers read (Editor and Document clips both fit). */
export interface CompableClipFields {
  lengthPpq: number;
  sourceOffsetPpq: number;
  assetId?: string;
  loopEnabled?: boolean;
  loopLengthPpq?: number;
  fadeInPpq?: number;
  fadeOutPpq?: number;
  takes?: ReadonlyArray<ClipTake>;
  compSegments?: ReadonlyArray<ClipCompSegment>;
}

/** One playable slice of an audio clip (a whole clip when it has no takes). */
export interface AudioClipSegment {
  /** Audio asset the slice reads from. */
  assetId: string;
  /** Slice start relative to the clip window, in PPQ. */
  offsetPpq: number;
  /** Slice length in PPQ (> 0). */
  lengthPpq: number;
  /** Offset of the slice into its source asset, in PPQ. */
  sourceOffsetPpq: number;
  /** Fade-in baked into the slice (first slice only), in PPQ. */
  fadeInPpq: number;
  /** Fade-out baked into the slice (last slice only), in PPQ. */
  fadeOutPpq: number;
}

/**
 * Normalizes a comp selection: finite segment starts clamped into the clip
 * window, valid take indices, sorted by start (later entries win a tie), a
 * mandatory segment at 0 (the first surviving segment is pulled to the clip
 * start) and adjacent same-take segments merged.
 */
export function sanitizeCompSegments(
  segments: ReadonlyArray<ClipCompSegment>,
  takeCount: number,
  lengthPpq: number,
): ClipCompSegment[] {
  const valid = segments
    .filter(
      (segment) =>
        Number.isFinite(segment.startPpq) &&
        segment.startPpq < lengthPpq &&
        Number.isInteger(segment.takeIndex) &&
        segment.takeIndex >= 0 &&
        segment.takeIndex < takeCount,
    )
    .map((segment) => ({
      startPpq: Math.max(0, segment.startPpq),
      takeIndex: segment.takeIndex,
      ...(Number.isFinite(segment.crossfadePpq)
        ? { crossfadePpq: Math.max(0, segment.crossfadePpq as number) }
        : {}),
    }));
  // Stable sort; for equal starts the later entry wins below.
  valid.sort((a, b) => a.startPpq - b.startPpq);
  const result: ClipCompSegment[] = [];
  for (const segment of valid) {
    const previous = result[result.length - 1];
    if (previous && previous.startPpq === segment.startPpq) {
      previous.takeIndex = segment.takeIndex;
      if (segment.crossfadePpq !== undefined) previous.crossfadePpq = segment.crossfadePpq;
      continue;
    }
    result.push(segment);
  }
  if (result.length > 0) result[0].startPpq = 0;
  // Merge runs of the same take into one segment.
  const merged: ClipCompSegment[] = [];
  for (const segment of result) {
    const previous = merged[merged.length - 1];
    if (previous && previous.takeIndex === segment.takeIndex) continue;
    merged.push(segment);
  }
  return merged;
}

/** Returns the take index playing at a clip-relative position. */
export function takeIndexAtPpq(selection: ReadonlyArray<ClipCompSegment>, ppq: number): number {
  let take = selection[0]?.takeIndex ?? 0;
  for (const segment of selection) {
    if (segment.startPpq <= ppq) take = segment.takeIndex;
    else break;
  }
  return take;
}

/**
 * Builds the comp selection that plays `takeIndex` over the clip-relative
 * range [rangeStartPpq, rangeEndPpq) and keeps the current selection outside
 * it. The result is sanitized (see {@link sanitizeCompSegments}).
 */
export function compSegmentsWithRange(
  clip: CompableClipFields,
  rangeStartPpq: number,
  rangeEndPpq: number,
  takeIndex: number,
): ClipCompSegment[] {
  const takeCount = clip.takes?.length ?? 0;
  const current = sanitizeCompSegments(
    clip.compSegments && clip.compSegments.length > 0
      ? clip.compSegments
      : [{ startPpq: 0, takeIndex: 0 }],
    takeCount,
    clip.lengthPpq,
  );
  const start = Math.max(0, Math.min(rangeStartPpq, clip.lengthPpq));
  const end = Math.max(start, Math.min(rangeEndPpq, clip.lengthPpq));
  if (end <= start) return current;
  const resumeTake = takeIndexAtPpq(current, end);
  const next: ClipCompSegment[] = [
    ...current.filter((segment) => segment.startPpq < start),
    { startPpq: start, takeIndex },
    ...(end < clip.lengthPpq ? [{ startPpq: end, takeIndex: resumeTake }] : []),
    ...current.filter((segment) => segment.startPpq >= end),
  ];
  return sanitizeCompSegments(next, takeCount, clip.lengthPpq);
}

function compBoundaryCrossfadePpq(
  selection: ReadonlyArray<ClipCompSegment>,
  boundaryIndex: number,
  clipLengthPpq: number,
): number {
  const boundary = selection[boundaryIndex];
  const previous = selection[boundaryIndex - 1];
  if (!boundary || !previous) return 0;
  const requested = boundary.crossfadePpq ?? DEFAULT_COMP_CROSSFADE_PPQ;
  if (requested <= 0) return 0;
  const boundaryPpq = boundary.startPpq;
  const previousLength = boundaryPpq - previous.startPpq;
  const nextStart =
    boundaryIndex + 1 < selection.length ? selection[boundaryIndex + 1].startPpq : clipLengthPpq;
  const nextLength = nextStart - boundaryPpq;
  const half = Math.min(
    requested / 2,
    Math.max(0, previousLength),
    Math.max(0, nextLength),
    Math.max(0, boundaryPpq),
    Math.max(0, clipLengthPpq - boundaryPpq),
  );
  return half * 2;
}

/**
 * Expands an audio clip into its playable segments. A clip without takes is
 * one segment over its own asset; a clip with takes follows its comp
 * selection (take 0 throughout when the selection is absent). Clip fades
 * apply only at the clip edges: fade-in on the first segment, fade-out on
 * the last.
 */
function audioClipSegmentsInWindow(clip: CompableClipFields): AudioClipSegment[] {
  const takes = clip.takes ?? [];
  if (takes.length === 0) {
    if (clip.assetId === undefined) return [];
    return [
      {
        assetId: clip.assetId,
        offsetPpq: 0,
        lengthPpq: clip.lengthPpq,
        sourceOffsetPpq: clip.sourceOffsetPpq,
        fadeInPpq: clip.fadeInPpq ?? 0,
        fadeOutPpq: clip.fadeOutPpq ?? 0,
      },
    ];
  }
  const selection = sanitizeCompSegments(
    clip.compSegments && clip.compSegments.length > 0
      ? clip.compSegments
      : [{ startPpq: 0, takeIndex: 0 }],
    takes.length,
    clip.lengthPpq,
  );
  const boundaryCrossfades = selection.map((_, index) =>
    compBoundaryCrossfadePpq(selection, index, clip.lengthPpq),
  );
  const result: AudioClipSegment[] = [];
  for (let i = 0; i < selection.length; i++) {
    const segment = selection[i];
    const endPpq = i + 1 < selection.length ? selection[i + 1].startPpq : clip.lengthPpq;
    const fadeInPpq = i === 0 ? (clip.fadeInPpq ?? 0) : boundaryCrossfades[i];
    const fadeOutPpq =
      i === selection.length - 1 ? (clip.fadeOutPpq ?? 0) : boundaryCrossfades[i + 1];
    const startExtensionPpq = i === 0 ? 0 : fadeInPpq / 2;
    const endExtensionPpq = i === selection.length - 1 ? 0 : fadeOutPpq / 2;
    const offsetPpq = segment.startPpq - startExtensionPpq;
    const lengthPpq = endPpq - segment.startPpq + startExtensionPpq + endExtensionPpq;
    if (lengthPpq <= 0) continue;
    result.push({
      assetId: takes[segment.takeIndex].assetId,
      offsetPpq,
      lengthPpq,
      sourceOffsetPpq: clip.sourceOffsetPpq + offsetPpq,
      fadeInPpq,
      fadeOutPpq,
    });
  }
  return result;
}

/**
 * Expands an audio clip into its playable segments, including source-window
 * repeats when clip looping is enabled. Repeated segments read the same source
 * window and are placed later in the clip timeline; clip fade-in/out remain
 * edges of the whole clip, not every repeat.
 */
export function audioClipSegments(clip: CompableClipFields): AudioClipSegment[] {
  const requestedLoopLengthPpq =
    clip.loopEnabled === true &&
    Number.isFinite(clip.loopLengthPpq) &&
    (clip.loopLengthPpq ?? 0) > 0
      ? (clip.loopLengthPpq as number)
      : 0;
  // Match MIDI projection's safety contract: malformed sub-tick loops are
  // floored and a pathological clip cannot materialize unbounded segments.
  const loopLengthPpq =
    requestedLoopLengthPpq > 0
      ? Math.min(clip.lengthPpq, Math.max(requestedLoopLengthPpq, MIN_LOOP_WINDOW_PPQ))
      : 0;
  if (loopLengthPpq <= 0 || loopLengthPpq >= clip.lengthPpq) {
    return audioClipSegmentsInWindow(clip);
  }

  const loopWindow: CompableClipFields = {
    ...clip,
    lengthPpq: loopLengthPpq,
    loopEnabled: false,
    loopLengthPpq: 0,
    fadeInPpq: 0,
    fadeOutPpq: 0,
  };
  const base = audioClipSegmentsInWindow(loopWindow);
  const result: AudioClipSegment[] = [];
  const repeatCount = Math.min(Math.ceil(clip.lengthPpq / loopLengthPpq), MAX_LOOP_OCCURRENCES);
  for (let occurrence = 0; occurrence < repeatCount; occurrence++) {
    const repeatOffset = occurrence * loopLengthPpq;
    const remaining = clip.lengthPpq - repeatOffset;
    for (const segment of base) {
      if (segment.offsetPpq >= remaining) continue;
      const lengthPpq = Math.min(segment.lengthPpq, remaining - segment.offsetPpq);
      if (lengthPpq <= 0) continue;
      result.push({
        ...segment,
        offsetPpq: repeatOffset + segment.offsetPpq,
        lengthPpq,
      });
    }
  }
  if (result.length > 0) {
    result[0] = { ...result[0], fadeInPpq: clip.fadeInPpq ?? 0 };
    const last = result.length - 1;
    result[last] = { ...result[last], fadeOutPpq: clip.fadeOutPpq ?? 0 };
  }
  return result;
}
