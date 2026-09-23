/**
 * Accompaniment lead following: the per-track follow setting, and the
 * post-edit reconciler that re-thins every following track in the same
 * history entry as the edit that changed its melody, the chords or the meter.
 *
 * The reconciler reacts only to the lead track's clips, the chord track, the
 * meter, follow settings and the lead track's existence; editing only the
 * accompaniment leaves it alone. When thinning would push the entry past the
 * undo budget, or a write fails, the edit still lands and only the follow is
 * deferred (`store.leadFollowDeferred`).
 */

import { buildChordTimeline } from '@/compose/chord-at-tick';
import { buildKeyMap } from '@/compose/key-map';
import { isDrumTrack } from '@/compose/tracks';
import { buildVoiceContext, buildVoiceLines } from '@/compose/voice-context';
import {
  type LeadFollowPlan,
  leadFollowNotes,
  leadFollowPlan,
  restoreLeadFollowStash,
} from '../lead-follow';
import { midiSourcePpqToTimeline } from '../midi-projection';
import {
  getProject,
  notesToProjectEvents,
  PROJECT_MAX_UNDO_DEPTH,
  useProjectStore,
} from '../store';
import type { EditorClip, EditorTrack, LeadFollow } from '../types';
import {
  execute,
  executeAtomic,
  type PostEditContext,
  type PostEditSnapshot,
  registerPostEditReconciler,
} from './history';
import { requireEditableTrack, requireTrack } from './utils';

type ProjectStore = ReturnType<typeof useProjectStore>;

/** Track id no track carries, so {@link buildVoiceLines} keeps every track. */
const NO_TRACK_ID = -1;

function notesOfTrack(store: ProjectStore, trackId: number) {
  return (store.clipsByTrack.get(trackId) ?? []).flatMap((clip) => clip.notes);
}

/**
 * Why `trackId` may not follow `leadTrackId`, or null when it may. A track
 * cannot follow itself, percussion neither follows nor leads, and following
 * is one level deep: a lead cannot follow, and a followed track cannot follow.
 */
export function leadFollowRejection(
  store: ProjectStore,
  trackId: number,
  leadTrackId: number,
): string | null {
  if (trackId === leadTrackId) return 'a track cannot follow itself';
  const track = store.tracks.find((entry) => entry.id === trackId);
  const lead = store.tracks.find((entry) => entry.id === leadTrackId);
  if (track === undefined || lead === undefined) return 'unknown track';
  if (
    isDrumTrack(track, notesOfTrack(store, trackId)) ||
    isDrumTrack(lead, notesOfTrack(store, leadTrackId))
  ) {
    return 'percussion tracks neither follow nor lead';
  }
  if (lead.leadFollow !== undefined) return 'the lead track follows another track';
  if (store.tracks.some((entry) => entry.leadFollow?.leadTrackId === trackId)) {
    return 'another track follows this track';
  }
  return null;
}

/** Replaces the `leadFollow` of the given tracks; undefined removes it. */
function withLeadFollows(
  tracks: ReadonlyArray<EditorTrack>,
  follows: ReadonlyMap<number, LeadFollow | undefined>,
): EditorTrack[] {
  return tracks.map((track) => {
    if (!follows.has(track.id)) return track;
    const next = { ...track };
    const follow = follows.get(track.id);
    if (follow === undefined) delete next.leadFollow;
    else next.leadFollow = follow;
    return next;
  });
}

/** Id hints for rewritten clips; restored notes get fresh ids from the mirror. */
function clipHints(plan: ReadonlyArray<LeadFollowPlan['clipEdits'][number]>) {
  return new Map(
    plan.map((edit) => [edit.clipId, edit.notes.filter((note) => note.id >= 0)] as const),
  );
}

