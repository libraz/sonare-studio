/**
 * Bar.beat position math over the project's time-signature map.
 *
 * PPQ throughout the app counts quarter notes (1 PPQ = one quarter note), so
 * one beat of an n/d meter spans 4/d PPQ and one bar spans n * 4/d PPQ. Bars
 * and beats are 1-based, matching DAW position displays ("1.1" = project
 * start). A fractional beat is written as an extra dot group: "3.2.5" means
 * bar 3, beat 2.5.
 *
 * Pure module (no DOM, no framework imports) so it stays unit-testable.
 */

import type { TimeSignatureSegment } from '@/project/types';

/** Whole-note length in quarter-note PPQ. */
const PPQ_PER_WHOLE = 4;

/** Fallback meter used when the project has no time-signature map. */
const DEFAULT_SIGNATURE: TimeSignatureSegment = { startPpq: 0, numerator: 4, denominator: 4 };

/** Tolerance absorbing floating-point noise at bar/beat boundaries. */
const EPSILON_PPQ = 1e-9;

/** A musical position as a 1-based bar and a 1-based (fractional) beat. */
export interface BarBeat {
  /** Bar number (>= 1). */
  bar: number;
  /** Beat within the bar (>= 1, may be fractional). */
  beat: number;
}

/** Length of one beat (denominator unit) of a meter, in PPQ. */
export function beatLengthPpq(signature: Pick<TimeSignatureSegment, 'denominator'>): number {
  return PPQ_PER_WHOLE / signature.denominator;
}

/** Length of one bar of a meter, in PPQ. */
export function barLengthPpq(
  signature: Pick<TimeSignatureSegment, 'numerator' | 'denominator'>,
): number {
  return (signature.numerator * PPQ_PER_WHOLE) / signature.denominator;
}

/** One meter segment annotated with the bar number at its start. */
interface NumberedSegment extends TimeSignatureSegment {
  /** 1-based bar number of the segment's first bar. */
  firstBar: number;
}

/**
 * Sorts the meter map and anchors it at PPQ 0. An empty map falls back to
 * 4/4; a first segment starting late is extended back to 0 so every PPQ
 * position has a governing meter.
 */
function effectiveSegments(
  signatures: ReadonlyArray<TimeSignatureSegment>,
): TimeSignatureSegment[] {
  if (signatures.length === 0) return [DEFAULT_SIGNATURE];
  const sorted = [...signatures].sort((a, b) => a.startPpq - b.startPpq);
  if (sorted[0].startPpq > 0) sorted[0] = { ...sorted[0], startPpq: 0 };
  return sorted;
}

/**
 * Builds the meter table with cumulative bar numbers. Meter changes are
 * assumed to fall on bar boundaries (the editors enforce bar-aligned
 * positions); a trailing partial bar before a change still counts as a full
 * bar, mirroring common DAW behavior.
 */
function segmentTable(signatures: ReadonlyArray<TimeSignatureSegment>): NumberedSegment[] {
  const segments = effectiveSegments(signatures);
  const table: NumberedSegment[] = [];
  let bar = 1;
  for (let i = 0; i < segments.length; i++) {
    table.push({ ...segments[i], firstBar: bar });
    if (i + 1 < segments.length) {
      const spanPpq = segments[i + 1].startPpq - segments[i].startPpq;
      bar += Math.max(0, Math.ceil(spanPpq / barLengthPpq(segments[i]) - EPSILON_PPQ));
    }
  }
  return table;
}

/** Returns the meter segment governing a given bar number. */
function governingSignatureForBar(
  bar: number,
  signatures: ReadonlyArray<TimeSignatureSegment>,
): NumberedSegment {
  const table = segmentTable(signatures);
  let segment = table[0];
  for (const candidate of table) {
    if (candidate.firstBar <= bar) segment = candidate;
    else break;
  }
  return segment;
}

/**
 * Converts an absolute PPQ position to a bar.beat position.
 *
 * @param ppq Position in quarter-note PPQ (negative values clamp to 1.1).
 * @param signatures Project time-signature map (any order; empty = 4/4).
 * @returns 1-based bar and (possibly fractional) beat.
 */
export function barBeatFromPpq(
  ppq: number,
  signatures: ReadonlyArray<TimeSignatureSegment>,
): BarBeat {
  const table = segmentTable(signatures);
  let segment = table[0];
  for (const candidate of table) {
    if (candidate.startPpq <= ppq + EPSILON_PPQ) segment = candidate;
    else break;
  }
  const clamped = Math.max(ppq, segment.startPpq);
  const barLen = barLengthPpq(segment);
  const barsIn = Math.floor((clamped - segment.startPpq) / barLen + EPSILON_PPQ);
  const beat = (clamped - segment.startPpq - barsIn * barLen) / beatLengthPpq(segment) + 1;
  return { bar: segment.firstBar + barsIn, beat };
}

