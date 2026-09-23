/**
 * Accompaniment lead following: which notes of an accompaniment track step
 * aside for the melody it follows, and which parked notes come back.
 *
 * A plan is recomputed from scratch over the union of the track's current
 * notes and its stash, so applying it and planning again changes nothing.
 * Whether a note thins is decided by `thinsAccompaniment`, the predicate the
 * placement column reports from, so the column and the thinning agree.
 * Frozen tracks are left alone and looping clips are never thinned.
 *
 * Pure module (no Vue/Pinia).
 */

import type { ChordTimeline } from '@libraz/libcantus';
import type { KeyMap } from '@/compose/key-map';
import { strongBeatAt } from '@/compose/meter';
import { type ThinningEnv, thinsAccompaniment } from '@/compose/placement';
import { harmonicNotes, isDrumTrack } from '@/compose/tracks';
import type { VoiceContext } from '@/compose/voice-context';
import { audibleMidiProjector } from './midi-projection';
import {
  clipKind,
  type EditorClip,
  type EditorNote,
  type EditorTrack,
  type LeadFollowStashEntry,
  type TimeSignatureSegment,
} from './types';

/** Inputs of {@link leadFollowPlan}. */
export interface LeadFollowPlanInput {
  /** The following track (its `leadFollow.stash` included) and its clips. */
  follower: { track: EditorTrack; clips: ReadonlyArray<EditorClip> };
  /** Lead notes on the absolute timeline, loops expanded, see {@link leadFollowNotes}. */
  leadNotes: ReadonlyArray<EditorNote>;
  /** Every track, the follower with its parked notes, for the texture's lowest pitch. */
  voices: VoiceContext;
  chords: ChordTimeline;
  keyMap: KeyMap;
  timeSignatures: ReadonlyArray<TimeSignatureSegment>;
}

/** One follower clip's complete new note list, in source coordinates. */
export interface LeadFollowClipEdit {
  clipId: number;
  /** Restored notes carry negative placeholder ids for the mirror to replace. */
  notes: EditorNote[];
}

/** Clip rewrites plus the follower's complete new stash. */
export interface LeadFollowPlan {
  clipEdits: LeadFollowClipEdit[];
  stash: LeadFollowStashEntry[];
}

/** A clip note or a parked note of the follower. */
interface Candidate {
  note: Omit<EditorNote, 'id'>;
  current?: EditorNote;
  entry?: LeadFollowStashEntry;
}

/** A note span on the absolute timeline. */
interface TimedPitch {
  pitch: number;
  startPpq: number;
  durationPpq: number;
}

/**
 * The lead track's notes as lead following reads them: every audible
 * occurrence on the absolute timeline, channel-10 notes dropped, and nothing
 * at all for a percussion track.
 */
export function leadFollowNotes(
  track: EditorTrack,
  clips: ReadonlyArray<EditorClip>,
): EditorNote[] {
  const notes = clips
    .filter((clip) => clip.trackId === track.id && clipKind(clip) === 'midi')
    .flatMap((clip) =>
      audibleMidiProjector(clip, { expandLoops: true }).map((occurrence) => ({
        ...occurrence.note,
        startPpq: occurrence.timelineStartPpq,
        durationPpq: occurrence.durationPpq,
      })),
    );
  if (isDrumTrack(track, notes)) return [];
  return [...harmonicNotes(track, notes)];
}

function overlapsSamePitch(
  notes: ReadonlyArray<EditorNote>,
  note: Omit<EditorNote, 'id'>,
): boolean {
  return notes.some(
    (other) =>
      other.pitch === note.pitch &&
      other.startPpq < note.startPpq + note.durationPpq &&
      note.startPpq < other.startPpq + other.durationPpq,
  );
}

function withoutId(note: EditorNote): Omit<EditorNote, 'id'> {
  const { id: _id, ...rest } = note;
  return rest;
}

/**
 * Splits the follower into kept, parked and restored notes. `thinsFor` gets
 * every span the follower sounds (loops expanded) and answers per note span.
 */