/**
 * Makes a track follow a melody track, or stops it following (one undoable
 * edit). Enabling thins at once through the reconciler; disabling returns
 * every parked note to its clip.
 *
 * @param trackId The accompaniment track.
 * @param leadTrackId The melody track to follow, or null to stop following.
 * @throws {RangeError} When the pair is rejected (see {@link leadFollowRejection}).
 */
export function setTrackLeadFollow(trackId: number, leadTrackId: number | null): void {
  const store = useProjectStore();
  const track = requireEditableTrack(store, trackId);
  if (leadTrackId === null) {
    if (track.leadFollow === undefined) return;
    const restored = restoreLeadFollowStash({
      track,
      clips: store.clipsByTrack.get(trackId) ?? [],
    });
    const project = getProject();
    executeAtomic((edit) => {
      for (const clipEdit of restored.clipEdits) {
        edit(1, () => project.setMidiEvents(clipEdit.clipId, notesToProjectEvents(clipEdit.notes)));
      }
      store.tracks = withLeadFollows(store.tracks, new Map([[trackId, undefined]]));
      store.refresh(clipHints(restored.clipEdits));
    });
    return;
  }
  if (track.leadFollow?.leadTrackId === leadTrackId) return;
  requireTrack(store, leadTrackId);
  const rejection = leadFollowRejection(store, trackId, leadTrackId);
  if (rejection !== null) {
    throw new RangeError(`Track ${trackId} cannot follow track ${leadTrackId}: ${rejection}`);
  }
  // Switching leads keeps the stash: the reconciler returns what the new lead does not thin.
  const follow: LeadFollow = { leadTrackId, stash: [...(track.leadFollow?.stash ?? [])] };
  execute(0, () => {
    store.tracks = withLeadFollows(store.tracks, new Map([[trackId, follow]]));
    store.refresh();
  });
}

