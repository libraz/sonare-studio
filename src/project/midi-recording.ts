import { clamp01 } from '@/lib/math';
import { CLIP_LANE_EPSILON } from './command/clip-lane';
import { type NoteBoundaryEvent, pairNoteBoundariesIntoNotes, type RawNote } from './midi-events';
import {
  type AnyMidiLaneKind,
  MIDI_LANE_KINDS,
  type MidiLaneField,
  type MidiLaneFields,
  type MidiLaneOf,
} from './midi-lane-kinds';
import { snapPpqToSwingMeterGrid } from './time-signature';
import type { TimeSignatureSegment } from './types';

/**
 * Snaps each note's start to the nearest line of the project meter grid,
 * preserving its length.
 *
 * Only note starts move (the classic "quantize start" behaviour); durations
 * are kept so a quantized take still phrases like the performance. A start
 * never moves before 0.
 *
 * @param notes Notes positioned on the timeline (absolute PPQ).
 * @param gridPpq Grid spacing in PPQ (e.g. 0.25 for 1/16 notes); <= 0 is a
 *   no-op (returns the notes unchanged).
 * @param timeSignatures Project meter map the grid is anchored to.
 * @returns Notes with quantized starts, sorted by start position.
 */
export function quantizeRecordedNotes(
  notes: ReadonlyArray<RawNote>,
  gridPpq: number,
  strength = 1,
  swingPercent = 0,
  timeSignatures: readonly TimeSignatureSegment[] = [],
): RawNote[] {
  if (!Number.isFinite(gridPpq) || gridPpq <= 0) return notes.slice();
  const amount = clamp01(strength);
  const quantized = notes.map((note) => ({
    ...note,
    startPpq: Math.max(
      0,
      note.startPpq +
        (snapPpqToSwingMeterGrid(timeSignatures, note.startPpq, gridPpq, swingPercent) -
          note.startPpq) *
          amount,
    ),
  }));
  quantized.sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch || a.channel - b.channel);
  return quantized;
}

/**
 * Folds a linear loop capture into one loop-length overdub clip.
 *
 * Notes are wrapped modulo loopLengthPpq; notes crossing the loop boundary are
 * split so playback inside a looping clip does not depend on sustain across
 * the clip end.
 */
export function foldRecordedNotesIntoLoop(
  notes: ReadonlyArray<RawNote>,
  loopLengthPpq: number,
): RawNote[] {
  if (!Number.isFinite(loopLengthPpq) || loopLengthPpq <= 0) return notes.slice();
  const out: RawNote[] = [];
  for (const note of notes) {
    const endPpq = note.startPpq + note.durationPpq;
    let cursor = note.startPpq;
    while (cursor < endPpq - CLIP_LANE_EPSILON) {
      const loopIndex = Math.floor(cursor / loopLengthPpq);
      const loopStart = loopIndex * loopLengthPpq;
      const inLoopStart = cursor - loopStart;
      const segmentEnd = Math.min(endPpq, loopStart + loopLengthPpq);
      const durationPpq = segmentEnd - cursor;
      if (durationPpq > CLIP_LANE_EPSILON) {
        out.push({
          ...note,
          startPpq: Math.max(0, inLoopStart),
          durationPpq,
        });
      }
      cursor = segmentEnd;
    }
  }
  out.sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch || a.channel - b.channel);
  return out;
}

/** Returns the absolute start of the most recently touched loop pass, or null. */
export function lastCompleteLoopPassStartPpq(
  recordingStartPpq: number,
  stopPpq: number,
  loopLengthPpq: number,
): number | null {
  if (
    !Number.isFinite(recordingStartPpq) ||
    !Number.isFinite(stopPpq) ||
    !Number.isFinite(loopLengthPpq) ||
    loopLengthPpq <= 0
  ) {
    return null;
  }
  const elapsedPpq = stopPpq - recordingStartPpq;
  if (elapsedPpq < -CLIP_LANE_EPSILON) return null;
  return (
    recordingStartPpq +
    Math.max(0, Math.ceil(elapsedPpq / loopLengthPpq - CLIP_LANE_EPSILON) - 1) * loopLengthPpq
  );
}

/**
 * True for a captured event that starts material in its pass. A note-off,
 * including the implicit release added at stop, only ends a note begun
 * earlier, so it never makes a pass a take on its own.
 */
function isLoopPassOnset<T extends { ppq: number }>(event: T, recordingStartPpq: number): boolean {
  return (
    Number.isFinite(event.ppq) &&
    event.ppq >= recordingStartPpq - CLIP_LANE_EPSILON &&
    !('kind' in event && (event as { kind?: unknown }).kind === 'off')
  );
}

/** Returns the loop-pass start containing the latest captured onset, or null. */
export function lastLoopPassWithEventsStartPpq<T extends { ppq: number }>(
  events: ReadonlyArray<T>,
  recordingStartPpq: number,
  loopLengthPpq: number,
): number | null {
  const starts = loopPassStartsWithEvents(events, recordingStartPpq, loopLengthPpq);
  return starts.length > 0 ? starts[starts.length - 1] : null;
}

