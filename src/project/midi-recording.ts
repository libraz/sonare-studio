import { type NoteBoundaryEvent, pairNoteBoundariesIntoNotes, type RawNote } from './midi-events';
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
  const amount = Math.min(1, Math.max(0, strength));
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
    while (cursor < endPpq - 1e-9) {
      const loopIndex = Math.floor(cursor / loopLengthPpq);
      const loopStart = loopIndex * loopLengthPpq;
      const inLoopStart = cursor - loopStart;
      const segmentEnd = Math.min(endPpq, loopStart + loopLengthPpq);
      const durationPpq = segmentEnd - cursor;
      if (durationPpq > 1e-9) {
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
  if (elapsedPpq < -1e-9) return null;
  return (
    recordingStartPpq +
    Math.max(0, Math.ceil(elapsedPpq / loopLengthPpq - 1e-9) - 1) * loopLengthPpq
  );
}

/** Returns the loop-pass start containing the latest captured event, or null. */
export function lastLoopPassWithEventsStartPpq<T extends { ppq: number }>(
  events: ReadonlyArray<T>,
  recordingStartPpq: number,
  loopLengthPpq: number,
): number | null {
  if (
    !Number.isFinite(recordingStartPpq) ||
    !Number.isFinite(loopLengthPpq) ||
    loopLengthPpq <= 0
  ) {
    return null;
  }
  let latestPpq = Number.NEGATIVE_INFINITY;
  let latestEvent: T | undefined;
  for (const event of events) {
    if (Number.isFinite(event.ppq) && event.ppq >= recordingStartPpq - 1e-9) {
      if (event.ppq >= latestPpq) {
        latestPpq = event.ppq;
        latestEvent = event;
      }
    }
  }
  if (!Number.isFinite(latestPpq)) return null;
  const closesAtBoundary =
    latestEvent !== undefined &&
    'kind' in latestEvent &&
    (latestEvent as { kind?: unknown }).kind === 'off' &&
    Math.abs((latestPpq - recordingStartPpq) % loopLengthPpq) < 1e-9;
  const offset = closesAtBoundary ? 1e-9 : 0;
  return (
    recordingStartPpq +
    Math.max(0, Math.floor((latestPpq - recordingStartPpq - offset) / loopLengthPpq)) *
      loopLengthPpq
  );
}

/**
 * Lists the loop passes that contain captured events, in chronological order.
 * Each pass is reported once even when it contains several MIDI event kinds,
 * allowing note and expression buffers to share an identical take boundary.
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
    if (!Number.isFinite(event.ppq) || event.ppq < recordingStartPpq - 1e-9) continue;
    const closesAtBoundary =
      'kind' in event &&
      (event as { kind?: unknown }).kind === 'off' &&
      Math.abs((event.ppq - recordingStartPpq) % loopLengthPpq) < 1e-9;
    const offset = closesAtBoundary ? 1e-9 : 0;
    const pass = Math.max(0, Math.floor((event.ppq - recordingStartPpq - offset) / loopLengthPpq));
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
    .filter((event) => event.ppq >= passStart - 1e-9 && event.ppq < passEnd - 1e-9)
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
    if (end <= start + 1e-9) continue;
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
    (note) => note.startPpq - startPpq >= -1e-9,
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
