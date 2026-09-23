/**
 * Voice context shared by every surface that reads a candidate pitch against
 * the other parts: the notes each other track sounds, its outer voices and
 * their motion, the active part's own line, and the spelling a melodic-leap
 * check needs.
 *
 * Other tracks are kept as separate lines (never pooled) so each one's motion
 * can be followed across time. A line answers with every pitch it sounds for
 * vertical checks, and with its top and bottom voices for motion checks.
 *
 * Pure module (no Vue/Pinia).
 */

import {
  createsHiddenParallelPerfect,
  createsParallelPerfect,
  type KeyScale,
  type NoteData,
  type SpellingContext,
  spelledKeyOf,
  spellPitch,
} from '@libraz/libcantus';
import { audibleMidiProjector } from '@/project/midi-projection';
import { meterBarLengthPpq, timeSignatureAt } from '@/project/time-signature';
import type { EditorClip, EditorNote, EditorTrack, TimeSignatureSegment } from '@/project/types';
import { harmonicTracksOnly } from './tracks';

/**
 * Consecutive slots of unbroken constant perfect separation at which two voices
 * read as one doubled line rather than as two lines falling into a parallel.
 *
 * Over the demo organ toccata every flagged note sits either in a run of at most
 * two slots or in one of seven or more, so any value from three to seven splits
 * the two populations the same way.
 */
export const DOUBLING_RUN_SLOTS = 4;

/** How a line takes part in the texture. */
export type VoiceRole = 'melodic' | 'bass' | 'accompaniment';

/** One other track's notes on the absolute timeline (PPQ), with its role. */
export interface VoiceLine {
  trackId: number;
  role: VoiceRole;
  notes: ReadonlyArray<EditorNote>;
}

/** One pitch sounding at a queried beat. */
export interface SoundingPitch {
  pitch: number;
  trackId: number;
  role: VoiceRole;
  /** Absolute onset of the note carrying the pitch. */
  startPpq: number;
  /** Length of the note carrying the pitch. */
  durationPpq: number;
}

/** A line's top or bottom voice at a beat, with its pitch at the previous beat. */
export interface OuterVoice {
  trackId: number;
  edge: 'top' | 'bottom';
  pitch: number;
  prevPitch?: number;
}

/** Sounding pitches and outer voices of the other lines, by absolute beat. */
export interface VoiceContext {
  /** Every pitch of every line sounding at `absBeat`. */
  soundingAt(absBeat: number): SoundingPitch[];
  /**
   * Each sounding line's top voice and, when different, its bottom voice. The
   * previous pitch is the same edge at `prevBeat`, omitted when `prevBeat` lies
   * more than a bar back.
   */
  outerVoicesAt(absBeat: number, prevBeat: number | undefined): OuterVoice[];
}

/** One step of the active part's own line, newest first (see {@link voiceChain}). */
export interface VoiceChainEntry {
  beat: number;
  pitch: number;
  endBeat: number;
}

/** Voice-leading events the candidate creates against the other voices. */
export interface MotionFindings {
  /** Voices the candidate moves into a parallel perfect interval with. */
  parallelPerfect: OuterVoice[];
  /** A hidden fifth or octave between the outer voices of the texture. */
  hiddenOuter: boolean;
  /** Voices whose order against the candidate swapped since the previous beat. */
  crossing: OuterVoice[];
}

function roleOfTrack(track: EditorTrack): VoiceRole {
  if (track.generated?.part === 'backing') return 'accompaniment';
  if (track.leadFollow !== undefined) return 'accompaniment';
  if (track.generated?.part === 'bass') return 'bass';
  return 'melodic';
}

/**
 * Builds one line per non-percussion track other than `excludeTrackId`: its
 * clips projected to absolute PPQ with loops expanded, channel-10 notes dropped,
 * and a role attached. Projected notes get unique negative ids per track so they
 * cannot collide with the active clip's note ids.
 */