/**
 * Lists the loop passes that contain captured onsets (note-on, CC, bend,
 * pressure, program change), in chronological order. Each pass is reported
 * once even when it contains several MIDI event kinds, allowing note and
 * expression buffers to share an identical take boundary.
 */
export function loopPassStartsWithEvents<T extends { ppq: number }>(
  events: ReadonlyArray<T>,
  recordingStartPpq: number,
  loopLengthPpq: number,
): number[] {
  if (
    !Number.isFinite(recordingStartPpq) ||
    !Number.isFinite(loopLengthPpq) ||
    loopLengthPpq <= 0
  ) {
    return [];
  }
  const starts = new Set<number>();
  for (const event of events) {
    if (!isLoopPassOnset(event, recordingStartPpq)) continue;
    const pass = Math.max(0, Math.floor((event.ppq - recordingStartPpq) / loopLengthPpq));
    starts.add(recordingStartPpq + pass * loopLengthPpq);
  }
  return [...starts].sort((left, right) => left - right);
}

/**
 * Selects and rebases the most recently touched pass of a loop take.
 *
 * The returned events retain their shape but use the original recording-start
 * timeline so existing clip builders can continue to derive clip-relative PPQ
 * normally. This preserves a musician's final partial pass while ensuring no
 * expression lane can mix values from different passes.
 */
export function selectLastCompleteLoopPassEvents<T extends { ppq: number }>(
  events: ReadonlyArray<T>,
  recordingStartPpq: number,
  stopPpq: number,
  loopLengthPpq: number,
  selectedPassStartPpq?: number | null,
): T[] {
  const passStart =
    selectedPassStartPpq ?? lastCompleteLoopPassStartPpq(recordingStartPpq, stopPpq, loopLengthPpq);
  if (passStart === null) return events.slice();
  const passEnd = passStart + loopLengthPpq;
  const offset = passStart - recordingStartPpq;
  return events
    .filter(
      (event) =>
        event.ppq >= passStart - CLIP_LANE_EPSILON && event.ppq < passEnd - CLIP_LANE_EPSILON,
    )
    .map((event) => ({ ...event, ppq: event.ppq - offset }));
}

/**
 * Clips notes to the most recently touched loop pass and makes that pass
 * clip-relative. Notes spanning the pass boundary are retained as a segment,
 * so sustained material never leaks into another take.
 */
export function selectLastCompleteLoopPassNotes(
  notes: ReadonlyArray<RawNote>,
  recordingStartPpq: number,
  stopPpq: number,
  loopLengthPpq: number,
  selectedPassStartPpq?: number | null,
): RawNote[] {
  const passStart =
    selectedPassStartPpq ?? lastCompleteLoopPassStartPpq(recordingStartPpq, stopPpq, loopLengthPpq);
  if (passStart === null) return foldRecordedNotesIntoLoop(notes, loopLengthPpq);
  const relativeStart = passStart - recordingStartPpq;
  const relativeEnd = relativeStart + loopLengthPpq;
  const out: RawNote[] = [];
  for (const note of notes) {
    const start = Math.max(note.startPpq, relativeStart);
    const end = Math.min(note.startPpq + note.durationPpq, relativeEnd);
    if (end <= start + CLIP_LANE_EPSILON) continue;
    out.push({ ...note, startPpq: start - relativeStart, durationPpq: end - start });
  }
  out.sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch || a.channel - b.channel);
  return out;
}

/** Result of finalizing a captured performance into a placeable clip. */
export interface FinalizedRecording {
  /** Notes relative to the clip window (startPpq from 0). */
  notes: RawNote[];
  /** Clip length in PPQ, covering the capture window and any ringing notes. */
  lengthPpq: number;
}

/** Options for {@link finalizeRecording}. */
export interface FinalizeRecordingOptions {
  /** Punch-in position (timeline PPQ); notes are made relative to this. */
  startPpq: number;
  /** Punch-out position (timeline PPQ); sets the minimum clip length. */
  stopPpq: number;
  /** Quantize grid in PPQ for note starts; <= 0 disables quantizing. */
  gridPpq?: number;
  /** Quantize interpolation 0..1; defaults to full snap. */
  quantizeStrength?: number;
  /** Straight-grid swing amount 0..100; triplet grids ignore it. */
  quantizeSwingPercent?: number;
  /** Project meter map the quantize grid is anchored to; omitted means 4/4 from PPQ 0. */
  timeSignatures?: readonly TimeSignatureSegment[];
}

/**
 * Turns captured note-on/note-off boundaries into clip-relative notes and a
 * clip length, ready for {@link addRecordedMidiClip}.
 *
 * Boundaries are paired into notes, optionally quantized on the timeline grid
 * (so the punch-in position never shifts it), offset to the clip window, and the clip length is taken as the larger of the capture window
 * and the last note's end (so a note ringing past the punch-out is not cut).
 *
 * @param boundaries Captured note boundaries (timeline PPQ).
 * @param options Punch window and quantize grid.
 * @returns The finalized notes and length, or null when nothing was captured.
 */
