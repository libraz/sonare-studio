/**
 * Clip edits that run *inside* an existing atomic transaction.
 *
 * The public commands (splitClip, trimClip, …) each open their own history
 * entry. Commands that restructure several clips at once — ripple edits,
 * transient slicing — need the same native calls plus the app-metadata repair
 * that follows them, but as steps of one undoable operation. These helpers
 * take the transaction's `edit` callback and never push history themselves.
 */

import { remapClipScoreAnnotations } from '../annotations';
import { clipSplitBlockReason, LOOP_CLIP_SPLIT_ERROR } from '../clip-split';
import { getProject, useProjectStore } from '../store';
import { normalizeTempoMap } from '../tempo-map';
import { clearProjectClipWarp, installProjectClipWarp } from '../warp';
import type { AtomicProjectEdit } from './history';
import { pruneClipScoreAnnotations } from './tracks';
import { requireEditableClip, withDerivedClipMetadata } from './utils';

/** Reinstalls derived app metadata after a native clip split. */
export function splitClipWithin(edit: AtomicProjectEdit, clipId: number, splitPpq: number): number {
  const store = useProjectStore();
  const project = getProject();
  const source = requireEditableClip(store, clipId);
  const blocked = clipSplitBlockReason(source, splitPpq);
  if (blocked === 'loop') throw new Error(LOOP_CLIP_SPLIT_ERROR);
  if (blocked === 'position') {
    throw new RangeError(`Split position ${splitPpq} must lie strictly inside clip ${clipId}`);
  }
  const sourceMeta = { ...source };
  const sourceAnnotations = store.scoreAnnotations[clipId];
  // The engine refuses to split or trim a clip bound to a warp map; each side is reinstalled below.
  clearProjectClipWarp(project, clipId, (mutation) => edit(1, mutation));
  const rightId = edit(1, () => project.splitClip(clipId, splitPpq));
  store.refresh();
  const splitOffsetPpq = splitPpq - source.startPpq;
  store.clips = store.clips.map((clip) => {
    if (clip.id === clipId) {
      return withDerivedClipMetadata(clip, sourceMeta, {
        windowStartPpq: 0,
        windowLengthPpq: clip.lengthPpq,
      });
    }
    if (clip.id === rightId) {
      return withDerivedClipMetadata({ ...clip, name: source.name }, sourceMeta, {
        windowStartPpq: splitOffsetPpq,
        windowLengthPpq: clip.lengthPpq,
      });
    }
    return clip;
  });
  const annotations = { ...store.scoreAnnotations };
  delete annotations[clipId];
  for (const id of [clipId, rightId]) {
    const derived = store.clips.find((clip) => clip.id === id);
    if (derived === undefined) continue;
    const mapped = remapClipScoreAnnotations(sourceAnnotations, source.notes, derived.notes);
    if (Object.keys(mapped).length > 0) annotations[id] = mapped;
  }
  store.scoreAnnotations = annotations;
  const tempo = normalizeTempoMap(store.tempoSegments, store.tempoBpm);
  for (const id of [clipId, rightId]) {
    const derived = store.clips.find((clip) => clip.id === id);
    if (derived?.warp !== undefined) {
      installProjectClipWarp(project, derived, tempo, (mutation) => edit(1, mutation));
    }
  }
  return rightId;
}

/**
 * Trims a clip and preserves its app metadata.
 *
 * @param allowGrow True to accept a window reaching past the current one (the
 * caller vouches that the source material exists); otherwise the new window
 * must stay inside the old one.
 */
export function trimClipWithin(
  edit: AtomicProjectEdit,
  clipId: number,
  newStartPpq: number,
  newLengthPpq: number,
  allowGrow = false,
): void {
  const store = useProjectStore();
  const project = getProject();
  const source = requireEditableClip(store, clipId);
  if (
    !allowGrow &&
    (!(newStartPpq >= source.startPpq) ||
      !(newStartPpq + newLengthPpq <= source.startPpq + source.lengthPpq))
  ) {
    throw new RangeError(`Timeline trim must remain inside clip ${clipId}`);
  }
  const sourceMeta = { ...source };
  clearProjectClipWarp(project, clipId, (mutation) => edit(1, mutation));
  edit(1, () => project.trimClip(clipId, newStartPpq, newLengthPpq));
  store.refresh();
  store.clips = store.clips.map((clip) =>
    clip.id === clipId
      ? withDerivedClipMetadata(clip, sourceMeta, {
          windowStartPpq: newStartPpq - source.startPpq,
          windowLengthPpq: clip.lengthPpq,
        })
      : clip,
  );
  const trimmed = store.clips.find((clip) => clip.id === clipId);
  if (trimmed?.warp !== undefined) {
    installProjectClipWarp(
      project,
      trimmed,
      normalizeTempoMap(store.tempoSegments, store.tempoBpm),
      (mutation) => edit(1, mutation),
    );
  }
}

/** Moves a clip start, optionally to another track; app metadata is position-independent. */
export function moveClipWithin(
  edit: AtomicProjectEdit,
  clipId: number,
  newStartPpq: number,
  newTrackId?: number,
): void {
  const project = getProject();
  edit(1, () => {
    if (newTrackId === undefined) project.moveClip(clipId, newStartPpq);
    else project.moveClip(clipId, newStartPpq, newTrackId);
  });
}

/** Removes a clip, first releasing any native warp map it owns. */
export function removeClipWithin(edit: AtomicProjectEdit, clipId: number): void {
  const store = useProjectStore();
  const project = getProject();
  clearProjectClipWarp(project, clipId, (mutation) => edit(1, mutation));
  edit(1, () => project.removeClip(clipId));
  pruneClipScoreAnnotations(store, [clipId]);
}
