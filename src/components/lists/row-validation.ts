/**
 * Row validation and merge rules shared by the tempo / time-signature list
 * editors. Pure module (no DOM, no framework imports).
 *
 * The editors keep rows in display order; validation expects that order and
 * reports issues by row index so messages map onto visible rows. Commits go
 * through the project commands layer, which re-validates the basics, so
 * these checks exist to give users precise feedback before committing.
 */

import type { TempoSegment, TimeSignatureSegment } from '@/project/types';

/** Lowest tempo the editor accepts, in BPM. */
export const MIN_BPM = 20;

/** Highest tempo the editor accepts, in BPM. */
export const MAX_BPM = 400;

/** Beat units (time-signature denominators) the editor offers. */
export const TIME_SIGNATURE_DENOMINATORS = [1, 2, 4, 8, 16] as const;

/** Largest beats-per-bar count the editor accepts. */
export const MAX_TIME_SIGNATURE_NUMERATOR = 32;

/** One validation finding addressed to a row (-1 = the whole list). */
export interface RowIssue {
  /** 0-based row index, or -1 for list-level issues. */
  row: number;
  /** Human-readable problem description. */
  message: string;
}

/** Checks that positions are finite, anchored at 1.1 and strictly ascending. */
function validatePositions(rows: ReadonlyArray<{ startPpq: number }>, issues: RowIssue[]): void {
  rows.forEach((row, index) => {
    if (!Number.isFinite(row.startPpq) || row.startPpq < 0) {
      issues.push({ row: index, message: 'Position must be at or after 1.1' });
    }
  });
  if (rows.length > 0 && rows[0].startPpq !== 0) {
    issues.push({ row: 0, message: 'The first entry must start at 1.1' });
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].startPpq <= rows[i - 1].startPpq) {
      issues.push({ row: i, message: 'Positions must be strictly ascending' });
    }
  }
}

/**
 * Validates tempo rows in display order.
 *
 * Rules: at least one row, positions anchored at 1.1 and strictly ascending,
 * BPM (and the optional ramp target) within [{@link MIN_BPM}, {@link MAX_BPM}].
 *
 * @param rows Tempo rows in display order.
 * @returns All findings; an empty array means the rows can be committed.
 */
export function validateTempoRows(rows: ReadonlyArray<TempoSegment>): RowIssue[] {
  if (rows.length === 0) {
    return [{ row: -1, message: 'The tempo map needs at least one entry' }];
  }
  const issues: RowIssue[] = [];
  validatePositions(rows, issues);
  rows.forEach((row, index) => {
    if (!Number.isFinite(row.bpm) || row.bpm < MIN_BPM || row.bpm > MAX_BPM) {
      issues.push({ row: index, message: `BPM must be between ${MIN_BPM} and ${MAX_BPM}` });
    }
    if (
      row.endBpm !== undefined &&
      (!Number.isFinite(row.endBpm) || row.endBpm < MIN_BPM || row.endBpm > MAX_BPM)
    ) {
      issues.push({
        row: index,
        message: `Ramp target BPM must be between ${MIN_BPM} and ${MAX_BPM}`,
      });
    }
  });
  return issues;
}

/**
 * Validates time-signature rows in display order.
 *
 * Rules: at least one row, positions anchored at 1.1 and strictly ascending,
 * integer numerator in [1, {@link MAX_TIME_SIGNATURE_NUMERATOR}], denominator
 * one of {@link TIME_SIGNATURE_DENOMINATORS}.
 *
 * @param rows Meter rows in display order.
 * @returns All findings; an empty array means the rows can be committed.
 */
export function validateTimeSignatureRows(rows: ReadonlyArray<TimeSignatureSegment>): RowIssue[] {
  if (rows.length === 0) {
    return [{ row: -1, message: 'The time-signature map needs at least one entry' }];
  }
  const issues: RowIssue[] = [];
  validatePositions(rows, issues);
  rows.forEach((row, index) => {
    if (
      !Number.isInteger(row.numerator) ||
      row.numerator < 1 ||
      row.numerator > MAX_TIME_SIGNATURE_NUMERATOR
    ) {
      issues.push({
        row: index,
        message: `Beats per bar must be an integer between 1 and ${MAX_TIME_SIGNATURE_NUMERATOR}`,
      });
    }
    if (!(TIME_SIGNATURE_DENOMINATORS as ReadonlyArray<number>).includes(row.denominator)) {
      issues.push({
        row: index,
        message: `Beat unit must be one of ${TIME_SIGNATURE_DENOMINATORS.join(', ')}`,
      });
    }
  });
  return issues;
}

/** Returns a copy of the rows sorted by ascending start position (stable). */
export function sortSegments<T extends { startPpq: number }>(rows: ReadonlyArray<T>): T[] {
  return [...rows].sort((a, b) => a.startPpq - b.startPpq);
}

/**
 * Drops tempo segments that restate the tempo already in effect: a segment is
 * redundant when the previous kept segment is constant (no ramp) and has the
 * same BPM, and the segment itself starts no ramp. Segments following a ramp
 * are always kept (they pin the ramp's end).
 *
 * @param segments Valid segments in ascending order.
 * @returns The merged list (always keeps the first segment).
 */
export function mergeTempoSegments(segments: ReadonlyArray<TempoSegment>): TempoSegment[] {
  const merged: TempoSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    const previousIsConstant = previous !== undefined && (previous.endBpm ?? 0) === 0;
    const segmentIsConstant = (segment.endBpm ?? 0) === 0;
    if (previousIsConstant && segmentIsConstant && previous.bpm === segment.bpm) continue;
    merged.push({ ...segment });
  }
  return merged;
}

/**
 * Drops time-signature segments equal to the meter already in effect.
 *
 * @param segments Valid segments in ascending order.
 * @returns The merged list (always keeps the first segment).
 */
export function mergeTimeSignatureSegments(
  segments: ReadonlyArray<TimeSignatureSegment>,
): TimeSignatureSegment[] {
  const merged: TimeSignatureSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      previous.numerator === segment.numerator &&
      previous.denominator === segment.denominator
    ) {
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}
