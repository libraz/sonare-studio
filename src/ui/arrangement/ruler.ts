/**
 * Bar/beat tick generation for the arrangement ruler and lane grid, driven by
 * the project's time-signature map. Pure logic: no DOM, no framework imports.
 *
 * Time is expressed in PPQ where one quarter note equals 1.0.
 */

import {
  measureRangeAt,
  meterBarLengthPpq,
  meterBeatLengthPpq,
  normalizeTimeSignatureMap,
} from '@/project/time-signature';

/** One time-signature segment (structurally compatible with the store mirror). */
export interface MeterSegment {
  /** Segment start in PPQ. */
  startPpq: number;
  /** Beats per bar (positive integer). */
  numerator: number;
  /** Beat unit (positive integer, e.g. 4 or 8). */
  denominator: number;
}

/** One ruler tick at a bar or beat boundary. */
export interface RulerTick {
  /** Tick position in PPQ. */
  ppq: number;
  /** Bar boundary or intermediate beat. */
  kind: 'bar' | 'beat';
  /** 1-based bar number, present on bar ticks only. */
  barNumber?: number;
  /** Bar-number label, present when the zoom leaves room for it. */
  label?: string;
}

/** Options for {@link rulerTicks}. */
export interface RulerTickOptions {
  /** Minimum px between beats before beat ticks are emitted. Default 6. */
  minBeatSpacingPx?: number;
  /** Minimum px between bar ticks; bars thin out in powers of two. Default 6. */
  minBarSpacingPx?: number;
  /** Minimum px between bar labels; labels thin out in powers of two. Default 44. */
  minBarLabelSpacingPx?: number;
}

/** Default minimum px spacing before beat ticks are emitted. */
export const DEFAULT_MIN_BEAT_SPACING_PX = 6;

/** Default minimum px spacing between bar ticks. */
export const DEFAULT_MIN_BAR_SPACING_PX = 6;

/** Default minimum px spacing between bar-number labels. */
export const DEFAULT_MIN_BAR_LABEL_SPACING_PX = 44;

/** Epsilon absorbing float noise in bar-index math. */
const PPQ_EPSILON = 1e-9;

/** Returns a stable power-of-two stride that meets a minimum pixel spacing. */
function barStrideForSpacing(barSpacingPx: number, minSpacingPx: number): number {
  if (
    !Number.isFinite(barSpacingPx) ||
    !(barSpacingPx > 0) ||
    !Number.isFinite(minSpacingPx) ||
    !(minSpacingPx > 0)
  ) {
    return 1;
  }
  let stride = 1;
  while (barSpacingPx * stride < minSpacingPx) stride *= 2;
  return stride;
}

/** Length of one bar of a meter segment in PPQ. */
export function barLengthPpq(segment: MeterSegment): number {
  return meterBarLengthPpq(segment);
}

/**
 * Normalizes a meter map: drops invalid segments, sorts by start, keeps the
 * last segment at duplicate starts and guarantees coverage from PPQ 0 by
 * prepending a 4/4 segment when needed.
 */
function normalizeMeter(meter: ReadonlyArray<MeterSegment>): MeterSegment[] {
  return normalizeTimeSignatureMap(meter);
}

/** A bar window on the timeline. */
export interface BarRange {
  /** Bar start in PPQ. */
  startPpq: number;
  /** Bar length in PPQ (truncated at a mid-bar meter change). */
  lengthPpq: number;
}

/**
 * Returns the bar containing a PPQ position. A meter change starts a new bar,
 * so the bar before a mid-bar change is truncated to the change position.
 *
 * @param meter - Time-signature map (4/4 assumed when empty).
 * @param ppq - Position in PPQ (clamped to >= 0).
 * @returns The containing bar's start and length in PPQ.
 */
export function barRangeAt(meter: ReadonlyArray<MeterSegment>, ppq: number): BarRange {
  const range = measureRangeAt(meter, ppq);
  return { startPpq: range.startPpq, lengthPpq: range.lengthPpq };
}

/**
 * Snaps a PPQ position to the nearest bar boundary of the meter map.
 *
 * @param meter - Time-signature map (4/4 assumed when empty).
 * @param ppq - Position in PPQ.
 * @returns The closer of the containing bar's start and end, >= 0.
 */
export function nearestBarPpq(meter: ReadonlyArray<MeterSegment>, ppq: number): number {
  const bar = barRangeAt(meter, ppq);
  const end = bar.startPpq + bar.lengthPpq;
  return Math.max(0, ppq) - bar.startPpq < end - Math.max(0, ppq) ? bar.startPpq : end;
}

/**
 * Generates bar and beat ticks for the visible range [startPpq, endPpq).
 *
 * Bar numbering is continuous across meter changes (a change always starts a
 * new bar). Beat ticks are omitted when beats are closer than the minimum
 * spacing, and bar ticks/labels thin out in powers of two so they never
 * overwhelm a zoomed-out view.
 *
 * @param meter - Time-signature map (4/4 assumed when empty).
 * @param startPpq - Left edge of the visible range in PPQ.
 * @param endPpq - Exclusive right edge of the visible range in PPQ.
 * @param pxPerPpq - Horizontal zoom in px per PPQ (> 0).
 * @param options - Density thresholds.
 * @returns Ticks sorted by position.
 */
