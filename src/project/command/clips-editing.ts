import { getProject, useProjectStore } from '../store';
import { execute } from './history';
import { requireClip, requireTrack, validatePpq, withDerivedClipMetadata } from './utils';

// ---------------------------------------------------------------------------
// Clip structural-editing commands
// ---------------------------------------------------------------------------

/**
 * Removes a clip as one undoable edit. When the active clip is removed, the
 * first remaining clip of the active track becomes active.
 *
 * @param clipId Id of the clip to remove.
 */
export function deleteClip(clipId: number): void {
  const store = useProjectStore();
  const project = getProject();
  requireClip(store, clipId);
  execute(1, () => {
    project.removeClip(clipId);
    if (store.clipId === clipId) store.clipId = -1;
    store.refresh();
  });
}

/**
 * Renames a clip as one undoable edit. Clip names are app-level metadata
 * (the Project has no clip-name API), so only the mirror changes.
 *
 * @param clipId Id of the clip.
 * @param name New display name (non-empty).
 */
export function renameClip(clipId: number, name: string): void {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if (name.length === 0) throw new RangeError('Clip name must not be empty');
  if (clip.name === name) return;
  execute(0, () => {
    store.clips = store.clips.map((c) => (c.id === clipId ? { ...c, name } : c));
    store.refresh();
  });
}

/**
 * Moves a clip to a new timeline start (and optionally another track) as one
 * undoable edit (delegates to Project.moveClip).
 *
 * @param clipId Id of the clip to move.
 * @param newStartPpq New timeline start in PPQ (>= 0).
 * @param newTrackId Optional destination track id.
 */
export function moveClip(clipId: number, newStartPpq: number, newTrackId?: number): void {
  const store = useProjectStore();
  const project = getProject();
  requireClip(store, clipId);
  validatePpq(newStartPpq, 'Clip startPpq');
  if (newTrackId !== undefined) requireTrack(store, newTrackId);
  execute(1, () => {
    if (newTrackId === undefined) project.moveClip(clipId, newStartPpq);
    else project.moveClip(clipId, newStartPpq, newTrackId);
    store.refresh();
  });
}

/**
 * Duplicates a clip at a new timeline start on the same track as one undoable
 * edit (delegates to Project.duplicateClip; MIDI content is copied by the
 * Project). The copy inherits the source clip's display name.
 *
 * @param clipId Id of the clip to duplicate.
 * @param newStartPpq Timeline start of the copy in PPQ (>= 0).
 * @returns The stable clip id of the copy.
 */
export function duplicateClip(clipId: number, newStartPpq: number): number {
  const store = useProjectStore();
  const project = getProject();
  const source = requireClip(store, clipId);
  validatePpq(newStartPpq, 'Clip startPpq');
  const name = source.name;
  const sourceMeta = { ...source };
  return execute(1, () => {
    const copyId = project.duplicateClip(clipId, newStartPpq);
    store.refresh();
    store.clips = store.clips.map((c) =>
      c.id === copyId ? withDerivedClipMetadata({ ...c, name }, sourceMeta) : c,
    );
    return copyId;
  });
}

/**
 * Splits a clip at a timeline position as one undoable edit (delegates to
 * Project.splitClip; the Project partitions MIDI content and source offsets).
 * The right half inherits the source clip's display name.
 *
 * @param clipId Id of the clip to split.
 * @param splitPpq Timeline split position, strictly inside the clip.
 * @returns The stable clip id of the right half.
 */
export function splitClip(clipId: number, splitPpq: number): number {
  const store = useProjectStore();
  const project = getProject();
  const source = requireClip(store, clipId);
  if (
    !Number.isFinite(splitPpq) ||
    splitPpq <= source.startPpq ||
    splitPpq >= source.startPpq + source.lengthPpq
  ) {
    const end = source.startPpq + source.lengthPpq;
    throw new RangeError(
      `Split position ${splitPpq} must lie strictly inside the clip [${source.startPpq}, ${end}]`,
    );
  }
  const name = source.name;
  const sourceMeta = { ...source };
  return execute(1, () => {
    const rightId = project.splitClip(clipId, splitPpq);
    store.refresh();
    const splitOffsetPpq = splitPpq - source.startPpq;
    store.clips = store.clips.map((c) => {
      if (c.id === clipId) {
        return withDerivedClipMetadata(c, sourceMeta, {
          windowStartPpq: 0,
          windowLengthPpq: c.lengthPpq,
        });
      }
      if (c.id === rightId) {
        return withDerivedClipMetadata({ ...c, name }, sourceMeta, {
          windowStartPpq: splitOffsetPpq,
          windowLengthPpq: c.lengthPpq,
        });
      }
      return c;
    });
    return rightId;
  });
}

/**
 * Trims a clip's timeline start and length as one undoable edit (delegates to
 * Project.trimClip; the Project adjusts the source offset accordingly).
 *
 * @param clipId Id of the clip to trim.
 * @param newStartPpq New timeline start in PPQ (>= 0).
 * @param newLengthPpq New length in PPQ (> 0).
 */
export function trimClip(clipId: number, newStartPpq: number, newLengthPpq: number): void {
  const store = useProjectStore();
  const project = getProject();
  const source = requireClip(store, clipId);
  validatePpq(newStartPpq, 'Clip startPpq');
  if (!Number.isFinite(newLengthPpq) || newLengthPpq <= 0) {
    throw new RangeError(`Clip lengthPpq must be finite and > 0, got ${newLengthPpq}`);
  }
  const sourceMeta = { ...source };
  execute(1, () => {
    project.trimClip(clipId, newStartPpq, newLengthPpq);
    store.refresh();
    const windowStartPpq = newStartPpq - source.startPpq;
    store.clips = store.clips.map((c) =>
      c.id === clipId
        ? withDerivedClipMetadata(c, sourceMeta, {
            windowStartPpq,
            windowLengthPpq: c.lengthPpq,
          })
        : c,
    );
  });
}