/**
 * Fractional number of bars spanned by a PPQ range, honoring meter changes
 * within the range (each portion is measured against its own bar length). This
 * is the meter-aware generalization of `(endPpq - startPpq) / barLength` and is
 * meant for seeding a bar-count field, so callers typically round the result.
 *
 * @param startPpq Range start in quarter-note PPQ.
 * @param endPpq Range end in quarter-note PPQ.
 * @param signatures Project time-signature map (any order; empty = 4/4).
 * @returns Bar count as a real number (0 when the range is empty or inverted).
 */
export function fractionalBarsBetween(
  startPpq: number,
  endPpq: number,
  signatures: ReadonlyArray<TimeSignatureSegment>,
): number {
  if (!(endPpq > startPpq)) return 0;
  const table = segmentTable(signatures);
  let bars = 0;
  for (let i = 0; i < table.length; i++) {
    const segStart = table[i].startPpq;
    const segEnd = i + 1 < table.length ? table[i + 1].startPpq : Number.POSITIVE_INFINITY;
    const lo = Math.max(startPpq, segStart);
    const hi = Math.min(endPpq, segEnd);
    if (hi > lo) bars += (hi - lo) / barLengthPpq(table[i]);
  }
  return bars;
}

/**
 * Converts a bar.beat position to absolute PPQ.
 *
 * @param position 1-based bar and beat (beat may be fractional).
 * @param signatures Project time-signature map (any order; empty = 4/4).
 * @returns Position in quarter-note PPQ (>= 0 for valid 1-based input).
 */
export function ppqFromBarBeat(
  position: BarBeat,
  signatures: ReadonlyArray<TimeSignatureSegment>,
): number {
  const segment = governingSignatureForBar(position.bar, signatures);
  return (
    segment.startPpq +
    (position.bar - segment.firstBar) * barLengthPpq(segment) +
    (position.beat - 1) * beatLengthPpq(segment)
  );
}

/**
 * Formats an absolute PPQ position as a "bar.beat" string. Fractional beats
 * are rounded to 1/1000 of a beat; a beat that rounds past the end of its
 * bar carries into the next bar so the output always re-parses.
 *
 * @param ppq Position in quarter-note PPQ.
 * @param signatures Project time-signature map.
 * @returns Display string such as "1.1", "5.3" or "5.3.5".
 */
export function formatBarBeat(
  ppq: number,
  signatures: ReadonlyArray<TimeSignatureSegment>,
): string {
  const { bar, beat } = barBeatFromPpq(ppq, signatures);
  let outBar = bar;
  let outBeat = Math.round(beat * 1000) / 1000;
  const governing = governingSignatureForBar(bar, signatures);
  if (outBeat >= governing.numerator + 1) {
    outBar += 1;
    outBeat = 1;
  }
  return `${outBar}.${outBeat}`;
}

/** Accepts "bar", "bar.beat" and "bar.beat.fraction" (e.g. "3.2.5" = beat 2.5). */
const BAR_BEAT_PATTERN = /^\s*(\d+)(?:\.(\d+)(?:\.(\d+))?)?\s*$/;

/**
 * Parses a "bar.beat" position string into absolute PPQ.
 *
 * The bar must be >= 1 and the beat must lie inside the governing bar
 * (1 <= beat < numerator + 1). An omitted beat defaults to 1.
 *
 * @param text User input such as "5", "5.3" or "5.3.5".
 * @param signatures Project time-signature map.
 * @returns Position in PPQ, or null when the input is not a valid position.
 */
export function parseBarBeat(
  text: string,
  signatures: ReadonlyArray<TimeSignatureSegment>,
): number | null {
  const match = BAR_BEAT_PATTERN.exec(text);
  if (!match) return null;
  const bar = Number(match[1]);
  const beat = match[2] === undefined ? 1 : Number(`${match[2]}.${match[3] ?? '0'}`);
  if (!Number.isFinite(bar) || bar < 1) return null;
  if (!Number.isFinite(beat) || beat < 1) return null;
  const governing = governingSignatureForBar(bar, signatures);
  if (beat >= governing.numerator + 1) return null;
  return ppqFromBarBeat({ bar, beat }, signatures);
}

/** Ticks per quarter note for the bars.beats.sixteenths.ticks transport display. */
export const TICKS_PER_QUARTER = 480;

