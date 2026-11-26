/**
 * Pure PPQ <-> time conversion replicating the engine's tempo-map math
 * (libsonare transport/tempo_map.cpp), so callers can bake PPQ positions to
 * seconds/samples exactly as the realtime engine interprets them.
 *
 * Engine contract (libsonare):
 * - Segments are sorted by startPpq; a segment ends where the next one
 *   begins. The LAST segment never ramps — its end is open, so it holds its
 *   start tempo forever.
 * - A ramp is active only when endBpm is finite, > 0, differs from bpm by at
 *   least 1e-9 and the segment has a successor; otherwise the segment is
 *   constant at `bpm`.
 * - BPM is linear in ppq across a ramp:
 *   bpm(p) = bpm0 + slope * (p - startPpq), with
 *   slope = (endBpm - bpm0) / (endPpq - startPpq).
 * - Elapsed seconds within a ramped segment:
 *   t(p) = (60 / slope) * ln(bpm(p) / bpm0); within a constant segment:
 *   t(p) = (p - startPpq) * 60 / bpm0. BPM values are clamped to a 1e-6
 *   floor.
 * - Inverse (seconds -> ppq) within a ramp:
 *   p = startPpq + (bpm0 * (exp(slope * t / 60) - 1)) / slope.
 */

import type { TempoSegment } from './types';

/** Project tempo used when a document or input carries no usable tempo. */
export const DEFAULT_TEMPO_BPM = 120;

/** Inclusive limits on an explicitly authored tempo. */
export const BPM_FLOOR = 1e-6;
export const BPM_CEILING = 100_000;

/** Preserves the playback floor applied to an older positive tempo, including ramp targets. */
export function preserveLegacyTempoFloor(bpm: number): number {
  return bpm > 0 && bpm < BPM_FLOOR ? BPM_FLOOR : bpm;
}

/** Copies a tempo row for a core call, preserving omission and the zero ramp sentinel. */
export function preserveLegacyTempoSegmentFloor(segment: TempoSegment): TempoSegment {
  const { startPpq, bpm, endBpm } = segment;
  return {
    startPpq,
    bpm: preserveLegacyTempoFloor(bpm),
    ...(endBpm === undefined ? {} : { endBpm: preserveLegacyTempoFloor(endBpm) }),
  };
}

/** Minimum |endBpm - bpm| for a segment to count as a ramp. */
const RAMP_EPSILON = 1e-9;

/** Clamps a BPM value to the engine's floor. */
function clampBpm(bpm: number): number {
  return Math.max(BPM_FLOOR, bpm);
}

/** One precomputed segment of a {@link NormalizedTempoMap}. */
export interface NormalizedTempoSegment {
  /** Segment start in PPQ. */
  startPpq: number;
  /** BPM at the segment start (clamped to the engine floor). */
  bpm: number;
  /** Ramp slope in BPM per PPQ (0 = constant segment). */
  slope: number;
  /** Elapsed seconds at startPpq (the time origin is ppq 0). */
  startSeconds: number;
}

/** Sorted, validated tempo segments with precomputed cumulative seconds. */
export interface NormalizedTempoMap {
  /** Segments sorted by startPpq; never empty. */
  segments: ReadonlyArray<NormalizedTempoSegment>;
}

/**
 * Seconds elapsed deltaPpq into a segment starting at bpm0 with the given
 * slope (the closed forms from the module doc).
 */
function elapsedSeconds(bpm0: number, slope: number, deltaPpq: number): number {
  if (slope === 0) return (deltaPpq * 60) / bpm0;
  return (60 / slope) * Math.log(clampBpm(bpm0 + slope * deltaPpq) / bpm0);
}

/**
 * Index of the last segment whose `key` value is <= target (callers handle
 * targets before the first segment separately).
 */