export function buildVoiceLines(
  tracks: ReadonlyArray<EditorTrack>,
  clipsByTrack: ReadonlyMap<number, ReadonlyArray<EditorClip>>,
  excludeTrackId: number,
): VoiceLine[] {
  const items = tracks
    .filter((track) => track.id !== excludeTrackId)
    .map((track) => {
      let syntheticId = -1;
      const notes = (clipsByTrack.get(track.id) ?? []).flatMap((clip) =>
        audibleMidiProjector(clip, { expandLoops: true }).map((entry) => ({
          ...entry.note,
          startPpq: entry.timelineStartPpq,
          durationPpq: entry.durationPpq,
          sourceIdentity: entry.sourceIdentity,
          id: syntheticId--,
        })),
      );
      return { track, notes };
    });
  return harmonicTracksOnly(items)
    .harmonic.filter((item) => item.notes.length > 0)
    .map((item) => ({ trackId: item.track.id, role: roleOfTrack(item.track), notes: item.notes }));
}

/** A line's sounding notes at one beat, plus its outer pitches. */
interface LineSnapshot {
  notes: EditorNote[];
  top: number;
  bottom: number;
}

function snapshotOf(notes: EditorNote[]): LineSnapshot | undefined {
  if (notes.length === 0) return undefined;
  let top = notes[0].pitch;
  let bottom = top;
  for (const note of notes) {
    top = Math.max(top, note.pitch);
    bottom = Math.min(bottom, note.pitch);
  }
  return { notes, top, bottom };
}

function isMidiPitch(pitch: number): boolean {
  return pitch >= 0 && pitch < 128;
}

/**
 * Indexes the lines at `queryBeats` in one start/end sweep per line; beats
 * outside that set are answered by a scan of the line.
 */
export function buildVoiceContext(
  lines: ReadonlyArray<VoiceLine>,
  queryBeats: ReadonlyArray<number>,
  timeSignatures: ReadonlyArray<TimeSignatureSegment>,
): VoiceContext {
  const beats = [...new Set(queryBeats)].sort((a, b) => a - b);
  const playable = lines.map((line) => line.notes.filter((note) => isMidiPitch(note.pitch)));
  const indexes = playable.map((notes) => {
    const starts = [...notes].sort((a, b) => a.startPpq - b.startPpq);
    const ends = [...notes].sort(
      (a, b) => a.startPpq + a.durationPpq - (b.startPpq + b.durationPpq),
    );
    const active = new Set<EditorNote>();
    const byBeat = new Map<number, LineSnapshot | undefined>();
    let startIndex = 0;
    let endIndex = 0;
    for (const beat of beats) {
      while (startIndex < starts.length && starts[startIndex].startPpq <= beat) {
        active.add(starts[startIndex++]);
      }
      while (
        endIndex < ends.length &&
        ends[endIndex].startPpq + ends[endIndex].durationPpq <= beat
      ) {
        active.delete(ends[endIndex++]);
      }
      byBeat.set(beat, snapshotOf([...active]));
    }
    return byBeat;
  });
  const lineAt = (index: number, beat: number): LineSnapshot | undefined => {
    const byBeat = indexes[index];
    if (byBeat.has(beat)) return byBeat.get(beat);
    return snapshotOf(
      playable[index].filter(
        (note) => note.startPpq <= beat && note.startPpq + note.durationPpq > beat,
      ),
    );
  };

  return {
    soundingAt(absBeat) {
      const out: SoundingPitch[] = [];
      lines.forEach((line, index) => {
        for (const note of lineAt(index, absBeat)?.notes ?? []) {
          out.push({
            pitch: note.pitch,
            trackId: line.trackId,
            role: line.role,
            startPpq: note.startPpq,
            durationPpq: note.durationPpq,
          });
        }
      });
      return out;
    },
    outerVoicesAt(absBeat, prevBeat) {
      const bar = meterBarLengthPpq(timeSignatureAt(timeSignatures, absBeat));
      const withPrev = prevBeat !== undefined && absBeat - prevBeat <= bar;
      const out: OuterVoice[] = [];
      lines.forEach((line, index) => {
        const now = lineAt(index, absBeat);
        if (now === undefined) return;
        const before = withPrev ? lineAt(index, prevBeat) : undefined;
        const top: OuterVoice = { trackId: line.trackId, edge: 'top', pitch: now.top };
        if (before !== undefined) top.prevPitch = before.top;
        out.push(top);
        if (now.bottom === now.top) return;
        const bottom: OuterVoice = { trackId: line.trackId, edge: 'bottom', pitch: now.bottom };
        if (before !== undefined) bottom.prevPitch = before.bottom;
        out.push(bottom);
      });
      return out;
    },
  };
}

