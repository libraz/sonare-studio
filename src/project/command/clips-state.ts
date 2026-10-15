import { planClipCrossfade } from '../clip-crossfade';
import { validateClipFadePair } from '../clip-fades';
import { getProject, useProjectStore } from '../store';
import { normalizeTempoMap } from '../tempo-map';
import type { ClipWarp } from '../types';
import {
  clearProjectClipWarp,
  hasInstalledProjectClipWarp,
  hasProjectClipWarpState,
  installProjectClipWarp,
  sanitizeClipWarp,
} from '../warp';
import { trimClipWithin } from './clips-internal';
import { execute, executeAtomic } from './history';
import { requireClip, requireEditableClip, requireTrack } from './utils';

// ---------------------------------------------------------------------------
// Clip/track state commands
// ---------------------------------------------------------------------------

/**
 * Sets (or clears with null) a track's frozen state as one undoable edit.
 * App-metadata only: playback and exports skip the frozen track's own
 * content/strip DSP and play the baked asset instead (see
 * src/project/freeze.ts for the render that produces it).
 *
 * @param trackId Id of the track.
 * @param frozen Baked render reference, or null to unfreeze.
 */
export function setTrackFrozen(trackId: number, frozen: { assetId: string } | null): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  if (track.kind === 'group') {
    throw new RangeError('Group tracks cannot be frozen (they have no own content)');
  }
  if (frozen !== null && (typeof frozen.assetId !== 'string' || frozen.assetId.length === 0)) {
    throw new RangeError('Frozen assetId must not be empty');
  }
  if ((track.frozen?.assetId ?? null) === (frozen?.assetId ?? null)) return;
  execute(0, () => {
    store.tracks = store.tracks.map((entry) => {
      if (entry.id !== trackId) return entry;
      const next = { ...entry };
      if (frozen === null) delete next.frozen;
      else next.frozen = { assetId: frozen.assetId };
      return next;
    });
    store.refresh();
  });
}

/**
 * Sets (or clears with null) the tempo-follow (warp) state of an audio clip
 * as one undoable edit. Anchors are sanitized (sorted, strictly inside the
 * clip window, strictly increasing source times). The same canonical state is
 * mirrored into libsonare's clip-owned warp map while the audible renderer
 * continues to re-bake through the schedule watcher.
 *
 * @param clipId Id of the audio clip.
 * @param warp New warp state, or null to play at the recorded rate.
 */
export function setClipWarp(clipId: number, warp: ClipWarp | null): void {
  const store = useProjectStore();
  const project = getProject();
  const clip = requireEditableClip(store, clipId);
  const index = store.clips.findIndex((entry) => entry.id === clipId);
  if ((clip.kind ?? 'midi') !== 'audio') {
    throw new RangeError(`Clip ${clipId} is not an audio clip`);
  }
  let next: ClipWarp | undefined;
  if (warp !== null) {
    next = sanitizeClipWarp(warp, clip.lengthPpq);
  }
  if (JSON.stringify(clip.warp) === JSON.stringify(next)) {
    if (next === undefined && !hasProjectClipWarpState(project, clipId)) return;
    if (next !== undefined && hasInstalledProjectClipWarp(project, clipId)) return;
  }
  const tempo = normalizeTempoMap(store.tempoSegments, store.tempoBpm);
  executeAtomic((edit) => {
    if (next === undefined) {
      clearProjectClipWarp(project, clipId, (mutation) => edit(1, mutation));
    } else {
      installProjectClipWarp(project, { ...clip, warp: next, id: clipId }, tempo, (mutation) =>
        edit(1, mutation),
      );
    }
    store.clips = store.clips.map((entry, i) => {
      if (i !== index) return entry;
      const updated = { ...entry };
      if (next === undefined) delete updated.warp;
      else updated.warp = next;
      return updated;
    });
    store.refresh();
  });
}

/**
 * Sets a clip's loop mode and loop length as one undoable edit (delegates to
 * Project.setClipLoop).
 *
 * @param clipId Id of the clip.
 * @param loopEnabled True to loop the clip window.
 * @param loopLengthPpq Loop length in PPQ (> 0); defaults to the clip length.
 */
export function setClipLoop(clipId: number, loopEnabled: boolean, loopLengthPpq?: number): void {
  const store = useProjectStore();
  const project = getProject();
  const clip = requireEditableClip(store, clipId);
  if (loopLengthPpq !== undefined && (!Number.isFinite(loopLengthPpq) || loopLengthPpq <= 0)) {
    throw new RangeError(`Loop length must be finite and > 0, got ${loopLengthPpq}`);
  }
  execute(1, () => {
    if (loopEnabled) project.setClipLoop(clipId, 'loop', loopLengthPpq ?? clip.lengthPpq);
    else project.setClipLoop(clipId, 'off');
    store.refresh();
  });
}

/**
 * Sets a clip's linear playback gain as one undoable edit (delegates to
 * Project.setClipGain).
 *
 * @param clipId Id of the clip.
 * @param gain New linear gain (finite, >= 0).
 */