function lowerSegmentIndex(
  segments: ReadonlyArray<NormalizedTempoSegment>,
  target: number,
  key: 'startPpq' | 'startSeconds',
): number {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid][key] <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Builds a normalized tempo map from project tempo segments: a sorted copy
 * with BPM values clamped to the engine floor and per-segment ramp slopes and
 * cumulative seconds precomputed.
 *
 * Entries with a non-finite startPpq are dropped; a non-finite bpm falls back
 * to fallbackBpm. An endBpm that is omitted, non-finite, <= 0, within 1e-9 of
 * bpm, or on the last segment yields a constant segment. Empty (or fully
 * invalid) input yields a single constant segment at fallbackBpm.
 *
 * @param segments Project tempo segments in any order.
 * @param fallbackBpm Tempo used when no usable segment exists (default 120).
 * @returns The normalized map consumed by the conversion functions.
 */
export function normalizeTempoMap(
  segments: ReadonlyArray<TempoSegment>,
  fallbackBpm: number = DEFAULT_TEMPO_BPM,
): NormalizedTempoMap {
  const fallback =
    Number.isFinite(fallbackBpm) && fallbackBpm > 0 ? clampBpm(fallbackBpm) : DEFAULT_TEMPO_BPM;
  const sorted = segments
    .filter((segment) => Number.isFinite(segment.startPpq))
    .map((segment) => ({
      startPpq: segment.startPpq,
      bpm: Number.isFinite(segment.bpm) ? clampBpm(segment.bpm) : fallback,
      endBpm:
        segment.endBpm !== undefined && Number.isFinite(segment.endBpm) && segment.endBpm > 0
          ? clampBpm(segment.endBpm)
          : undefined,
    }))
    .sort((a, b) => a.startPpq - b.startPpq);
  if (sorted.length === 0) sorted.push({ startPpq: 0, bpm: fallback, endBpm: undefined });

  const normalized: NormalizedTempoSegment[] = [];
  // The time origin is ppq 0: the region before the first segment
  // extrapolates linearly at the first segment's bpm, like the engine does.
  let startSeconds = (sorted[0].startPpq * 60) / sorted[0].bpm;
  for (let i = 0; i < sorted.length; i += 1) {
    const segment = sorted[i];
    const next = sorted[i + 1];
    let slope = 0;
    if (
      next !== undefined &&
      next.startPpq > segment.startPpq &&
      segment.endBpm !== undefined &&
      Math.abs(segment.endBpm - segment.bpm) >= RAMP_EPSILON
    ) {
      slope = (segment.endBpm - segment.bpm) / (next.startPpq - segment.startPpq);
    }
    normalized.push({ startPpq: segment.startPpq, bpm: segment.bpm, slope, startSeconds });
    if (next !== undefined) {
      startSeconds += elapsedSeconds(segment.bpm, slope, next.startPpq - segment.startPpq);
    }
  }
  return { segments: normalized };
}

/**
 * The same tempo map with every segment that only continues its predecessor
 * merged away: an equal constant tempo, or a ramp carrying on at the same slope
 * from the tempo already reached. Two maps that play identically compare equal.
 */
export function canonicalTempoMap(map: NormalizedTempoMap): NormalizedTempoMap {
  const segments: NormalizedTempoSegment[] = [];
  for (const segment of map.segments) {
    const previous = segments.at(-1);
    const reached =
      previous === undefined
        ? undefined
        : previous.bpm + previous.slope * (segment.startPpq - previous.startPpq);
    const continues =
      previous !== undefined &&
      reached !== undefined &&
      Math.abs(segment.slope - previous.slope) < RAMP_EPSILON &&
      Math.abs(segment.bpm - reached) < RAMP_EPSILON;
    if (!continues) segments.push(segment);
  }
  return { segments };
}

/**
 * Converts a PPQ position to elapsed seconds. Positions before the first
 * segment use the first segment's bpm (a negative ppq yields negative
 * seconds, linearly).
 *
 * @param map Normalized tempo map.
 * @param ppq Position in PPQ.
 * @returns Elapsed seconds from ppq 0.
 */
