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
import { formatMessage } from '@/ui/i18n';

/** Lowest tempo the editor accepts, in BPM. */
export const MIN_BPM = 20;

/** Highest tempo the editor accepts, in BPM. */
export const MAX_BPM = 400;

/** Beat units (time-signature denominators) the editor offers. */
export const TIME_SIGNATURE_DENOMINATORS = [1, 2, 4, 8, 16] as const;

/** Largest beats-per-bar count the editor accepts. */
export const MAX_TIME_SIGNATURE_NUMERATOR = 32;

/** Structured validation problem, localized at the editor (see {@link formatRowIssue}). */
export type RowIssueCode =
  | { kind: 'position-before-start' }
  | { kind: 'first-entry-not-at-start' }
  | { kind: 'positions-not-ascending' }
  | { kind: 'tempo-map-empty' }
  | { kind: 'bpm-out-of-range'; min: number; max: number }
  | { kind: 'ramp-bpm-out-of-range'; min: number; max: number }
  | { kind: 'time-signature-map-empty' }
  | { kind: 'beats-per-bar-out-of-range'; max: number }
  | { kind: 'beat-unit-invalid'; allowed: readonly number[] };

/** One validation finding addressed to a row (-1 = the whole list). */
export interface RowIssue {
  /** 0-based row index, or -1 for list-level issues. */
  row: number;
  /** Structured problem code, formatted to a message at the UI. */
  issue: RowIssueCode;
}

/** Localized templates for each {@link RowIssueCode} kind. */
export interface RowIssueStrings {
  positionBeforeStart: string;
  firstEntryNotAtStart: string;
  positionsNotAscending: string;
  tempoMapEmpty: string;
  bpmOutOfRange: string;
  rampBpmOutOfRange: string;
  timeSignatureMapEmpty: string;
  beatsPerBarOutOfRange: string;
  beatUnitInvalid: string;
}

/** Formats a structured row issue into a localized message. */
export function formatRowIssue(issue: RowIssueCode, strings: RowIssueStrings): string {
  switch (issue.kind) {
    case 'position-before-start':
      return strings.positionBeforeStart;
    case 'first-entry-not-at-start':
      return strings.firstEntryNotAtStart;
    case 'positions-not-ascending':
      return strings.positionsNotAscending;
    case 'tempo-map-empty':
      return strings.tempoMapEmpty;
    case 'bpm-out-of-range':
      return formatMessage(strings.bpmOutOfRange, { min: issue.min, max: issue.max });
    case 'ramp-bpm-out-of-range':
      return formatMessage(strings.rampBpmOutOfRange, { min: issue.min, max: issue.max });
    case 'time-signature-map-empty':
      return strings.timeSignatureMapEmpty;
    case 'beats-per-bar-out-of-range':
      return formatMessage(strings.beatsPerBarOutOfRange, { max: issue.max });
    case 'beat-unit-invalid':
      return formatMessage(strings.beatUnitInvalid, { allowed: issue.allowed.join(', ') });
  }
}

/** Checks that positions are finite, anchored at 1.1 and strictly ascending. */
function validatePositions(rows: ReadonlyArray<{ startPpq: number }>, issues: RowIssue[]): void {
  rows.forEach((row, index) => {
    if (!Number.isFinite(row.startPpq) || row.startPpq < 0) {
      issues.push({ row: index, issue: { kind: 'position-before-start' } });
    }
  });
  if (rows.length > 0 && rows[0].startPpq !== 0) {
    issues.push({ row: 0, issue: { kind: 'first-entry-not-at-start' } });
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].startPpq <= rows[i - 1].startPpq) {
      issues.push({ row: i, issue: { kind: 'positions-not-ascending' } });
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
    return [{ row: -1, issue: { kind: 'tempo-map-empty' } }];
  }
  const issues: RowIssue[] = [];
  validatePositions(rows, issues);
  rows.forEach((row, index) => {
    if (!Number.isFinite(row.bpm) || row.bpm < MIN_BPM || row.bpm > MAX_BPM) {
      issues.push({ row: index, issue: { kind: 'bpm-out-of-range', min: MIN_BPM, max: MAX_BPM } });
    }
    if (
      row.endBpm !== undefined &&
      (!Number.isFinite(row.endBpm) || row.endBpm < MIN_BPM || row.endBpm > MAX_BPM)
    ) {
      issues.push({
        row: index,
        issue: { kind: 'ramp-bpm-out-of-range', min: MIN_BPM, max: MAX_BPM },
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
    return [{ row: -1, issue: { kind: 'time-signature-map-empty' } }];
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
        issue: { kind: 'beats-per-bar-out-of-range', max: MAX_TIME_SIGNATURE_NUMERATOR },
      });
    }
    if (!(TIME_SIGNATURE_DENOMINATORS as ReadonlyArray<number>).includes(row.denominator)) {
      issues.push({
        row: index,
        issue: { kind: 'beat-unit-invalid', allowed: TIME_SIGNATURE_DENOMINATORS },
      });
    }
  });
  return issues;
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
