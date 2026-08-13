/**
 * Pure timeline-coordinate transforms shared by ripple insert/delete commands.
 *
 * Project-backed clip edits are deliberately kept out of this module: callers
 * can use these transforms for app-owned metadata while coordinating native
 * mutations inside one `executeAtomic` operation.
 */

import type { AutomationLaneState, AutomationPoint } from './automation';
import type { EditorMarker, EditorSection, TempoSegment, TimeSignatureSegment } from './types';

/** Rejects an invalid non-negative timeline span. */
export function validateTimelineRange(startPpq: number, endPpq: number): void {
  if (!Number.isFinite(startPpq) || startPpq < 0) {
    throw new RangeError(`Timeline start must be finite and >= 0, got ${startPpq}`);
  }
  if (!Number.isFinite(endPpq) || endPpq <= startPpq) {
    throw new RangeError(`Timeline end must be finite and > start, got ${endPpq}`);
  }
}

/** Moves a timeline point at or after an insertion boundary. */
function shiftForInsert(ppq: number, atPpq: number, lengthPpq: number): number {
  return ppq >= atPpq ? ppq + lengthPpq : ppq;
}

/** Moves a structural-map entry while keeping its required origin anchored. */
function shiftStructuralMapForInsert(ppq: number, atPpq: number, lengthPpq: number): number {
  return ppq >= atPpq && !(atPpq === 0 && ppq === 0) ? ppq + lengthPpq : ppq;
}

/** Shifts markers at and after the inserted range. */
export function insertMarkers(
  markers: ReadonlyArray<EditorMarker>,
  atPpq: number,
  lengthPpq: number,
): EditorMarker[] {
  return markers.map((marker) => ({
    ...marker,
    ppq: shiftForInsert(marker.ppq, atPpq, lengthPpq),
  }));
}

/** Drops markers inside a deleted range and shifts later markers left. */
export function deleteMarkers(
  markers: ReadonlyArray<EditorMarker>,
  startPpq: number,
  endPpq: number,
): EditorMarker[] {
  const lengthPpq = endPpq - startPpq;
  return markers
    .filter((marker) => marker.ppq < startPpq || marker.ppq >= endPpq)
    .map((marker) => ({
      ...marker,
      ppq: marker.ppq >= endPpq ? marker.ppq - lengthPpq : marker.ppq,
    }));
}

/** Expands a section spanning inserted time and shifts sections starting there or later. */
export function insertSections(
  sections: ReadonlyArray<EditorSection>,
  atPpq: number,
  lengthPpq: number,
): EditorSection[] {
  return sections.map((section) => {
    if (section.startPpq >= atPpq) {
      return {
        ...section,
        startPpq: section.startPpq + lengthPpq,
        endPpq: section.endPpq + lengthPpq,
      };
    }
    if (section.endPpq > atPpq) return { ...section, endPpq: section.endPpq + lengthPpq };
    return { ...section };
  });
}

/** Clips/deletes section regions while preserving each surviving non-empty range. */
export function deleteSections(
  sections: ReadonlyArray<EditorSection>,
  startPpq: number,
  endPpq: number,
): EditorSection[] {
  const lengthPpq = endPpq - startPpq;
  return sections.flatMap((section) => {
    if (section.endPpq <= startPpq) return [{ ...section }];
    if (section.startPpq >= endPpq) {
      return [
        { ...section, startPpq: section.startPpq - lengthPpq, endPpq: section.endPpq - lengthPpq },
      ];
    }
    if (section.startPpq < startPpq && section.endPpq > endPpq) {
      return [{ ...section, endPpq: section.endPpq - lengthPpq }];
    }
    if (section.startPpq < startPpq) return [{ ...section, endPpq: startPpq }];
    if (section.endPpq > endPpq)
      return [{ ...section, startPpq, endPpq: section.endPpq - lengthPpq }];
    return [];
  });
}