/**
 * The active part's own line leading into a candidate, newest first: walking
 * the onset groups before `beat`, the first step takes the pitch nearest the
 * candidate and each later step the pitch nearest the one chosen after it (ties
 * go to the lower pitch). A group more than a bar before the step after it ends
 * the chain, as does reaching `depth` steps.
 */
export function voiceChain(
  activeNotes: ReadonlyArray<EditorNote>,
  pitch: number,
  beat: number,
  depth: number,
  timeSignatures: ReadonlyArray<TimeSignatureSegment>,
): VoiceChainEntry[] {
  // Each step spans at most one bar, so nothing earlier than `depth` of the
  // longest bar in force can be reached.
  const longestBar = timeSignatures.reduce(
    (longest, segment) => Math.max(longest, meterBarLengthPpq(segment)),
    meterBarLengthPpq(timeSignatureAt(timeSignatures, beat)),
  );
  const earliest = beat - depth * longestBar;
  const groups = new Map<number, EditorNote[]>();
  for (const note of activeNotes) {
    if (note.startPpq >= beat || note.startPpq < earliest) continue;
    const group = groups.get(note.startPpq);
    if (group === undefined) groups.set(note.startPpq, [note]);
    else group.push(note);
  }
  const onsets = [...groups.keys()].sort((a, b) => b - a);
  const chain: VoiceChainEntry[] = [];
  let target = pitch;
  let after = beat;
  for (const onset of onsets) {
    if (chain.length >= depth) break;
    if (after - onset > meterBarLengthPpq(timeSignatureAt(timeSignatures, after))) break;
    let best: EditorNote | undefined;
    for (const note of groups.get(onset) ?? []) {
      if (best === undefined) {
        best = note;
        continue;
      }
      const distance = Math.abs(note.pitch - target);
      const bestDistance = Math.abs(best.pitch - target);
      if (
        distance < bestDistance ||
        (distance === bestDistance && note.pitch < best.pitch) ||
        (note.pitch === best.pitch && note.durationPpq > best.durationPpq)
      ) {
        best = note;
      }
    }
    if (best === undefined) break;
    chain.push({ beat: onset, pitch: best.pitch, endBeat: onset + best.durationPpq });
    target = best.pitch;
    after = onset;
  }
  return chain;
}

/**
 * Whether a parallel fifth or octave the library found against `other` is heard
 * as one: the two voices move the same way, and the pair is not continuing a
 * doubling run of at least `DOUBLING_RUN_SLOTS - 1` earlier slots.
 */
export function parallelIsHeard(
  candidate: number,
  prevPitch: number,
  other: { pitch: number; prevPitch: number },
  earlierDoublingSlots: number,
): boolean {
  return (
    candidate > prevPitch === other.pitch > other.prevPitch &&
    earlierDoublingSlots < DOUBLING_RUN_SLOTS - 1
  );
}

/**
 * Reads the candidate's motion from `prevPitch` against each other voice that
 * has a previous pitch.
 *
 * - Parallels come from the library predicate, minus pairs moving in contrary
 *   directions (it matches octave classes, so a double octave collapsing to a
 *   single one qualifies) and pairs continuing a doubling run of at least
 *   `DOUBLING_RUN_SLOTS - 1` earlier slots.
 * - A hidden fifth or octave counts only when the candidate and the voice are
 *   the texture's highest and lowest; inner-part direct motion is accepted.
 * - Crossing is a strict swap of order; a unison on either beat is not one.
 */