export function setClipGain(clipId: number, gain: number): void {
  const store = useProjectStore();
  const project = getProject();
  requireEditableClip(store, clipId);
  if (!Number.isFinite(gain) || gain < 0) {
    throw new RangeError(`Clip gain must be finite and >= 0, got ${gain}`);
  }
  execute(1, () => {
    project.setClipGain(clipId, gain);
    store.refresh();
  });
}

/**
 * Sets a clip's fade-in/fade-out lengths as one undoable edit (delegates to
 * Project.setClipFade). Pass undefined or 0 to clear a fade. Audio clips get the
 * fades from buffer-edge gain (src/project/scheduling.ts); MIDI clips get them
 * from src/engine/midi-sync.ts.
 *
 * @param clipId Id of the clip.
 * @param fadeInPpq Fade-in length in PPQ (finite, >= 0; 0/undefined = none).
 * @param fadeOutPpq Fade-out length in PPQ (finite, >= 0; 0/undefined = none).
 */
export function setClipFades(clipId: number, fadeInPpq?: number, fadeOutPpq?: number): void {
  const store = useProjectStore();
  const project = getProject();
  const clip = requireEditableClip(store, clipId);
  for (const [value, label] of [
    [fadeInPpq, 'Clip fadeInPpq'],
    [fadeOutPpq, 'Clip fadeOutPpq'],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new RangeError(`${label} must be finite and >= 0, got ${value}`);
    }
  }
  const fadeIn = fadeInPpq ?? 0;
  const fadeOut = fadeOutPpq ?? 0;
  validateClipFadePair(fadeIn, fadeOut, clip.lengthPpq);
  execute(1, () => {
    project.setClipFade(clipId, { lengthPpq: fadeIn }, { lengthPpq: fadeOut });
    store.refresh();
    // Mirror fallback for bindings that do not serialize fades in toJson():
    // pin the values we just set (0 clears the field).
    store.clips = store.clips.map((c) => {
      if (c.id !== clipId) return c;
      const { fadeInPpq: _oldIn, fadeOutPpq: _oldOut, ...rest } = c;
      return {
        ...rest,
        ...(fadeIn > 0 ? { fadeInPpq: fadeIn } : {}),
        ...(fadeOut > 0 ? { fadeOutPpq: fadeOut } : {}),
      };
    });
  });
}

/**
 * Crossfades two neighbouring audio clips as one undoable edit: the earlier
 * clip fades out and the later one fades in over the region where both sound.
 * Clips that only touch are extended into their remaining source material when
 * the caller supplies where that material ends.
 *
 * @param clipIdA One clip of the pair (order does not matter).
 * @param clipIdB The other clip.
 * @param options.lengthPpq Crossfade length used when the clips only touch.
 * @param options.leftSourceEndPpq Timeline position where the earlier clip's
 * source material ends; without it a touching pair cannot be crossfaded.
 * @returns The applied crossfade length in PPQ.
 * @throws RangeError when the pair cannot be crossfaded (the message carries
 * the reason from src/project/clip-crossfade.ts).
 */
export function crossfadeClips(
  clipIdA: number,
  clipIdB: number,
  options: { lengthPpq?: number; leftSourceEndPpq?: number } = {},
): number {
  const store = useProjectStore();
  const project = getProject();
  const a = requireEditableClip(store, clipIdA);
  const b = requireEditableClip(store, clipIdB);
  const plan = planClipCrossfade(a, b, options);
  if ('reason' in plan) {
    throw new RangeError(`Clips ${clipIdA} and ${clipIdB} cannot be crossfaded: ${plan.reason}`);
  }
  const left = plan.leftClipId === a.id ? a : b;
  const right = plan.rightClipId === a.id ? a : b;
  const leftFadeIn = left.fadeInPpq ?? 0;
  const rightFadeOut = right.fadeOutPpq ?? 0;
  validateClipFadePair(leftFadeIn, plan.lengthPpq, plan.leftLengthPpq);
  validateClipFadePair(plan.lengthPpq, rightFadeOut, right.lengthPpq);
  executeAtomic((edit) => {
    if (Math.abs(plan.leftLengthPpq - left.lengthPpq) > 1e-9) {
      // A crossfade of touching clips creates an intentional overlap. The
      // native project otherwise rejects the extension under its default
      // disallow policy. Keep the policy change in the same Undo step.
      if (project.getOverlapPolicy() === 0) {
        edit(1, () => project.setOverlapPolicy(1));
      }
      trimClipWithin(edit, left.id, left.startPpq, plan.leftLengthPpq, true);
    }
    edit(1, () =>
      project.setClipFade(left.id, { lengthPpq: leftFadeIn }, { lengthPpq: plan.lengthPpq }),
    );
    edit(1, () =>
      project.setClipFade(right.id, { lengthPpq: plan.lengthPpq }, { lengthPpq: rightFadeOut }),
    );
    store.refresh();
    // Mirror fallback for bindings that do not serialize fades in toJson().
    store.clips = store.clips.map((clip) => {
      if (clip.id !== left.id && clip.id !== right.id) return clip;
      const { fadeInPpq: _in, fadeOutPpq: _out, ...rest } = clip;
      const fadeIn = clip.id === left.id ? leftFadeIn : plan.lengthPpq;
      const fadeOut = clip.id === left.id ? plan.lengthPpq : rightFadeOut;
      return {
        ...rest,
        ...(fadeIn > 0 ? { fadeInPpq: fadeIn } : {}),
        ...(fadeOut > 0 ? { fadeOutPpq: fadeOut } : {}),
      };
    });
  });
  return plan.lengthPpq;
}

