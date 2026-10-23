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
import type { TrackInstrument } from '@/project/instrument';
import { clipKind, type EditorClip, type EditorNote, type EditorTrack } from '@/project/types';

/** GM percussion channel (MIDI channel 10, zero-based 9). */
export const GM_PERCUSSION_CHANNEL = 9;

/** Number of MIDI channels an SF2 channel map can address. */
const MIDI_CHANNEL_COUNT = 16;

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

/** Whether a bank uses the GM2 percussion MSB (120). */
function isPercussionBank(bank: number | undefined): boolean {
  return bank !== undefined && Math.floor(bank / 128) === 120;
}

/** Whether a stored instrument explicitly selects a percussion sound bank. */
function instrumentDeclaresPercussion(instrument: TrackInstrument | undefined): boolean {
  if (!instrument) return false;
  if (instrument.kind === 'synth-preset') {
    return (
      instrument.preset === 'drum-kit' ||
      (instrument.useGmPrograms === true && isPercussionBank(instrument.gmBank))
    );
  }
  if (instrument.kind === 'synth-patch') return instrument.patch.preset === 'drum-kit';
  if (instrument.kind === 'sf2') {
    if (isPercussionBank(instrument.bank)) return true;
    // Unmapped channels inherit the melodic track-level program, so the map
    // alone classifies the track only when every channel resolves to a kit.
    const channelMap = instrument.channelMap ?? [];
    for (let channel = 0; channel < MIDI_CHANNEL_COUNT; channel++) {
      const entry = channelMap.find((candidate) => candidate.channel === channel);
      if (entry === undefined) return false;
      if (channel !== GM_PERCUSSION_CHANNEL && !isPercussionBank(entry.bank)) return false;
    }
    return true;
  }
  return false;
}

/** A track paired with the editor notes it currently carries (across its clips). */
export interface TrackWithNotes {
  track: EditorTrack;
  notes: ReadonlyArray<EditorNote>;
}

/**
 * Whether a track should be treated as percussion and excluded from harmonic
 * analysis. Judgment order:
 *  1. The explicit {@link EditorTrack.percussion} override, if set.
 *  2. Generated drum tracks ({@link EditorTrack.generated?.part} === 'drums').
 *  3. An instrument selecting a drum kit or GM2 percussion bank.
 *  4. Name heuristic matching drum/percussion conventions.
 *  5. Majority of notes sitting on the GM percussion channel (10).
 *
 * @param track Track to classify.
 * @param notes The track's notes (optional; the channel test is skipped when
 *   empty or absent).
 */
export function isDrumTrack(
  track: EditorTrack | null | undefined,
  notes?: ReadonlyArray<EditorNote>,
): boolean {
  if (!track) return false;
  if (track.percussion !== undefined) return track.percussion;
  if (track.generated?.part === 'drums') return true;
  if (instrumentDeclaresPercussion(track.instrument)) return true;
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

/**
 * Picks the MIDI channel new notes should use for a track.
 *
 * Percussion always uses the GM percussion channel. For melodic tracks, retain
 * the modal channel already present in the clip so edits to imported
 * multi-channel material do not silently move notes to channel 1. Ties prefer
 * the lower channel number, making the result independent of note ordering.
 */
export function preferredNoteChannel(
  track: EditorTrack | null | undefined,
  notes: ReadonlyArray<EditorNote>,
): number {
  if (!track) return 0;
  if (isDrumTrack(track, notes)) return GM_PERCUSSION_CHANNEL;
  const counts = new Array<number>(16).fill(0);
  for (const note of notes) {
    if (Number.isInteger(note.channel) && note.channel >= 0 && note.channel < counts.length) {
      counts[note.channel] += 1;
    }
  }
  let preferred = 0;
  for (let channel = 1; channel < counts.length; channel += 1) {
    if (counts[channel] > counts[preferred]) preferred = channel;
  }
  return preferred;
}

/** True when a track name explicitly declares it as the melodic/top voice. */
export function isMelodyTrack(track: EditorTrack): boolean {
  return MELODY_NAME_PATTERN.test(track.name);
}

/**
 * Per-note percussion classification for one track: every note of a drum track
 * ({@link isDrumTrack}), no note of a track explicitly marked non-percussion,
 * and otherwise the notes on the GM percussion channel. Without a track only
 * the channel decides.
 *
 * @param track Track providing the classification, if known.
 * @param trackNotes The track's notes, for the channel-majority test.
 * @returns A predicate telling whether a note of that track is percussion.
 */
export function percussionNoteTest(
  track: EditorTrack | null | undefined,
  trackNotes: ReadonlyArray<EditorNote>,
): (note: Pick<EditorNote, 'channel'>) => boolean {
  if (isDrumTrack(track, trackNotes)) return () => true;
  if (track?.percussion === false) return () => false;
  return (note) => note.channel === GM_PERCUSSION_CHANNEL;
}

/**
 * The MIDI channel a note is notated and exported on: the GM percussion channel
 * for a percussion note; a pitched note keeps its own channel, moved off the
 * channel General MIDI reserves for drums.
 *
 * @param channel Source channel (0-based).
 * @param percussion Whether the note classifies as percussion ({@link percussionNoteTest}).
 */
export function notatedChannel(channel: number, percussion: boolean): number {
  if (percussion) return GM_PERCUSSION_CHANNEL;
  return channel === GM_PERCUSSION_CHANNEL ? 0 : channel;
}

/**
 * Drops the notes that classify as percussion for the track
 * ({@link percussionNoteTest}).
 *
 * @param track Track providing the percussion classification.
 * @param notes Notes to filter.
 */
export function harmonicNotes<T extends EditorNote>(
  track: EditorTrack,
  notes: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const isPercussion = percussionNoteTest(track, notes);
  return notes.filter((note) => !isPercussion(note));
}

/** A track's notes across its MIDI clips, as the drum classification reads them. */
export function trackMidiNotes(clips: ReadonlyArray<EditorClip>, trackId: number): EditorNote[] {
  return clips
    .filter((clip) => clip.trackId === trackId && clipKind(clip) === 'midi')
    .flatMap((clip) => clip.notes);
}

/**
 * Unfrozen MIDI tracks that classify as percussion over their MIDI-clip notes,
 * in track order: the tracks a drum regeneration may target.
 */
export function editableDrumTracks(
  tracks: ReadonlyArray<EditorTrack>,
  clips: ReadonlyArray<EditorClip>,
): EditorTrack[] {
  return tracks.filter(
    (track) =>
      track.kind === 'midi' &&
      track.frozen === undefined &&
      isDrumTrack(track, trackMidiNotes(clips, track.id)),
  );
}

/**
 * Keeps only the harmonic (non-percussion) tracks from a set of track/notes
 * pairs (see {@link isDrumTrack}). For harmonic tracks, notes are filtered
 * through {@link harmonicNotes} to exclude channel 9 events. The dropped tracks
 * are returned separately so the UI can show what was excluded.
 */
export function harmonicTracksOnly<T extends TrackWithNotes>(
  items: ReadonlyArray<T>,
): { harmonic: T[]; excluded: T[] } {
  const harmonic: T[] = [];
  const excluded: T[] = [];
  for (const item of items) {
    if (isDrumTrack(item.track, item.notes)) {
      excluded.push(item);
    } else {
      const filtered = harmonicNotes(item.track, item.notes);
      harmonic.push({ ...item, notes: filtered } as T);
    }
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
