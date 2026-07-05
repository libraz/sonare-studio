/**
 * Bar/beat tick generation for the arrangement ruler and lane grid, driven by
 * the project's time-signature map. Pure logic: no DOM, no framework imports.
 *
 * Time is expressed in PPQ where one quarter note equals 1.0.
 */

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
  /** Minimum px between bar labels; labels thin out in powers of two. Default 44. */
  minBarLabelSpacingPx?: number;
}

/** Default minimum px spacing before beat ticks are emitted. */
export const DEFAULT_MIN_BEAT_SPACING_PX = 6;

/** Default minimum px spacing between bar-number labels. */
export const DEFAULT_MIN_BAR_LABEL_SPACING_PX = 44;

/** Epsilon absorbing float noise in bar-index math. */
const PPQ_EPSILON = 1e-9;

/** Length of one bar of a meter segment in PPQ. */
export function barLengthPpq(segment: MeterSegment): number {
  return (segment.numerator * 4) / segment.denominator;
}

/** Length of one beat of a meter segment in PPQ. */
export function beatLengthPpq(segment: MeterSegment): number {
  return 4 / segment.denominator;
}

/**
 * Normalizes a meter map: drops invalid segments, sorts by start, keeps the
 * last segment at duplicate starts and guarantees coverage from PPQ 0 by
 * prepending a 4/4 segment when needed.
 */
function normalizeMeter(meter: ReadonlyArray<MeterSegment>): MeterSegment[] {
  const valid = meter
    .filter(
      (s) =>
        Number.isFinite(s.startPpq) &&
        s.startPpq >= 0 &&
        Number.isInteger(s.numerator) &&
        s.numerator >= 1 &&
        Number.isInteger(s.denominator) &&
        s.denominator >= 1,
    )
    .slice()
    .sort((a, b) => a.startPpq - b.startPpq)
    .filter((s, i, arr) => i === arr.length - 1 || arr[i + 1].startPpq !== s.startPpq);
  if (valid.length === 0 || valid[0].startPpq > 0) {
    valid.unshift({ startPpq: 0, numerator: 4, denominator: 4 });
  }
  return valid;
}

/**
 * Converts a project-absolute meter map into a local PPQ frame.
 *
 * Piano-roll note positions are clip-source relative: local PPQ 0 maps to
 * `timelineOriginPpq` on the arrangement timeline. This helper preserves the
 * meter active at that origin as a local segment at 0, then shifts subsequent
 * meter changes into the local frame.
 */
export function localizeMeter(
  meter: ReadonlyArray<MeterSegment>,
  timelineOriginPpq: number,
): MeterSegment[] {
  const segments = normalizeMeter(meter);
  const origin = Number.isFinite(timelineOriginPpq) ? timelineOriginPpq : 0;
  let active = segments[0];
  for (const segment of segments) {
    if (segment.startPpq <= origin) active = segment;
    else break;
  }
  const localized: MeterSegment[] = [
    { startPpq: 0, numerator: active.numerator, denominator: active.denominator },
  ];
  for (const segment of segments) {
    const shifted = segment.startPpq - origin;
    if (shifted <= 0) continue;
    localized.push({ ...segment, startPpq: shifted });
  }
  return localized;
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
  const segments = normalizeMeter(meter);
  const position = Math.max(0, ppq);
  let index = 0;
  while (index + 1 < segments.length && segments[index + 1].startPpq <= position) index++;
  const segment = segments[index];
  const segmentEnd = segments[index + 1]?.startPpq ?? Number.POSITIVE_INFINITY;
  const bar = barLengthPpq(segment);
  const barIndex = Math.floor((position - segment.startPpq) / bar + PPQ_EPSILON);
  const startPpq = segment.startPpq + barIndex * bar;
  return { startPpq, lengthPpq: Math.min(bar, segmentEnd - startPpq) };
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
 * spacing; bar labels thin out in powers of two so they never collide.
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
    const beat = beatLengthPpq(segment);
    const visibleStart = Math.max(segment.startPpq, startPpq);
    const visibleEnd = Math.min(segmentEnd, endPpq);
    if (visibleStart < visibleEnd) {
      let labelEvery = 1;
      if (drawLabels) {
        while (bar * pxPerPpq * labelEvery < minLabelSpacing) labelEvery *= 2;
      }
      const drawBeats = beat * pxPerPpq >= minBeatSpacing;
      const firstIndex = Math.max(
        0,
        Math.floor((visibleStart - segment.startPpq) / bar + PPQ_EPSILON),
      );
      for (let k = firstIndex; segment.startPpq + k * bar < visibleEnd; k++) {
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