export function motionFindings(
  candidate: number,
  prevPitch: number | undefined,
  others: ReadonlyArray<OuterVoice>,
  doublingRunOf: (other: OuterVoice) => number,
): MotionFindings {
  const findings: MotionFindings = { parallelPerfect: [], hiddenOuter: false, crossing: [] };
  if (prevPitch === undefined) return findings;
  let lowest = candidate;
  let highest = candidate;
  for (const other of others) {
    lowest = Math.min(lowest, other.pitch);
    highest = Math.max(highest, other.pitch);
  }
  for (const other of others) {
    const otherPrev = other.prevPitch;
    if (otherPrev === undefined) continue;
    if (
      createsParallelPerfect(prevPitch, candidate, otherPrev, other.pitch) &&
      parallelIsHeard(
        candidate,
        prevPitch,
        { pitch: other.pitch, prevPitch: otherPrev },
        doublingRunOf(other),
      )
    ) {
      findings.parallelPerfect.push(other);
    }
    if (createsHiddenParallelPerfect(prevPitch, candidate, otherPrev, other.pitch)) {
      const isOuter =
        (candidate === highest && other.pitch === lowest) ||
        (candidate === lowest && other.pitch === highest);
      if (isOuter) findings.hiddenOuter = true;
    }
    if (Math.sign(prevPitch - otherPrev) * Math.sign(candidate - other.pitch) < 0) {
      findings.crossing.push(other);
    }
  }
  return findings;
}

/**
 * How many chain steps back, not counting the candidate's own beat, the same
 * track and edge held the candidate's perfect separation from it. Zero when that
 * separation is not a perfect unison, octave or fifth class.
 */
export function doublingRunOf(
  chain: ReadonlyArray<VoiceChainEntry>,
  ctx: VoiceContext,
  candidate: number,
  beat: number,
): (other: OuterVoice) => number {
  const outersByBeat = new Map<number, OuterVoice[]>();
  const outersAt = (at: number): OuterVoice[] => {
    let outers = outersByBeat.get(at);
    if (outers === undefined) {
      outers = ctx.outerVoicesAt(at, undefined);
      outersByBeat.set(at, outers);
    }
    return outers;
  };
  return (other) => {
    const separation = candidate - other.pitch;
    const pc = ((separation % 12) + 12) % 12;
    if (pc !== 0 && pc !== 7) return 0;
    let run = 0;
    for (const step of chain) {
      if (step.beat >= beat) continue;
      const match = outersAt(step.beat).find(
        (voice) => voice.trackId === other.trackId && voice.edge === other.edge,
      );
      if (match === undefined || step.pitch - match.pitch !== separation) break;
      run += 1;
    }
    return run;
  };
}

/**
 * A speller counting intervals from the key's tonic, the reading the melodic
 * predicates ask about. An engraving spelling (chromatic tones on the key
 * signature's side) would write D minor's C# as Db and invent diminished
 * fourths. Returns undefined where the library rejects the input.
 */
export function keySpeller(
  key: KeyScale,
): (pitch: number, context?: SpellingContext) => NoteData | undefined {
  let tonic: ReturnType<typeof spelledKeyOf>['tonic'] | undefined;
  try {
    tonic = spelledKeyOf(key).tonic;
  } catch {
    tonic = undefined;
  }
  return (pitch, context) => {
    if (tonic === undefined) return undefined;
    try {
      return spellPitch(pitch, tonic, key, context);
    } catch {
      return undefined;
    }
  };
}

/**
 * Spells a melodic step for `isForbiddenMelodicLeap`, which needs letters: an
 * augmented second and a minor third share a MIDI distance. Each note is spelled
 * in the key with the other as its neighbour.
 */
export function spellForLeapCheck(
  prev: number,
  candidate: number,
  key: KeyScale,
): [NoteData, NoteData] | undefined {
  const spell = keySpeller(key);
  const prevSpelled = spell(prev, { next: candidate });
  const candidateSpelled = spell(candidate, { previous: prev });
  if (prevSpelled === undefined || candidateSpelled === undefined) return undefined;
  return [prevSpelled, candidateSpelled];
}
