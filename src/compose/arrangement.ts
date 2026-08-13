/**
 * Cross-track arrangement analysis: surfaces notes that clash with the sounding
 * harmony and a coarse tension curve for a whole multi-track piece.
 *
 * A thin adapter over libcantus's analyze layer ({@link analyzeArrangement} /
 * {@link tensionCurveFrom}). The heavy lifting — pooling every track's notes into
 * one inferred harmony, fanning polyphonic tracks into monophonic sub-voices,
 * and flagging clashes — happens in the library. This module's job is input
 * hygiene and shaping the result for the UI:
 *
 *  - percussion tracks are dropped from the input entirely ({@link harmonicTracksOnly}),
 *    because libcantus has no drum concept and would pool drum pitches into the
 *    harmony estimate and flag every hit as a false conflict; the dropped track
 *    names are returned so the UI can show what was excluded;
 *  - a light role heuristic labels the remaining tracks (role only annotates the
 *    output; it never changes conflict detection);
 *  - beats map to PPQ with coefficient 1 (1 PPQ = one quarter note), so conflict
 *    beats are already absolute PPQ positions.
 *
 * Callers must flatten each track's clips to absolute-timeline PPQ before
 * passing notes here (mirroring the guidance surface). Pure module.
 */

import {
  type ArrangementOptions,
  analyzeArrangement,
  type KeyScale,
  type NoteSafety,
  type TensionPoint,
  tensionCurveFrom,
} from '@libraz/libcantus';
import { measureRangeAt, timeSignatureRanges } from '@/project/time-signature';
import type { TimeSignatureSegment } from '@/project/types';
import { DEFAULT_KEY_SCALE } from './key';
import { timeSignatureAtPpq } from './meter';
import { editorNotesToNoteEvents } from './notes-io';
import { harmonicTracksOnly, isMelodyTrack, type TrackWithNotes } from './tracks';

/** A track's notes already flattened to absolute timeline PPQ. */
export type { TrackWithNotes };

/** Track-name conventions that hint at a bass part. */
const BASS_NAME_PATTERN = /\b(bass|sub|808|low)\b/i;

/** Track-name conventions that hint at a harmony/backing part. */
const HARMONY_NAME_PATTERN = /\b(chord|harmony|backing|pad|keys?|piano|rhythm|comp)\b/i;

/** Average register below this MIDI pitch reads as a bass part by default. */
const BASS_REGISTER_CEILING = 52;

/** A note clashing with the sounding harmony, positioned in absolute PPQ. */
export interface ArrangementConflict {
  /** Absolute PPQ of the clash (== libcantus beat). */
  ppq: number;
  trackName: string;
  pitch: number;
  safety: NoteSafety;
  /** SafetyResult reasons bitmask. */
  reasons: number;
  rationale?: string;
}

/** The arrangement analysis shaped for the editor. */
export interface ArrangementReport {
  /** The harmony key libcantus inferred from the pooled notes. */
  key: KeyScale;
  /** Notes clashing with the sounding harmony, worst severity first. */
  conflicts: ArrangementConflict[];
  /** Names of the percussion tracks excluded from analysis. */
  excludedTrackNames: string[];
}

/** Infers a coarse arrangement role from a track's name and register. */
function inferRole(track: TrackWithNotes): 'melody' | 'harmony' | 'bass' | 'other' {
  const name = track.track.name;
  if (BASS_NAME_PATTERN.test(name)) return 'bass';
  if (isMelodyTrack(track.track)) return 'melody';
  if (HARMONY_NAME_PATTERN.test(name)) return 'harmony';
  if (track.notes.length > 0) {
    const avg = track.notes.reduce((sum, note) => sum + note.pitch, 0) / track.notes.length;
    if (avg < BASS_REGISTER_CEILING) return 'bass';
  }
  return 'other';
}

/** Builds the libcantus options (key context, governing meter at the start). */
function optionsFor(
  key: KeyScale | undefined,
  timeSignatures: ReadonlyArray<TimeSignatureSegment> | undefined,
): ArrangementOptions {
  const opts: ArrangementOptions = {};
  if (key !== undefined) opts.key = key;
  if (timeSignatures !== undefined) opts.ts = timeSignatureAtPpq(timeSignatures, 0);
  return opts;
}

/** Maps harmonic tracks to libcantus arrangement tracks (absolute-PPQ notes). */
function toArrangementTracks(harmonic: ReadonlyArray<TrackWithNotes>) {
  return harmonic.map((track) => ({
    name: track.track.name,
    role: inferRole(track),
    notes: editorNotesToNoteEvents(track.notes),
  }));
}

/** Clips tracks to a meter range and re-bases them for libcantus's local meter. */
function tracksInMeterRange(
  tracks: ReadonlyArray<TrackWithNotes>,
  startPpq: number,
  endPpq: number,
): TrackWithNotes[] {
  return tracks.map((item) => ({
    track: item.track,
    notes: item.notes.flatMap((note) => {
      const start = Math.max(note.startPpq, startPpq);
      const end = Math.min(note.startPpq + note.durationPpq, endPpq);
      return end > start ? [{ ...note, startPpq: start - startPpq, durationPpq: end - start }] : [];
    }),
  }));
}