/** Inserts timeline space into all automation lanes. */
export function insertAutomationLanes(
  lanes: ReadonlyArray<AutomationLaneState>,
  atPpq: number,
  lengthPpq: number,
): AutomationLaneState[] {
  return lanes.map((lane) => ({
    ...lane,
    points: lane.points.map((point) => ({
      ...point,
      // A point at the origin establishes the automation lane's initial
      // value, like the origin entries in tempo and meter maps. Keep it
      // anchored when inserting at 0; ordinary automation points still move.
      ppq: shiftStructuralMapForInsert(point.ppq, atPpq, lengthPpq),
    })),
  }));
}

function heldPointAt(
  points: ReadonlyArray<AutomationPoint>,
  ppq: number,
): AutomationPoint | undefined {
  let held: AutomationPoint | undefined;
  for (const point of points) {
    if (point.ppq > ppq) break;
    held = point;
  }
  return held;
}

/**
 * Removes automation points in a deleted span, shifts later points, and adds
 * the value held at the left edge when needed so the curve remains continuous.
 */
export function deleteAutomationLanes(
  lanes: ReadonlyArray<AutomationLaneState>,
  startPpq: number,
  endPpq: number,
): AutomationLaneState[] {
  const lengthPpq = endPpq - startPpq;
  return lanes.map((lane) => {
    const held = heldPointAt(lane.points, startPpq);
    const points = lane.points
      .filter((point) => point.ppq < startPpq || point.ppq >= endPpq)
      .map((point) => ({
        ...point,
        ppq: point.ppq >= endPpq ? point.ppq - lengthPpq : point.ppq,
      }));
    if (held !== undefined && !points.some((point) => point.ppq === startPpq)) {
      points.push({ ...held, ppq: startPpq });
    }
    points.sort((a, b) => a.ppq - b.ppq);
    return { ...lane, points };
  });
}

type TimelineSegment = TempoSegment | TimeSignatureSegment;

function sameSegmentValue<T extends TimelineSegment>(left: T, right: T): boolean {
  if ('bpm' in left && 'bpm' in right) {
    return left.bpm === right.bpm && (left.endBpm ?? 0) === (right.endBpm ?? 0);
  }
  if ('numerator' in left && 'numerator' in right) {
    return (
      left.numerator === right.numerator &&
      left.denominator === right.denominator &&
      JSON.stringify(left.grouping ?? []) === JSON.stringify(right.grouping ?? [])
    );
  }
  return false;
}

/** Moves tempo/meter changes at and after an inserted boundary, except the origin entry. */
export function insertTimelineSegments<T extends TimelineSegment>(
  segments: ReadonlyArray<T>,
  atPpq: number,
  lengthPpq: number,
): T[] {
  return segments.map((segment) => ({
    ...segment,
    startPpq: shiftStructuralMapForInsert(segment.startPpq, atPpq, lengthPpq),
  }));
}

/**
 * Deletes a time span from a tempo/meter map. The value active at the left
 * edge becomes a boundary there, so removing a map change cannot alter the
 * surrounding musical context or leave the map without an origin segment.
 */
export function deleteTimelineSegments<T extends TimelineSegment>(
  segments: ReadonlyArray<T>,
  startPpq: number,
  endPpq: number,
): T[] {
  const lengthPpq = endPpq - startPpq;
  const sorted = [...segments].sort((a, b) => a.startPpq - b.startPpq);
  const active = [...sorted].reverse().find((segment) => segment.startPpq <= startPpq);
  const result = sorted
    .filter((segment) => segment.startPpq < startPpq || segment.startPpq >= endPpq)
    .map((segment) => ({
      ...segment,
      startPpq: segment.startPpq >= endPpq ? segment.startPpq - lengthPpq : segment.startPpq,
    }));
  if (active !== undefined && !result.some((segment) => segment.startPpq === startPpq)) {
    result.push({ ...active, startPpq });
  }
  result.sort((a, b) => a.startPpq - b.startPpq);
  return result.filter(
    (segment, index) => index === 0 || !sameSegmentValue(result[index - 1], segment),
  );
}