export function ppqToSeconds(map: NormalizedTempoMap, ppq: number): number {
  const segments = map.segments;
  const first = segments[0];
  if (ppq <= first.startPpq) return (ppq * 60) / first.bpm;
  const segment = segments[lowerSegmentIndex(segments, ppq, 'startPpq')];
  return segment.startSeconds + elapsedSeconds(segment.bpm, segment.slope, ppq - segment.startPpq);
}

/** Elapsed seconds across an absolute PPQ range, including every tempo change/ramp. */
export function ppqRangeSeconds(map: NormalizedTempoMap, startPpq: number, endPpq: number): number {
  return ppqToSeconds(map, endPpq) - ppqToSeconds(map, startPpq);
}

/** Duration in seconds of a PPQ length anchored at an absolute timeline position. */
export function ppqDurationSeconds(
  map: NormalizedTempoMap,
  startPpq: number,
  lengthPpq: number,
): number {
  return ppqRangeSeconds(map, startPpq, startPpq + lengthPpq);
}

/**
 * Converts elapsed seconds to a PPQ position (full inverse of
 * {@link ppqToSeconds}).
 *
 * @param map Normalized tempo map.
 * @param seconds Elapsed seconds from ppq 0.
 * @returns Position in PPQ.
 */
export function secondsToPpq(map: NormalizedTempoMap, seconds: number): number {
  const segments = map.segments;
  const first = segments[0];
  if (seconds <= first.startSeconds) return (seconds * first.bpm) / 60;
  const segment = segments[lowerSegmentIndex(segments, seconds, 'startSeconds')];
  const t = seconds - segment.startSeconds;
  if (segment.slope === 0) return segment.startPpq + (t * segment.bpm) / 60;
  return (
    segment.startPpq + (segment.bpm * (Math.exp((segment.slope * t) / 60) - 1)) / segment.slope
  );
}

/**
 * Converts a PPQ position to the nearest absolute sample.
 *
 * @param map Normalized tempo map.
 * @param ppq Position in PPQ.
 * @param sampleRate Render sample rate in Hz.
 * @returns Rounded absolute sample position.
 */
export function ppqToSamples(map: NormalizedTempoMap, ppq: number, sampleRate: number): number {
  return Math.round(ppqToSeconds(map, ppq) * sampleRate);
}

/** Rounded sample length across an absolute PPQ range on the tempo map. */
export function ppqRangeSamples(
  map: NormalizedTempoMap,
  startPpq: number,
  endPpq: number,
  sampleRate: number,
): number {
  return ppqToSamples(map, endPpq, sampleRate) - ppqToSamples(map, startPpq, sampleRate);
}

/** Rounded sample length of a PPQ duration anchored at an absolute position. */
export function ppqDurationSamples(
  map: NormalizedTempoMap,
  startPpq: number,
  lengthPpq: number,
  sampleRate: number,
): number {
  return ppqRangeSamples(map, startPpq, startPpq + lengthPpq, sampleRate);
}

/**
 * Converts an absolute sample position to PPQ.
 *
 * @param map Normalized tempo map.
 * @param sample Absolute sample position.
 * @param sampleRate Render sample rate in Hz.
 * @returns Position in PPQ.
 */
export function samplesToPpq(map: NormalizedTempoMap, sample: number, sampleRate: number): number {
  return secondsToPpq(map, sample / sampleRate);
}

/**
 * Instantaneous tempo at a PPQ position (linearly interpolated inside ramps,
 * the segment's bpm otherwise; positions before the first segment use the
 * first segment's bpm).
 *
 * @param map Normalized tempo map.
 * @param ppq Position in PPQ.
 * @returns Tempo in BPM, clamped to the engine floor.
 */
export function tempoAtPpq(map: NormalizedTempoMap, ppq: number): number {
  const segments = map.segments;
  const first = segments[0];
  if (ppq <= first.startPpq) return first.bpm;
  const segment = segments[lowerSegmentIndex(segments, ppq, 'startPpq')];
  return clampBpm(segment.bpm + segment.slope * (ppq - segment.startPpq));
}