function sameLeadFollow(a: LeadFollow | undefined, b: LeadFollow | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Clip fields the lead's notes depend on; snapshots share them when unchanged. */
const LEAD_CLIP_FIELDS = [
  'id',
  'kind',
  'startPpq',
  'lengthPpq',
  'sourceOffsetPpq',
  'loopEnabled',
  'loopLengthPpq',
  'notes',
] as const;

function sameClips(a: ReadonlyArray<EditorClip>, b: ReadonlyArray<EditorClip>): boolean {
  return (
    a.length === b.length &&
    a.every((clip, index) => LEAD_CLIP_FIELDS.every((field) => clip[field] === b[index][field]))
  );
}

/**
 * Whether an edit touched anything following reacts to. Unchanged snapshot
 * entries share objects, so the lead's clip fields and the chord track compare
 * by reference.
 */
function followInputsChanged(before: PostEditSnapshot, after: PostEditSnapshot): boolean {
  const leadIds = new Set<number>();
  for (const track of [...before.tracks, ...after.tracks]) {
    if (track.leadFollow !== undefined) leadIds.add(track.leadFollow.leadTrackId);
  }
  if (leadIds.size === 0) return false;
  if (before.chords !== after.chords || before.timeSignatures !== after.timeSignatures) return true;
  const beforeTracks = new Map(before.tracks.map((track) => [track.id, track]));
  for (const track of after.tracks) {
    const previous = beforeTracks.get(track.id);
    if (previous !== track && !sameLeadFollow(previous?.leadFollow, track.leadFollow)) return true;
  }
  const afterIds = new Set(after.tracks.map((track) => track.id));
  for (const id of leadIds) {
    if (beforeTracks.has(id) !== afterIds.has(id)) return true;
    const clipsBefore = before.clips.filter((clip) => clip.trackId === id);
    const clipsAfter = after.clips.filter((clip) => clip.trackId === id);
    if (!sameClips(clipsBefore, clipsAfter)) return true;
  }
  return false;
}

/** Clips by track with each follower's parked notes put back, for the texture's voices. */
function clipsWithStash(store: ProjectStore): Map<number, EditorClip[]> {
  const byTrack = new Map(store.clipsByTrack);
  for (const track of store.tracks) {
    const stash = track.leadFollow?.stash ?? [];
    if (stash.length === 0) continue;
    byTrack.set(
      track.id,
      (byTrack.get(track.id) ?? []).map((clip) => {
        const parked = stash.filter((entry) => entry.clipId === clip.id);
        if (parked.length === 0) return clip;
        return {
          ...clip,
          notes: [
            ...clip.notes,
            ...parked.map((entry, index) => ({ ...entry.note, id: -1 - index })),
          ],
        };
      }),
    );
  }
  return byTrack;
}

/** Re-thins every following track after a forward edit (see the module comment). */
function reconcileLeadFollow({
  before,
  after,
  store,
  projectEdits,
}: PostEditContext): number | undefined {
  if (!followInputsChanged(before, after)) return undefined;

  const withStash = clipsWithStash(store);
  const lines = buildVoiceLines(store.tracks, withStash, NO_TRACK_ID);
  const queryBeats = [...withStash.values()].flatMap((clips) =>
    clips.flatMap((clip) => clip.notes.map((note) => midiSourcePpqToTimeline(clip, note.startPpq))),
  );
  const voices = buildVoiceContext(lines, queryBeats, store.timeSignatures);
  const chords = buildChordTimeline(store.chords);
  const keyMap = buildKeyMap(store.scaleHighlight, store.markers);

  const plans: Array<{ trackId: number; plan: LeadFollowPlan; follow: LeadFollow | undefined }> =
    [];
  for (const track of store.tracks) {
    const follow = track.leadFollow;
    if (follow === undefined || track.frozen !== undefined) continue;
    const clips = store.clipsByTrack.get(track.id) ?? [];
    const lead = store.tracks.find((entry) => entry.id === follow.leadTrackId);
    if (lead === undefined) {
      plans.push({
        trackId: track.id,
        plan: restoreLeadFollowStash({ track, clips }),
        follow: undefined,
      });
      continue;
    }
    if (isDrumTrack(track, notesOfTrack(store, track.id))) continue;
    const plan = leadFollowPlan({
      follower: { track, clips },
      leadNotes: leadFollowNotes(lead, store.clipsByTrack.get(lead.id) ?? []),
      voices,
      chords,
      keyMap,
      timeSignatures: store.timeSignatures,
    });
    plans.push({
      trackId: track.id,
      plan,
      follow: { leadTrackId: follow.leadTrackId, stash: plan.stash },
    });
  }

  const clipEdits = plans.flatMap((entry) => entry.plan.clipEdits);
  const followChanged = plans.some(
    (entry) =>
      !sameLeadFollow(
        store.tracks.find((track) => track.id === entry.trackId)?.leadFollow,
        entry.follow,
      ),
  );
  if (clipEdits.length === 0 && !followChanged) {
    store.leadFollowDeferred = false;
    return undefined;
  }
  if (projectEdits + clipEdits.length > PROJECT_MAX_UNDO_DEPTH) {
    store.leadFollowDeferred = true;
    return undefined;
  }

  const project = getProject();
  const tracksBefore = store.tracks;
  let applied = 0;
  try {
    for (const clipEdit of clipEdits) {
      project.setMidiEvents(clipEdit.clipId, notesToProjectEvents(clipEdit.notes));
      applied += 1;
    }
    store.tracks = withLeadFollows(
      store.tracks,
      new Map(plans.map((entry) => [entry.trackId, entry.follow])),
    );
    store.refresh(clipHints(clipEdits));
  } catch {
    // Keep the user's edit: take back only what the follow wrote.
    for (let index = 0; index < applied; index++) project.undo();
    store.tracks = tracksBefore;
    store.refresh(new Map(after.clips.map((clip) => [clip.id, clip.notes])));
    store.leadFollowDeferred = true;
    return undefined;
  }
  store.leadFollowDeferred = false;
  return applied;
}

registerPostEditReconciler('lead-follow', reconcileLeadFollow);
