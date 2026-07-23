/**
 * Cross-cutting input hygiene for every harmonic surface.
 *
 * libcantus has no concept of a percussion track: its `TrackRole` is only
 * melody/harmony/bass/other, and `analyzeArrangement`/`chordTimelineFromNotes`
 * pool every note into a single harmony estimate, then flag anything that does
 * not fit as a conflict. Feeding drum hits in therefore both poisons the key/
 * chord estimate and turns every drum note into a false dissonance. The fix is
 * to drop percussion tracks from the input set entirely (not tag them), from a
 * single place so no surface re-implements the heuristic and they cannot drift.
 *
 * The same file also carries the monophonic reduction ({@link topVoiceOnly})
 * that `harmonizeMelody`/`analyzeVoice`/`generateCounterMelody` need, since they
 * assume a single voice and do not split polyphony themselves.
 *
 * Pure module. The drum heuristic can be wrong in both directions (a pitched
 * instrument parked on channel 10, or a drum track off channel 10); a durable
 * fix is an explicit per-track percussion flag, with this heuristic as the
 * seed. Callers should surface which tracks were excluded rather than dropping
 * them silently.
 */

import type { NoteEvent } from '@libraz/libcantus';
import type { EditorNote, EditorTrack } from '@/project/types';

/** GM percussion channel (MIDI channel 10, zero-based 9). */
const GM_PERCUSSION_CHANNEL = 9;

/** Fraction of a track's notes on channel 10 above which it reads as percussion. */
const PERCUSSION_CHANNEL_FRACTION = 0.5;

/**
 * Track names that conventionally denote a percussion/drum track. This is only
 * a seed hint for the default classification; a language-agnostic override lives
 * in the explicit per-track {@link EditorTrack.percussion} flag, so this pattern
 * is deliberately not grown per natural language.
 */
const DRUM_NAME_PATTERN = /\b(drums?|perc(?:ussion)?|kit|cajon|conga|bongo|timbale)\b/i;

/** Conventional names that explicitly identify a melodic/top-line track. */
const MELODY_NAME_PATTERN = /\b(lead|melody|vocal|vox|topline|solo)\b/i;

/** A track paired with the editor notes it currently carries (across its clips). */
export interface TrackWithNotes {
  track: EditorTrack;
  notes: ReadonlyArray<EditorNote>;
}

/**
 * Whether a track should be treated as percussion and excluded from harmonic
 * analysis. The explicit {@link EditorTrack.percussion} override wins when set;
 * otherwise the heuristic flags the track when either:
 *  - its name matches a drum/percussion convention; or
 *  - the majority of its notes sit on the GM percussion channel (10).
 *
 * @param track Track to classify.
 * @param notes The track's notes (optional; the channel test is skipped when
 *   empty or absent).
 */
export function isDrumTrack(track: EditorTrack, notes?: ReadonlyArray<EditorNote>): boolean {
  if (track.percussion !== undefined) return track.percussion;
  if (DRUM_NAME_PATTERN.test(track.name)) return true;
  if (notes && notes.length > 0) {
    let onPercussion = 0;
    for (const note of notes) {
      if (note.channel === GM_PERCUSSION_CHANNEL) onPercussion++;
    }
    if (onPercussion / notes.length > PERCUSSION_CHANNEL_FRACTION) return true;
  }
  return false;
}

/** True when a track name explicitly declares it as the melodic/top voice. */
export function isMelodyTrack(track: EditorTrack): boolean {
  return MELODY_NAME_PATTERN.test(track.name);
}

/**
 * Keeps only the harmonic (non-percussion) tracks from a set of track/notes
 * pairs (see {@link isDrumTrack}). The dropped tracks are returned separately so
 * the UI can show what was excluded.
 */
export function harmonicTracksOnly<T extends TrackWithNotes>(
  items: ReadonlyArray<T>,
): { harmonic: T[]; excluded: T[] } {
  const harmonic: T[] = [];
  const excluded: T[] = [];
  for (const item of items) {
    if (isDrumTrack(item.track, item.notes)) excluded.push(item);
    else harmonic.push(item);
  }
  return { harmonic, excluded };
}

/**
 * Reduces a possibly-polyphonic note stream to a single voice by keeping only
 * the highest-pitched note at each onset. Required before `harmonizeMelody`,
 * `analyzeVoice`, and `generateCounterMelody`, which assume one voice and would
 * otherwise treat accompaniment chord tones as melody and skew key inference.
 *
 * Onsets are compared with a small epsilon so notes struck together collapse to
 * the top note; distinct onsets are all kept. Ties on pitch keep the longer
 * (then first-seen) note. Input order is not required; output is sorted by onset.
 *
 * @param notes Note events (timeline beats).
 * @param epsilon Onset grouping tolerance in beats (default 1e-6).
 */
export function topVoiceOnly(notes: ReadonlyArray<NoteEvent>, epsilon = 1e-6): NoteEvent[] {
  const sorted = [...notes].sort(
    (a, b) => a.startBeat - b.startBeat || b.pitch - a.pitch || b.durationBeat - a.durationBeat,
  );
  const out: NoteEvent[] = [];
  let groupStart = Number.NEGATIVE_INFINITY;
  for (const note of sorted) {
    if (note.startBeat - groupStart > epsilon) {
      out.push(note);
      groupStart = note.startBeat;
    }
  }
  return out;
}
