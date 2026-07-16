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
 * Project.setClipFade). Pass undefined or 0 to clear a fade. Playback applies
 * fades to audio clips only (src/project/scheduling.ts multiplies the buffer
 * edges); the prerendered MIDI path ignores them.
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
  store.activeTrackId = clip.trackId;
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
  }
  store.clipId = -1;
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
export function setActiveTrack(trackId: number): void {
  const store = useProjectStore();
  requireTrack(store, trackId);
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