export function rulerTicks(
  meter: ReadonlyArray<MeterSegment>,
  startPpq: number,
  endPpq: number,
  pxPerPpq: number,
  options: RulerTickOptions = {},
): RulerTick[] {
  if (!(pxPerPpq > 0) || !(endPpq > startPpq)) return [];
  const minBeatSpacing = options.minBeatSpacingPx ?? DEFAULT_MIN_BEAT_SPACING_PX;
  const minBarSpacing = options.minBarSpacingPx ?? DEFAULT_MIN_BAR_SPACING_PX;
  const minLabelSpacing = options.minBarLabelSpacingPx ?? DEFAULT_MIN_BAR_LABEL_SPACING_PX;
  const drawLabels = Number.isFinite(minLabelSpacing) && minLabelSpacing >= 0;
  const segments = normalizeMeter(meter);
  const ticks: RulerTick[] = [];
  let barsBefore = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.startPpq >= endPpq) break;
    const segmentEnd = segments[i + 1]?.startPpq ?? Number.POSITIVE_INFINITY;
    const bar = barLengthPpq(segment);
    const beat = meterBeatLengthPpq(segment);
    const visibleStart = Math.max(segment.startPpq, startPpq);
    const visibleEnd = Math.min(segmentEnd, endPpq);
    if (visibleStart < visibleEnd) {
      let labelEvery = 1;
      if (drawLabels) {
        while (bar * pxPerPpq * labelEvery < minLabelSpacing) labelEvery *= 2;
      }
      const barStride = barStrideForSpacing(bar * pxPerPpq, minBarSpacing);
      const drawBeats = beat * pxPerPpq >= minBeatSpacing;
      const firstVisibleIndex = Math.max(
        0,
        Math.ceil((visibleStart - segment.startPpq) / bar - PPQ_EPSILON),
      );
      // Start each segment's stride at its own boundary. This keeps the
      // density stable while preserving labels and the segment's first bar.
      const firstIndex = Math.floor(firstVisibleIndex / barStride) * barStride;
      for (let k = firstIndex; segment.startPpq + k * bar < visibleEnd; k += barStride) {
        const barPpq = segment.startPpq + k * bar;
        if (barPpq >= visibleStart) {
          const barNumber = barsBefore + k + 1;
          const tick: RulerTick = { ppq: barPpq, kind: 'bar', barNumber };
          if (drawLabels && (barNumber - 1) % labelEvery === 0) tick.label = String(barNumber);
          ticks.push(tick);
        }
        if (drawBeats) {
          for (let j = 1; j < segment.numerator; j++) {
            const ppq = barPpq + j * beat;
            if (ppq >= visibleEnd) break;
            if (ppq >= visibleStart) ticks.push({ ppq, kind: 'beat' });
          }
        }
      }
    }
    if (Number.isFinite(segmentEnd)) {
      barsBefore += Math.max(1, Math.ceil((segmentEnd - segment.startPpq) / bar - PPQ_EPSILON));
    }
  }
  ticks.sort((a, b) => a.ppq - b.ppq);
  return ticks;
}

/**
 * Creates a single-entry cache over {@link rulerTicks}.
 *
 * The arrangement base layer requests the same ticks twice per repaint (lane
 * gridlines and the ruler strip) and repeatedly across repaints while the
 * view is unchanged, so a one-slot cache removes the recomputation. The meter
 * array is compared by identity: the store mirror is replaced wholesale on
 * every edit, so identity equality implies content equality.
 *
 * @param compute Tick generator (injectable for tests).
 * @returns Getter with the {@link rulerTicks} signature minus options.
 */
export function createRulerTickCache(
  compute: (
    meter: ReadonlyArray<MeterSegment>,
    startPpq: number,
    endPpq: number,
    pxPerPpq: number,
  ) => RulerTick[] = rulerTicks,
): (
  meter: ReadonlyArray<MeterSegment>,
  startPpq: number,
  endPpq: number,
  pxPerPpq: number,
) => RulerTick[] {
  let cachedMeter: ReadonlyArray<MeterSegment> | null = null;
  let cachedStartPpq = Number.NaN;
  let cachedEndPpq = Number.NaN;
  let cachedPxPerPpq = Number.NaN;
  let cachedTicks: RulerTick[] = [];
  return (meter, startPpq, endPpq, pxPerPpq) => {
    if (
      meter !== cachedMeter ||
      startPpq !== cachedStartPpq ||
      endPpq !== cachedEndPpq ||
      pxPerPpq !== cachedPxPerPpq
    ) {
      cachedTicks = compute(meter, startPpq, endPpq, pxPerPpq);
      cachedMeter = meter;
      cachedStartPpq = startPpq;
      cachedEndPpq = endPpq;
      cachedPxPerPpq = pxPerPpq;
    }
    return cachedTicks;
  };
}
