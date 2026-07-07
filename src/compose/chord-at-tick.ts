/**
 * Chord-timeline construction and querying for the editor's chord track.
 *
 * A thin wrapper over libcantus's analyze layer: the project's
 * {@link EditorChordSymbol} stream becomes a queryable {@link ChordTimeline}
 * (via {@link chordTimelineFromChords}), and, when the project has no chord
 * track, a timeline can be inferred from note content instead (via
 * {@link chordTimelineFromNotes}). PPQ maps to beats with coefficient 1
 * (1 PPQ = one quarter note), so chord region PPQ bounds are beat bounds.
 *
 * Pure module.
 */

import {
  type ChordData,
  type ChordTimeline,
  type ChordTimelineOptions,
  type ChordTimelineResult,
  chordTimelineFromChords,
  chordTimelineFromNotes,
  type NoteEvent,
} from '@libraz/libcantus';
import type { EditorChordSymbol } from '@/project/chords';
import { editorChordToChordSpan } from './chord-io';

/**
 * Builds a queryable chord timeline from the editor chord stream. Symbols are
 * ordered by start; the timeline runs to the latest region end.
 *
 * @param symbols Editor chord symbols (absolute PPQ regions).
 * @returns A chord timeline, empty when there are no symbols.
 */
export function buildChordTimeline(symbols: ReadonlyArray<EditorChordSymbol>): ChordTimeline {
  if (symbols.length === 0) return chordTimelineFromChords([], 0);
  const sorted = [...symbols].sort((a, b) => a.startPpq - b.startPpq);
  const spans = sorted.map((symbol) => editorChordToChordSpan(symbol, symbol.startPpq));
  const totalBeats = sorted.reduce((max, symbol) => Math.max(max, symbol.endPpq), 0);
  return chordTimelineFromChords(spans, totalBeats);
}

/**
 * The chord sounding at an absolute PPQ position, or null when no chord covers
 * it (before the first symbol, after the last, or in a gap).
 */
export function chordAtPpq(timeline: ChordTimeline, ppq: number): ChordData | null {
  return timeline.at(ppq);
}

/**
 * The editor chord symbol whose region covers an absolute PPQ position, or null.
 * Regions are half-open `[startPpq, endPpq)`.
 */
export function chordSymbolAtPpq(
  symbols: ReadonlyArray<EditorChordSymbol>,
  ppq: number,
): EditorChordSymbol | null {
  for (const symbol of symbols) {
    if (ppq >= symbol.startPpq && ppq < symbol.endPpq) return symbol;
  }
  return null;
}

/**
 * Infers a chord timeline from note content when the project has no chord
 * track. Callers must exclude percussion tracks (harmonicTracksOnly) before
 * flattening notes here — the histogram pools every note.
 *
 * @param notes Flattened note events from harmonic tracks (timeline beats).
 * @param options Analysis options (key, meter, harmonic rhythm, span).
 */
export function inferChordTimelineFromNotes(
  notes: ReadonlyArray<NoteEvent>,
  options?: ChordTimelineOptions,
): ChordTimelineResult {
  return chordTimelineFromNotes([...notes], options);
}
