/**
 * Motivic reading: which figures a part restates, and how the restatements
 * stand to one another.
 *
 * A thin adapter over libcantus's {@link extractMotifs} and
 * {@link relateMotifs}. The library finds every recurring cell and names the
 * transformation between two of them; this module's job is input hygiene and
 * making the answer readable:
 *
 *  - percussion tracks are dropped ({@link harmonicTracksOnly}), because a cell
 *    of drum hits is a groove, not a motif;
 *  - each track is reduced to its top voice ({@link topVoiceOnly}) before the
 *    search, so a chord's inner notes are not read as a line;
 *  - overlapping cells are collapsed. The search reports every window that
 *    recurs, so one four-note figure also comes back as the window starting one
 *    note later, and the one after that. Keeping the strongest of an overlapping
 *    family is what turns four rows saying the same thing into one row;
 *  - the library's prose rationale is not carried across. It is English-only, so
 *    a reading is reported as the facts it rests on — the shape traced, how many
 *    statements, whether they move in pitch — and the display writes those in
 *    its own language;
 *  - beats map to PPQ with coefficient 1 (1 PPQ = one quarter note).
 *
 * Read-only analysis: nothing here writes to the project. Callers must flatten
 * each track's clips to absolute-timeline PPQ before passing notes. Pure module.
 */

import {
  extractMotifs,
  type KeyScale,
  type MelodicContourShape,
  type MotifData,
  type MotifRelationKind,
  melodicContour,
  relateMotifs,
} from '@libraz/libcantus';
import { editorNotesToNoteEvents } from './notes-io';
import { harmonicTracksOnly, type TrackWithNotes, topVoiceOnly } from './tracks';

/** One statement of a figure, positioned in absolute PPQ. */
export interface MotifStatement {
  /** Inclusive start in absolute PPQ. */
  startPpq: number;
  /** Exclusive end in absolute PPQ. */
  endPpq: number;
  /** Semitones this statement stands above the first one. */
  transpose: number;
}

/** A figure a part states more than once. */
export interface DetectedMotif {
  /** How many notes the cell holds. */
  noteCount: number;
  /** Every statement, in time order; at least two. */
  statements: MotifStatement[];
  /** The shape the cell traces, so a row can name the figure rather than count it. */
  shape: MelodicContourShape;
  /** True when the statements do not all sit at the same pitch. */
  transposed: boolean;
}

/** How one reported figure stands to another. */
export interface MotifRelationship {
  /** Index of the earlier figure in {@link TrackMotifs.motifs}. */
  fromIndex: number;
  /** Index of the later figure. */
  toIndex: number;
  kind: MotifRelationKind;
  /** True when the second begins where the first ends, which makes a sequence. */
  sequence: boolean;
  /** Semitones from the first figure's first note to the second's. */
  semitones: number;
}

/** One track's motivic reading. */
export interface TrackMotifs {
  trackName: string;
  /** Figures in strength order (most statements first). */
  motifs: DetectedMotif[];
  /** Named transformations between the reported figures. */
  relations: MotifRelationship[];
}

/** The motivic analysis shaped for the editor. */
export interface MotifReport {
  /** One entry per track that states a figure more than once. */
  tracks: TrackMotifs[];
  /** Names of the percussion tracks excluded from the analysis. */
  excludedTrackNames: string[];
}

/**
 * How many figures a track reports. The search finds far more than a reader can
 * hold at once, and the tail is made of cells that recur twice by accident.
 */
const MAX_MOTIFS_PER_TRACK = 4;

/**
 * Keeps the strongest of each overlapping family.
 *
 * A cell that recurs is also found starting one note later, and one after that,
 * so the raw list is dominated by near-duplicates of the same figure. Taking
 * them strongest-first and rejecting any whose statements land on ground an
 * accepted figure already covers leaves one row per real figure.
 */
function withoutOverlaps(motifs: ReadonlyArray<MotifData>): MotifData[] {
  const ranked = [...motifs].sort(
    (a, b) => b.occurrences.length - a.occurrences.length || b.notes.length - a.notes.length,
  );
  const accepted: MotifData[] = [];
  const covered: Array<{ startBeat: number; endBeat: number }> = [];
  for (const motif of ranked) {
    const overlaps = motif.occurrences.some((occurrence) =>
      covered.some(
        (span) => occurrence.startBeat < span.endBeat && occurrence.endBeat > span.startBeat,
      ),
    );
    if (overlaps) continue;
    accepted.push(motif);
    covered.push(...motif.occurrences.map((o) => ({ startBeat: o.startBeat, endBeat: o.endBeat })));
    if (accepted.length >= MAX_MOTIFS_PER_TRACK) break;
  }
  return accepted;
}

/** Names every transformation holding between the reported figures. */
function relationsBetween(
  motifs: ReadonlyArray<MotifData>,
  key: KeyScale | undefined,
): MotifRelationship[] {
  const out: MotifRelationship[] = [];
  for (let from = 0; from < motifs.length; from += 1) {
    for (let to = from + 1; to < motifs.length; to += 1) {
      const relation =
        key === undefined
          ? relateMotifs(motifs[from], motifs[to])
          : relateMotifs(motifs[from], motifs[to], key);
      // Two figures that are simply different are not related; the library says
      // so with null rather than naming a transformation that is not there.
      if (relation === null) continue;
      out.push({
        fromIndex: from,
        toIndex: to,
        kind: relation.kind,
        sequence: relation.sequence,
        semitones: relation.semitones,
      });
    }
  }
  return out;
}

/**
 * Reads the figures each part restates.
 *
 * @param tracks Tracks with absolute-timeline notes (percussion dropped inside).
 * @param key Optional key context; without it a tonal sequence cannot be told
 *   from a literal one, and the pair reads as the literal transposition it is.
 * @returns One entry per track that states a figure, and what was excluded.
 */
export function analyzeMotifs(tracks: ReadonlyArray<TrackWithNotes>, key?: KeyScale): MotifReport {
  const { harmonic, excluded } = harmonicTracksOnly(tracks);
  const out: TrackMotifs[] = [];
  for (const item of harmonic) {
    const line = topVoiceOnly(editorNotesToNoteEvents(item.notes));
    if (line.length === 0) continue;
    const motifs = withoutOverlaps(extractMotifs(line));
    if (motifs.length === 0) continue;
    out.push({
      trackName: item.track.name,
      motifs: motifs.map<DetectedMotif>((motif) => ({
        noteCount: motif.notes.length,
        statements: motif.occurrences.map((occurrence) => ({
          startPpq: occurrence.startBeat,
          endPpq: occurrence.endBeat,
          transpose: occurrence.transpose,
        })),
        shape: melodicContour(motif).shape,
        transposed: motif.occurrences.some((occurrence) => occurrence.transpose !== 0),
      })),
      relations: relationsBetween(motifs, key),
    });
  }
  return { tracks: out, excludedTrackNames: excluded.map((item) => item.track.name) };
}
