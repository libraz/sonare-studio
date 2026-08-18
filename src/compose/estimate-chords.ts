/**
 * Chord-progression estimation from note content, for projects that carry no
 * chord track (classical, sketches, imported MIDI). The arrangement's harmonic
 * tracks are pooled into a single note histogram and sliced into per-bar chord
 * slots by the shared {@link detectChordRegions}, one range per meter so a time
 * signature change gets its own bar length; the detected regions become an
 * {@link EditorChordSymbol} stream ready for the chord track.
 *
 * Percussion tracks are dropped first ({@link harmonicTracksOnly}) so drum hits
 * neither poison the key/chord estimate nor appear as spurious harmony. The
 * per-segment confidence libcantus reports is surfaced alongside the symbols so
 * a low-confidence estimate can be shown tentatively rather than as fact.
 *
 * Pure module (no Vue/Pinia); callers flatten clips to absolute PPQ.
 */

import { type KeyScale, spanFromChord, type TimeSignature } from '@libraz/libcantus';
import type { EditorChordSymbol } from '@/project/chords';
import { measureRangeAt, meterBarLengthPpq, timeSignatureRanges } from '@/project/time-signature';
import type { TimeSignatureSegment } from '@/project/types';
import { inferChordTimelineFromNotes } from './chord-at-tick';
import { type ChordDetectionRange, detectChordRegions } from './chord-detection';
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

type EstimatedChordsCore = Omit<EstimatedChords, 'excludedTrackNames'>;

/**
 * Estimates from tracks that have already passed {@link harmonicTracksOnly}.
 * Keeping this separate from the public boundary prevents meter-range clips
 * from being classified again using their local channel distribution.
 */
function estimateChordsFromHarmonicTracks(
  harmonic: ReadonlyArray<TrackWithNotes>,
  options?: EstimateChordsOptions,
): EstimatedChordsCore {
  const notes = harmonic.flatMap((item) => editorNotesToNoteEvents(item.notes));
  if (notes.length === 0) {
    return {
      symbols: [],
      key: options?.key ?? DEFAULT_KEY_SCALE,
      confidence: [],
    };
  }
  if (options?.timeSignatures !== undefined) {
    const firstNotePpq = Math.min(...notes.map((note) => note.startBeat));
    const startPpq = measureRangeAt(options.timeSignatures, firstNotePpq).startPpq;
    const endPpq = Math.max(...notes.map((note) => note.startBeat + note.durationBeat));
    const ranges: ChordDetectionRange[] = timeSignatureRanges(
      options.timeSignatures,
      startPpq,
      endPpq,
    ).map((range) => ({
      startPpq: range.startPpq,
      endPpq: range.endPpq,
      slotLengthPpq: meterBarLengthPpq(range),
      ts: { numerator: range.numerator, denominator: range.denominator },
    }));
    const detected = detectChordRegions(
      notes,
      ranges,
      options.key !== undefined ? { key: options.key } : {},
    );
    return {
      symbols: detected.regions.map((region) =>
        chordSpanToEditorChord(region.span, region.startPpq, region.endPpq),
      ),
      key: detected.key,
      confidence: detected.regions.map((region) => region.confidence),
    };
  }
  const result = inferChordTimelineFromNotes(notes, options);
  const symbols = result.timeline.segments.map((segment) =>
    chordSpanToEditorChord(spanFromChord(segment.chord, 0), segment.startBeat, segment.endBeat),
  );
  return { symbols, key: result.prevailingKey, confidence: result.segmentConfidence };
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
  const result = estimateChordsFromHarmonicTracks(harmonic, options);
  return { ...result, excludedTrackNames };
}