/**
 * Makes a clip the active piano-roll clip. Editor-only state: not undoable.
 * The active track follows the clip and the note selection is cleared.
 *
 * @param clipId Id of the clip to activate.
 */
export function setActiveClip(clipId: number): void {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if (store.clipId === clipId) return;
  store.clipId = clipId;
  store.clipSelection = new Set([clipId]);
  store.activeTrackId = clip.trackId;
  store.trackSelection = new Set([clip.trackId]);
  store.selection = new Set();
  store.refresh();
}

/** Sets the arrangement selection without creating an undo-history entry. */
export function setClipSelection(clipIds: Iterable<number>, activeClipId?: number): void {
  const store = useProjectStore();
  const ids = new Set(clipIds);
  for (const id of ids) requireClip(store, id);
  const active = activeClipId ?? (ids.size === 0 ? -1 : [...ids][ids.size - 1]);
  if (active !== -1 && !ids.has(active))
    throw new RangeError(`Active clip ${active} is not selected`);
  store.clipSelection = ids;
  if (active === -1) {
    clearActiveClipSelection();
    return;
  }
  const clip = requireClip(store, active);
  store.clipId = active;
  store.activeTrackId = clip.trackId;
  store.trackSelection = new Set([clip.trackId]);
  store.selection = new Set();
  store.refresh();
}

/**
 * Clears the active clip without changing project content. Empty arrangement
 * clicks use this editor-only state transition so the visible selection and
 * subsequent Delete target cannot disagree. The clicked lane may optionally
 * become the active track while the piano roll/score remain clip-less.
 *
 * @param trackId Optional track id under the empty click.
 */
export function clearActiveClipSelection(trackId?: number): void {
  const store = useProjectStore();
  if (trackId !== undefined) {
    requireTrack(store, trackId);
    store.activeTrackId = trackId;
    store.trackSelection = new Set([trackId]);
  }
  store.clipId = -1;
  store.clipSelection = new Set();
  store.clipStartPpq = 0;
  store.clipLengthPpq = 0;
  store.notes = [];
  store.selection = new Set();
}

/**
 * Makes a track the active track. Editor-only state: not undoable. The first
 * clip of the track (by timeline position) becomes the active clip, or no
 * clip when the track is empty.
 *
 * @param trackId Id of the track to activate.
 */
function activateTrack(store: ReturnType<typeof useProjectStore>, trackId: number): void {
  // Anchor the new active clip to the outgoing clip's timeline window rather
  // than always taking the track's first clip. Switching tracks during playback
  // otherwise strands the score/piano-roll on a clip that does not contain the
  // playhead, so the score highlight has nothing to follow and stalls. Prefer
  // the earliest clip on the new track that overlaps the current window; fall
  // back to the track's first clip when none overlaps (or nothing was active).
  const anchorStart = store.clipStartPpq;
  const anchorEnd = anchorStart + store.clipLengthPpq;
  const candidates = store.clips
    .filter((clip) => clip.trackId === trackId)
    .sort((a, b) => a.startPpq - b.startPpq);
  const overlapping =
    store.clipId >= 0
      ? candidates.find(
          (clip) => clip.startPpq < anchorEnd && clip.startPpq + clip.lengthPpq > anchorStart,
        )
      : undefined;
  store.activeTrackId = trackId;
  store.clipId = (overlapping ?? candidates[0])?.id ?? -1;
  store.selection = new Set();
  store.refresh();
}

/**
 * Selects arrangement tracks without creating an undo entry. The active track
 * remains the piano-roll target while every selected track is available to
 * header bulk operations.
 */
export function setTrackSelection(trackIds: Iterable<number>, activeTrackId?: number): void {
  const store = useProjectStore();
  const ids = new Set(trackIds);
  for (const id of ids) requireTrack(store, id);
  const active = activeTrackId ?? (ids.size === 0 ? -1 : [...ids][ids.size - 1]);
  if (active !== -1 && !ids.has(active)) {
    throw new RangeError(`Active track ${active} is not selected`);
  }
  store.trackSelection = ids;
  if (active !== -1) activateTrack(store, active);
}

export function setActiveTrack(trackId: number): void {
  const store = useProjectStore();
  requireTrack(store, trackId);
  store.trackSelection = new Set([trackId]);
  activateTrack(store, trackId);
}