function planFollower(
  track: EditorTrack,
  clips: ReadonlyArray<EditorClip>,
  thinsFor: (sounding: ReadonlyArray<TimedPitch>) => (span: TimedPitch) => boolean,
): LeadFollowPlan {
  const ownClips = clips.filter((clip) => clip.trackId === track.id && clipKind(clip) === 'midi');
  const byClip = new Map<number, Candidate[]>(
    ownClips.map((clip) => [clip.id, clip.notes.map((note) => ({ note, current: note }))]),
  );
  // Parked notes of a clip that no longer exists are dropped here.
  for (const entry of track.leadFollow?.stash ?? []) {
    byClip.get(entry.clipId)?.push({ note: entry.note, entry });
  }

  const spans = new Map<Candidate, TimedPitch>();
  const sounding: TimedPitch[] = [];
  for (const clip of ownClips) {
    const candidates = byClip.get(clip.id) ?? [];
    const byNote = new Map(candidates.map((candidate) => [candidate.note, candidate]));
    const projected = audibleMidiProjector(
      { ...clip, notes: candidates.map((candidate) => candidate.note) },
      { expandLoops: true },
    );
    for (const occurrence of projected) {
      const span = {
        pitch: occurrence.note.pitch,
        startPpq: occurrence.timelineStartPpq,
        durationPpq: occurrence.durationPpq,
      };
      sounding.push(span);
      const candidate = byNote.get(occurrence.note);
      if (!clip.loopEnabled && candidate !== undefined) spans.set(candidate, span);
    }
  }
  const thins = thinsFor(sounding);
  const thinned = (candidate: Candidate): boolean => {
    const span = spans.get(candidate);
    return span !== undefined && thins(span);
  };

  const clipEdits: LeadFollowClipEdit[] = [];
  const stash: LeadFollowStashEntry[] = [];
  let placeholderId = -1;
  for (const clip of ownClips) {
    const candidates = byClip.get(clip.id) ?? [];
    const notes: EditorNote[] = [];
    let changed = false;
    for (const candidate of candidates) {
      if (candidate.current === undefined) continue;
      if (thinned(candidate)) {
        stash.push({ clipId: clip.id, note: withoutId(candidate.current) });
        changed = true;
      } else {
        notes.push(candidate.current);
      }
    }
    for (const candidate of candidates) {
      if (candidate.entry === undefined) continue;
      if (thinned(candidate) || overlapsSamePitch(notes, candidate.note)) {
        stash.push(candidate.entry);
        continue;
      }
      notes.push({ ...candidate.note, id: placeholderId-- });
      changed = true;
    }
    if (changed) {
      clipEdits.push({ clipId: clip.id, notes: notes.sort((a, b) => a.startPpq - b.startPpq) });
    }
  }
  return { clipEdits, stash };
}

/**
 * Plans the follower against its lead: a note is parked when any lead note
 * thins it, and a parked note returns once none does, unless a note of the
 * same pitch now overlaps where it would return.
 */
export function leadFollowPlan(input: LeadFollowPlanInput): LeadFollowPlan {
  const { track, clips } = input.follower;
  if (track.frozen !== undefined) {
    return { clipEdits: [], stash: [...(track.leadFollow?.stash ?? [])] };
  }
  return planFollower(track, clips, (sounding) => {
    const env: ThinningEnv = {
      chordAt: (ppq) => input.chords.at(ppq),
      sounding: input.voices,
      // The anchor is the lowest note of the whole voicing, parked notes included.
      anchors: (ppq) => {
        let lowest = Number.POSITIVE_INFINITY;
        for (const span of sounding) {
          if (span.startPpq <= ppq && span.startPpq + span.durationPpq > ppq) {
            lowest = Math.min(lowest, span.pitch);
          }
        }
        return new Set(Number.isFinite(lowest) ? [lowest] : []);
      },
      strongBeatAt: (ppq) => strongBeatAt(input.timeSignatures, ppq),
      key: input.keyMap,
    };
    return (span) => input.leadNotes.some((lead) => thinsAccompaniment(span, lead, env));
  });
}

/**
 * Returns every parked note to its clip, for a follow that is being removed.
 * A note whose place a same-pitch note now overlaps stays in the returned stash.
 */
export function restoreLeadFollowStash(follower: {
  track: EditorTrack;
  clips: ReadonlyArray<EditorClip>;
}): LeadFollowPlan {
  return planFollower(follower.track, follower.clips, () => () => false);
}
