import { type NoteBoundaryEvent, pairNoteBoundariesIntoNotes, type RawNote } from './midi-events';

/**
 * Snaps each note's start to the nearest grid line, preserving its length.
 *
 * Only note starts move (the classic "quantize start" behaviour); durations
 * are kept so a quantized take still phrases like the performance. A start
 * never moves before 0.
 *
 * @param notes Clip-relative notes to quantize.
 * @param gridPpq Grid spacing in PPQ (e.g. 0.25 for 1/16 notes); <= 0 is a
 *   no-op (returns the notes unchanged).
 * @returns Notes with quantized starts, sorted by start position.
 */
export function quantizeRecordedNotes(notes: ReadonlyArray<RawNote>, gridPpq: number): RawNote[] {
  if (!Number.isFinite(gridPpq) || gridPpq <= 0) return notes.slice();
  const quantized = notes.map((note) => ({
    ...note,
    startPpq: Math.max(0, Math.round(note.startPpq / gridPpq) * gridPpq),
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
}

/**
 * Turns captured note-on/note-off boundaries into clip-relative notes and a
 * clip length, ready for {@link addRecordedMidiClip}.
 *
 * Boundaries are paired into notes, offset to the clip window, optionally
 * quantized, and the clip length is taken as the larger of the capture window
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
  const { startPpq, stopPpq, gridPpq = 0 } = options;
  const paired = pairNoteBoundariesIntoNotes(boundaries);
  const relative: RawNote[] = [];
  for (const note of paired) {
    const relStart = note.startPpq - startPpq;
    // A note begins during the capture by construction; guard float drift.
    if (relStart < -1e-9) continue;
    relative.push({ ...note, startPpq: Math.max(0, relStart) });
  }
  const notes = quantizeRecordedNotes(relative, gridPpq);
  if (notes.length === 0) return null;
  const lastEnd = notes.reduce((max, note) => Math.max(max, note.startPpq + note.durationPpq), 0);
  const lengthPpq = Math.max(stopPpq - startPpq, lastEnd);
  if (!(lengthPpq > 0)) return null;
  return { notes, lengthPpq };
}
