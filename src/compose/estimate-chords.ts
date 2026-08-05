/**
 * Chord-progression estimation from note content, for projects that carry no
 * chord track (classical, sketches, imported MIDI). The arrangement's harmonic
 * tracks are pooled into a single note histogram and sliced into per-bar chord
 * slots by libcantus's {@link inferChordTimelineFromNotes}; the inferred segments
 * become an {@link EditorChordSymbol} stream ready for the chord track.
 *
 * Percussion tracks are dropped first ({@link harmonicTracksOnly}) so drum hits
 * neither poison the key/chord estimate nor appear as spurious harmony. The
 * per-segment confidence libcantus reports is surfaced alongside the symbols so
 * a low-confidence estimate can be shown tentatively rather than as fact.
 *
 * Pure module (no Vue/Pinia); callers flatten clips to absolute PPQ.
 */

import type { ChordData, ChordSpan, KeyScale, TimeSignature } from '@libraz/libcantus';
import type { EditorChordSymbol } from '@/project/chords';
import { measureRangeAt, meterBarLengthPpq, timeSignatureRanges } from '@/project/time-signature';
import type { TimeSignatureSegment } from '@/project/types';
import { inferChordTimelineFromNotes } from './chord-at-tick';
import { chordSpanToEditorChord } from './chord-io';
import { DEFAULT_KEY_SCALE } from './key';
import { editorNotesToNoteEvents } from './notes-io';
import { harmonicTracksOnly, type TrackWithNotes } from './tracks';

/** Options steering the estimation (all optional; libcantus supplies defaults). */
export interface EstimateChordsOptions {
  /** Key context; inferred from the notes when omitted. */
  key?: KeyScale;
  /** Meter for metric accents; defaults to 4/4. */
  ts?: TimeSignature;
  /** Chord-slot length in beats; defaults to one bar of `ts`. */
  harmonicRhythm?: number;
  /** End of the analyzed span in beats; defaults to the last note's end. */
  totalBeats?: number;
  /** Full project meter map; when supplied, analysis is split at each change. */
  timeSignatures?: ReadonlyArray<TimeSignatureSegment>;
}

/** The estimated chord track plus the analysis context that produced it. */
export interface EstimatedChords {
  /** Inferred chord symbols over absolute PPQ regions (empty when no notes). */
  symbols: EditorChordSymbol[];
  /** The key used for the estimate (given or inferred). */
  key: KeyScale;
  /** One confidence value in [0, 1] per symbol, in order. */
  confidence: number[];
  /** Names of percussion tracks dropped before estimation (shown as excluded). */
  excludedTrackNames: string[];
}

/** Places an inferred chord on a beat as a libcantus {@link ChordSpan}. */
function chordToSpan(chord: ChordData): ChordSpan {
  const span: ChordSpan = { rootPc: chord.rootPc, quality: chord.quality, startBeat: 0 };
  if (chord.bassPc !== undefined) span.bassPc = chord.bassPc;
  return span;
}

/**
 * Estimates a chord-symbol stream from a project's tracks. Percussion tracks are
 * excluded, the remaining notes are pooled, and the inferred timeline's segments
 * are mapped to editor symbols over their beat regions.
 *
 * @param tracks Tracks paired with their notes flattened to absolute PPQ.
 * @param options Analysis options (key, meter, harmonic rhythm, span).
 */
export function estimateChordsFromTracks(
  tracks: ReadonlyArray<TrackWithNotes>,
  options?: EstimateChordsOptions,
): EstimatedChords {
  const { harmonic, excluded } = harmonicTracksOnly(tracks);
  const excludedTrackNames = excluded.map((item) => item.track.name);
  const notes = harmonic.flatMap((item) => editorNotesToNoteEvents(item.notes));
  if (notes.length === 0) {
    return {
      symbols: [],
      key: options?.key ?? DEFAULT_KEY_SCALE,
      confidence: [],
      excludedTrackNames,
    };
  }
  if (options?.timeSignatures !== undefined) {
    const firstNotePpq = Math.min(...notes.map((note) => note.startBeat));
    const startPpq = measureRangeAt(options.timeSignatures, firstNotePpq).startPpq;
    const endPpq = Math.max(...notes.map((note) => note.startBeat + note.durationBeat));
    const ranges = timeSignatureRanges(options.timeSignatures, startPpq, endPpq);
    const symbols: EditorChordSymbol[] = [];
    const confidence: number[] = [];
    let resolvedKey = options.key ?? DEFAULT_KEY_SCALE;
    for (const range of ranges) {
      const localTracks = harmonic.map((item) => ({
        track: item.track,
        notes: item.notes.flatMap((note) => {
          const start = Math.max(note.startPpq, range.startPpq);
          const end = Math.min(note.startPpq + note.durationPpq, range.endPpq);
          return end > start
            ? [{ ...note, startPpq: start - range.startPpq, durationPpq: end - start }]
            : [];
        }),
      }));
      const local = estimateChordsFromTracks(localTracks, {
        key: options.key ?? resolvedKey,
        ts: { numerator: range.numerator, denominator: range.denominator },
        harmonicRhythm: meterBarLengthPpq(range),
        totalBeats: range.endPpq - range.startPpq,
      });
      resolvedKey = local.key;
      symbols.push(
        ...local.symbols.map((symbol) => ({
          ...symbol,
          startPpq: symbol.startPpq + range.startPpq,
          endPpq: symbol.endPpq + range.startPpq,
        })),
      );
      confidence.push(...local.confidence);
    }
    return { symbols, key: resolvedKey, confidence, excludedTrackNames };
  }
  const result = inferChordTimelineFromNotes(notes, options);
  const symbols = result.timeline.segments.map((segment) =>
    chordSpanToEditorChord(chordToSpan(segment.chord), segment.startBeat, segment.endBeat),
  );
  return { symbols, key: result.key, confidence: result.segmentConfidence, excludedTrackNames };
}