function analysisRanges(
  harmonic: ReadonlyArray<TrackWithNotes>,
  timeSignatures: ReadonlyArray<TimeSignatureSegment> | undefined,
) {
  const notes = harmonic.flatMap((item) => item.notes);
  const start = Math.min(...notes.map((note) => note.startPpq));
  const end = Math.max(...notes.map((note) => note.startPpq + note.durationPpq));
  if (timeSignatures !== undefined) {
    const firstMeasure = measureRangeAt(timeSignatures, start);
    const lastMeasure = measureRangeAt(timeSignatures, Math.max(start, end - 1e-6));
    return timeSignatureRanges(
      timeSignatures,
      firstMeasure.startPpq,
      lastMeasure.startPpq + lastMeasure.lengthPpq,
    );
  }
  return [{ startPpq: start, endPpq: end, numerator: 4, denominator: 4 }];
}

/**
 * Analyzes an arrangement, returning the clashing notes and the tracks that
 * were excluded as percussion.
 *
 * @param tracks Tracks with absolute-timeline notes (percussion dropped inside).
 * @param key Optional key context; inferred from the notes when omitted.
 * @param timeSignatures Optional project meter map (the start segment is used).
 */
export function analyzeArrangementTracks(
  tracks: ReadonlyArray<TrackWithNotes>,
  key?: KeyScale,
  timeSignatures?: ReadonlyArray<TimeSignatureSegment>,
): ArrangementReport {
  const { harmonic, excluded } = harmonicTracksOnly(tracks);
  const excludedTrackNames = excluded.map((item) => item.track.name);
  if (harmonic.length === 0) {
    // No harmonic material to infer from: fall back to a valid key (C major)
    // rather than an empty scale mask, which downstream scale math reads as a
    // scale with no degrees.
    return { key: key ?? DEFAULT_KEY_SCALE, conflicts: [], excludedTrackNames };
  }
  let resolvedKey: KeyScale | undefined = key;
  const conflicts: ArrangementConflict[] = [];
  for (const range of analysisRanges(harmonic, timeSignatures)) {
    const local = tracksInMeterRange(harmonic, range.startPpq, range.endPpq);
    if (local.every((track) => track.notes.length === 0)) continue;
    const analysis = analyzeArrangement(toArrangementTracks(local), {
      ...optionsFor(resolvedKey, undefined),
      ts: { numerator: range.numerator, denominator: range.denominator },
    });
    resolvedKey = analysis.key;
    conflicts.push(
      ...analysis.conflicts.map<ArrangementConflict>((conflict) => ({
        ppq: conflict.beat + range.startPpq,
        trackName: conflict.trackName,
        pitch: conflict.pitch,
        safety: conflict.safety,
        reasons: conflict.reasons,
        ...(conflict.rationale !== undefined ? { rationale: conflict.rationale } : {}),
      })),
    );
  }
  return { key: resolvedKey ?? DEFAULT_KEY_SCALE, conflicts, excludedTrackNames };
}

/**
 * Samples the harmonic tension of an arrangement at regular beats. Percussion
 * tracks are excluded first, matching {@link analyzeArrangementTracks}.
 *
 * @param tracks Tracks with absolute-timeline notes.
 * @param step Sample spacing in beats (default 1); must be positive.
 * @param key Optional key context.
 * @param timeSignatures Optional project meter map.
 * @returns One tension sample per step, in beat order (empty with no harmonic tracks).
 */
export function arrangementTensionCurve(
  tracks: ReadonlyArray<TrackWithNotes>,
  step = 1,
  key?: KeyScale,
  timeSignatures?: ReadonlyArray<TimeSignatureSegment>,
): TensionPoint[] {
  const { harmonic } = harmonicTracksOnly(tracks);
  if (harmonic.length === 0) return [];
  let resolvedKey = key;
  const points: TensionPoint[] = [];
  for (const range of analysisRanges(harmonic, timeSignatures)) {
    const local = tracksInMeterRange(harmonic, range.startPpq, range.endPpq);
    if (local.every((track) => track.notes.length === 0)) continue;
    const arrangementTracks = toArrangementTracks(local);
    const analysis = analyzeArrangement(arrangementTracks, {
      ...optionsFor(resolvedKey, undefined),
      ts: { numerator: range.numerator, denominator: range.denominator },
    });
    if (key === undefined) resolvedKey = analysis.key;
    points.push(
      ...tensionCurveFrom(arrangementTracks, analysis, {
        ts: { numerator: range.numerator, denominator: range.denominator },
        step,
      }).map((point) => ({ ...point, beat: point.beat + range.startPpq })),
    );
  }
  return points;
}
