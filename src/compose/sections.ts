/**
 * Song-form recovery from written notes: cuts a piece into equal units, finds
 * the units that restate earlier material, and reports the merged spans as
 * lettered sections.
 *
 * A thin adapter over libcantus's {@link sectionsFromNotes}. The library
 * measures likeness on melody and harmony together and assigns letters in order
 * of first appearance; this module's job is input hygiene and positioning:
 *
 *  - percussion tracks are dropped ({@link harmonicTracksOnly}), because a drum
 *    part repeats almost everywhere and would flatten the whole piece into one
 *    restatement;
 *  - every remaining track's notes are pooled, since form is a property of the
 *    piece rather than of any one part;
 *  - the project meter map is handed over whole, so a piece that changes metre
 *    is cut at its own bar lines;
 *  - beats map to PPQ with coefficient 1 (1 PPQ = one quarter note).
 *
 * This is the symbolic counterpart of the engine's audio-domain section
 * detection (src/project/audio-sections.ts): that one hears a waveform and
 * names what it hears (intro, verse, chorus), this one reads the notes and only
 * asserts which spans restate which. Neither supersedes the other.
 *
 * Callers must flatten each track's clips to absolute-timeline PPQ before
 * passing notes here. Pure module.
 */

import { type FormSectionOptions, type MeterMap, sectionsFromNotes } from '@libraz/libcantus';
import type { TimeSignatureSegment } from '@/project/types';
import { editorNotesToNoteEvents } from './notes-io';
import { harmonicTracksOnly, type TrackWithNotes } from './tracks';

/** One recovered span of the form, positioned in absolute PPQ. */
export interface DetectedSection {
  /**
   * The section's letter, assigned in order of first appearance. No functional
   * name (verse, chorus, bridge) is inferred: the analysis knows only that this
   * span restates that one.
   */
  label: string;
  /** Inclusive start in absolute PPQ. */
  startPpq: number;
  /** Exclusive end in absolute PPQ. */
  endPpq: number;
  /** The section's length in bars. */
  bars: number;
  /** Index of the first section carrying this label; its own index when first. */
  firstOccurrence: number;
  /** How alike this section and its first occurrence are, in [0, 1]. */
  similarity: number;
}

/** The result of a form analysis, with what it left out. */
export interface SectionReport {
  /** Recovered sections in time order; empty when there was nothing to read. */
  sections: DetectedSection[];
  /** Names of the percussion tracks excluded from the analysis. */
  excludedTrackNames: string[];
}

/** Maps the project meter map to libcantus's, using PPQ as the beat. */
function toMeterMap(timeSignatures: ReadonlyArray<TimeSignatureSegment>): MeterMap {
  return timeSignatures.map((segment) => ({
    startBeat: segment.startPpq,
    ts: { numerator: segment.numerator, denominator: segment.denominator },
  }));
}

/**
 * Recovers a piece's form from the notes of every harmonic track.
 *
 * @param tracks Tracks with absolute-timeline notes (percussion dropped inside).
 * @param timeSignatures Optional project meter map; 4/4 throughout when omitted.
 * @param unitBars Comparison unit in bars; the inferred hyperbar when omitted.
 * @returns The sections in time order and the tracks excluded as percussion.
 */
export function sectionsFromArrangement(
  tracks: ReadonlyArray<TrackWithNotes>,
  timeSignatures?: ReadonlyArray<TimeSignatureSegment>,
  unitBars?: number,
): SectionReport {
  const { harmonic, excluded } = harmonicTracksOnly(tracks);
  const excludedTrackNames = excluded.map((item) => item.track.name);
  const notes = editorNotesToNoteEvents(harmonic.flatMap((item) => item.notes));
  if (notes.length === 0) return { sections: [], excludedTrackNames };

  const opts: FormSectionOptions = {};
  if (timeSignatures !== undefined && timeSignatures.length > 0) {
    opts.meters = toMeterMap(timeSignatures);
  }
  if (unitBars !== undefined) opts.unitBars = unitBars;

  return {
    sections: sectionsFromNotes(notes, opts).map<DetectedSection>((section) => ({
      label: section.label,
      startPpq: section.startBeat,
      endPpq: section.endBeat,
      bars: section.bars,
      firstOccurrence: section.firstOccurrence,
      similarity: section.similarity,
    })),
    excludedTrackNames,
  };
}
