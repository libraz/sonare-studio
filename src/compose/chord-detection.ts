/**
 * The single note-content chord detector shared by every surface that guesses
 * harmony from notes: the chord track ({@link estimateChordsFromTracks}) and the
 * score view's displayed chord symbols.
 *
 * libcantus's {@link inferChordTimelineFromNotes} analyses one span at a time
 * with one constant chord-slot length. A project rarely is one such span — the
 * meter changes, or the score hands over measures of differing lengths — so the
 * analysis is split into constant-slot ranges, each analysed in its own local
 * beat space and shifted back to absolute PPQ afterwards. The key inferred by
 * the first non-empty range is carried into the later ranges as context so a
 * meter change does not restart the tonal analysis from scratch; an explicit key
 * is passed to every range unchanged.
 *
 * Pure module; PPQ maps to beats with coefficient 1 (see chord-at-tick.ts).
 */

import type { ChordSpan, KeyScale, NoteEvent, TimeSignature } from '@libraz/libcantus';
import { inferChordTimelineFromNotes } from './chord-at-tick';
import { DEFAULT_KEY_SCALE } from './key';

/** One analysed range: an absolute PPQ span sliced into constant chord slots. */
export interface ChordDetectionRange {
  /** Inclusive start of the range in absolute PPQ. */
  startPpq: number;
  /** Exclusive end of the range in absolute PPQ. */
  endPpq: number;
  /** Chord-slot length in PPQ (> 0), e.g. one bar for one chord per measure. */
  slotLengthPpq: number;
  /** Meter used for metric accents; libcantus defaults to 4/4 when omitted. */
  ts?: TimeSignature;
}

/** One detected chord placed over an absolute PPQ region. */
export interface DetectedChordRegion {
  /** The detected chord, as a libcantus span rooted at the region start. */
  span: ChordSpan;
  /** Inclusive start of the region in absolute PPQ. */
  startPpq: number;
  /** Exclusive end of the region in absolute PPQ. */
  endPpq: number;
  /** libcantus's confidence in this region, in [0, 1]. */
  confidence: number;
}

/** Detected regions plus the key context that produced them. */
export interface ChordDetectionResult {
  /** Detected chord regions in time order (adjacent identical chords merged). */
  regions: DetectedChordRegion[];
  /** The key used for the analysis (given or inferred). */
  key: KeyScale;
}

/** Options steering {@link detectChordRegions}. */
export interface ChordDetectionOptions {
  /** Key context; inferred from the notes when omitted. */
  key?: KeyScale;
}

/** Clips note events to a range and rebases them onto the range's local beat 0. */
function localNoteEvents(notes: ReadonlyArray<NoteEvent>, range: ChordDetectionRange): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (const note of notes) {
    const start = Math.max(note.startBeat, range.startPpq);
    const end = Math.min(note.startBeat + note.durationBeat, range.endPpq);
    if (end <= start) continue;
    out.push({ ...note, startBeat: start - range.startPpq, durationBeat: end - start });
  }
  return out.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
}

/**
 * Detects chords from note content over a list of constant-slot ranges.
 *
 * Notes are clipped to each range, analysed in the range's local beat space and
 * shifted back, so a meter or measure-length change never straddles a chord
 * slot. Ranges without notes contribute nothing; libcantus merges adjacent
 * identical chords within a range, so a region can span several slots.
 *
 * @param notes Note events on the absolute PPQ timeline (percussion excluded by
 *   the caller — the histogram pools every note it is given).
 * @param ranges Analysed ranges in time order; a non-positive slot length or an
 *   empty span is skipped.
 * @param options Key context.
 * @returns The detected regions and the key used.
 */
export function detectChordRegions(
  notes: ReadonlyArray<NoteEvent>,
  ranges: ReadonlyArray<ChordDetectionRange>,
  options: ChordDetectionOptions = {},
): ChordDetectionResult {
  const regions: DetectedChordRegion[] = [];
  let resolvedKey = options.key;
  for (const range of ranges) {
    if (!(range.slotLengthPpq > 0) || !(range.endPpq > range.startPpq)) continue;
    const local = localNoteEvents(notes, range);
    if (local.length === 0) continue;
    const result = inferChordTimelineFromNotes(local, {
      ...(resolvedKey !== undefined ? { key: resolvedKey } : {}),
      ...(range.ts !== undefined ? { ts: range.ts } : {}),
      harmonicRhythm: range.slotLengthPpq,
      totalBeats: range.endPpq - range.startPpq,
    });
    resolvedKey = options.key ?? result.prevailingKey;
    result.timeline.segments.forEach((segment, index) => {
      const span: ChordSpan = {
        rootPc: segment.chord.rootPc,
        quality: segment.chord.quality,
        startBeat: segment.startBeat + range.startPpq,
      };
      if (segment.chord.bassPc !== undefined) span.bassPc = segment.chord.bassPc;
      regions.push({
        span,
        startPpq: segment.startBeat + range.startPpq,
        endPpq: segment.endBeat + range.startPpq,
        confidence: result.segmentConfidence[index] ?? 0,
      });
    });
  }
  return { regions, key: resolvedKey ?? DEFAULT_KEY_SCALE };
}