/** Number of ticks spanning one beat (denominator unit) of a meter. */
function ticksPerBeatOf(
  signature: Pick<TimeSignatureSegment, 'denominator'>,
  ticksPerQuarter: number,
): number {
  return beatLengthPpq(signature) * ticksPerQuarter;
}

/** Accepts "bar", "bar.beat", "bar.beat.16th" and "bar.beat.16th.tick". */
const BAR_BEAT_SIXTEENTH_PATTERN = /^\s*(\d+)(?:\.(\d+)(?:\.(\d+)(?:\.(\d+))?)?)?\s*$/;

/**
 * Formats an absolute PPQ position as the "bar.beat.sixteenth.tick"
 * transport string desktop DAWs display (e.g. "5.2.3.120"): bar and beat
 * are 1-based, the sixteenth is the 1-based sixteenth-note subdivision inside
 * the beat, and the tick is the 0-based offset inside that sixteenth in
 * {@link TICKS_PER_QUARTER}-per-quarter resolution. Values that round past a
 * boundary carry forward so the output always re-parses with
 * {@link parseBarBeatTick}.
 *
 * @param ppq Position in quarter-note PPQ.
 * @param signatures Project time-signature map.
 * @param ticksPerQuarter Tick resolution per quarter note (default {@link TICKS_PER_QUARTER}).
 * @returns Display string such as "1.1.1.000" or "5.2.3.120".
 */
export function formatBarBeatTick(
  ppq: number,
  signatures: ReadonlyArray<TimeSignatureSegment>,
  ticksPerQuarter: number = TICKS_PER_QUARTER,
): string {
  const { bar, beat } = barBeatFromPpq(ppq, signatures);
  const governing = governingSignatureForBar(bar, signatures);
  const ticksPerBeat = ticksPerBeatOf(governing, ticksPerQuarter);
  const ticksPerSixteenth = ticksPerQuarter / 4;
  let outBar = bar;
  let outBeat = Math.floor(beat + EPSILON_PPQ);
  let ticksIntoBeat = Math.round((beat - outBeat) * ticksPerBeat);
  if (ticksIntoBeat >= ticksPerBeat) {
    ticksIntoBeat -= ticksPerBeat;
    outBeat += 1;
  }
  if (outBeat >= governing.numerator + 1) {
    outBar += 1;
    outBeat = 1;
  }
  const sixteenth = Math.floor(ticksIntoBeat / ticksPerSixteenth) + 1;
  const tick = ticksIntoBeat % ticksPerSixteenth;
  return `${outBar}.${outBeat}.${sixteenth}.${String(tick).padStart(3, '0')}`;
}

/**
 * Parses a "bar.beat.sixteenth.tick" transport string into absolute PPQ. The
 * bar must be >= 1, the beat must lie inside the governing bar, the sixteenth
 * must lie inside the beat, and the tick must be in [0, ticksPerSixteenth).
 * Omitted fields default to beat 1, sixteenth 1, tick 0.
 *
 * @param text User input such as "5", "5.2", "5.2.3" or "5.2.3.120".
 * @param signatures Project time-signature map.
 * @param ticksPerQuarter Tick resolution per quarter note (default {@link TICKS_PER_QUARTER}).
 * @returns Position in PPQ, or null when the input is not a valid position.
 */
export function parseBarBeatTick(
  text: string,
  signatures: ReadonlyArray<TimeSignatureSegment>,
  ticksPerQuarter: number = TICKS_PER_QUARTER,
): number | null {
  const match = BAR_BEAT_SIXTEENTH_PATTERN.exec(text);
  if (!match) return null;
  const bar = Number(match[1]);
  const beatInt = match[2] === undefined ? 1 : Number(match[2]);
  const sixteenth = match[3] === undefined ? 1 : Number(match[3]);
  const tick = match[4] === undefined ? 0 : Number(match[4]);
  const ticksPerSixteenth = ticksPerQuarter / 4;
  if (!Number.isInteger(bar) || bar < 1) return null;
  if (!Number.isInteger(beatInt) || beatInt < 1) return null;
  if (!Number.isInteger(sixteenth) || sixteenth < 1) return null;
  if (!Number.isInteger(tick) || tick < 0 || tick >= ticksPerSixteenth) return null;
  const governing = governingSignatureForBar(bar, signatures);
  if (beatInt > governing.numerator) return null;
  const ticksPerBeat = ticksPerBeatOf(governing, ticksPerQuarter);
  const ticksIntoBeat = (sixteenth - 1) * ticksPerSixteenth + tick;
  if (ticksIntoBeat >= ticksPerBeat) return null;
  return ppqFromBarBeat({ bar, beat: beatInt + ticksIntoBeat / ticksPerBeat }, signatures);
}