export function finalizeRecording(
  boundaries: ReadonlyArray<NoteBoundaryEvent>,
  options: FinalizeRecordingOptions,
): FinalizedRecording | null {
  const {
    startPpq,
    stopPpq,
    gridPpq = 0,
    quantizeStrength = 1,
    quantizeSwingPercent = 0,
    timeSignatures = [],
  } = options;
  // A note begins during the capture by construction; guard float drift.
  const captured = pairNoteBoundariesIntoNotes(boundaries).filter(
    (note) => note.startPpq - startPpq >= -CLIP_LANE_EPSILON,
  );
  const notes = quantizeRecordedNotes(
    captured,
    gridPpq,
    quantizeStrength,
    quantizeSwingPercent,
    timeSignatures,
  ).map((note) => ({ ...note, startPpq: Math.max(0, note.startPpq - startPpq) }));
  if (notes.length === 0) return null;
  const lastEnd = notes.reduce((max, note) => Math.max(max, note.startPpq + note.durationPpq), 0);
  const lengthPpq = Math.max(stopPpq - startPpq, lastEnd);
  if (!(lengthPpq > 0)) return null;
  return { notes, lengthPpq };
}

/**
 * One captured expression point (CC, pitch bend, program change or pressure),
 * tagged with the lane list it records into.
 */
export interface RecordedExpressionEvent {
  /** Lane list the point records into. */
  field: MidiLaneField;
  /** Identity fields of the lane, with an empty point list. */
  lane: MidiLaneOf<MidiLaneField>;
  /** Value fields of the point, without a position. */
  value: { value: number } | { program: number };
  /** Captured transport position. */
  ppq: number;
}

function relativeExpressionPpq(
  ppq: number,
  startPpq: number,
  loopLengthPpq: number,
): number | null {
  if (!Number.isFinite(ppq)) return null;
  const relative = ppq - startPpq;
  if (relative < -1e-9) return null;
  if (loopLengthPpq > 0) {
    return ((relative % loopLengthPpq) + loopLengthPpq) % loopLengthPpq;
  }
  return Math.max(0, relative);
}

/**
 * Length of a take holding captured expression: the loop length when looping,
 * otherwise the longest of the finalized notes, the punch span and the last point.
 */
export function expressionLengthPpq(
  capturedExpression: ReadonlyArray<{ ppq: number }>,
  startPpq: number,
  stopPpq: number,
  loopLengthPpq: number,
  finalizedLengthPpq: number,
): number {
  if (loopLengthPpq > 0) return loopLengthPpq;
  const lastExpressionPpq = capturedExpression.reduce(
    (max, event) => (Number.isFinite(event.ppq) ? Math.max(max, event.ppq) : max),
    startPpq,
  );
  return Math.max(finalizedLengthPpq, stopPpq - startPpq, lastExpressionPpq - startPpq);
}

type AnyLane = MidiLaneOf<MidiLaneField>;
type AnyPoint = AnyLane['points'][number];

function buildKindLanes(
  kind: AnyMidiLaneKind,
  events: ReadonlyArray<RecordedExpressionEvent>,
  startPpq: number,
  loopLengthPpq: number,
  lengthPpq: number,
): AnyLane[] {
  const byLane = new Map<string, AnyLane>();
  for (const event of events) {
    const ppq = relativeExpressionPpq(event.ppq, startPpq, loopLengthPpq);
    if (ppq === null) continue;
    const key = kind.key(event.lane);
    const lane = byLane.get(key) ?? kind.shell(event.lane);
    (lane.points as AnyPoint[]).push({ ...event.value, ppq } as AnyPoint);
    byLane.set(key, lane);
  }
  return [...byLane.values()]
    .map((lane) => ({ ...lane, points: kind.sanitize(lane.points, lengthPpq) }) as AnyLane)
    .filter((lane) => lane.points.length > 0);
}

/**
 * Groups captured expression points into clip lanes relative to `startPpq`,
 * folded into the loop when `loopLengthPpq` > 0. Every kind with captured
 * points gets its field, even when normalization leaves it no lane.
 */
export function buildRecordedExpressionLanes(
  events: ReadonlyArray<RecordedExpressionEvent>,
  startPpq: number,
  loopLengthPpq: number,
  lengthPpq: number,
): Partial<MidiLaneFields> {
  const fields: Partial<Record<MidiLaneField, AnyLane[]>> = {};
  for (const kind of MIDI_LANE_KINDS) {
    const ofKind = events.filter((event) => event.field === kind.field);
    if (ofKind.length === 0) continue;
    fields[kind.field] = buildKindLanes(kind, ofKind, startPpq, loopLengthPpq, lengthPpq);
  }
  return fields as Partial<MidiLaneFields>;
}

/** The lane lists of `fields` that hold at least one lane. */
export function nonEmptyLaneFields(fields: Partial<MidiLaneFields>): Partial<MidiLaneFields> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, lanes]) => lanes.length > 0),
  ) as Partial<MidiLaneFields>;
}
