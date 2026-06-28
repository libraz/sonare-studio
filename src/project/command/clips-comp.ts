import { sanitizeCompSegments } from '../comping';
import { useProjectStore } from '../store';
import type { ClipCompSegment, ClipTake, EditorClip } from '../types';
import { execute } from './history';

// ---------------------------------------------------------------------------
// Clip comp / take commands
// ---------------------------------------------------------------------------

/** Returns the index of an audio clip with takes, or throws. */
function requireClipWithTakes(store: ReturnType<typeof useProjectStore>, clipId: number): number {
  const index = store.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new RangeError(`Unknown clip id ${clipId}`);
  const clip = store.clips[index];
  if ((clip.takes?.length ?? 0) === 0) {
    throw new RangeError(`Clip ${clipId} has no takes`);
  }
  return index;
}

/**
 * Replaces the comp selection of an audio clip with takes, as one undoable
 * edit. Segments are sanitized (sorted, clamped into the clip window, first
 * pulled to the clip start, same-take runs merged) and the clip's assetId is
 * kept on the take selected at the clip start. App-metadata only (no
 * Project edit): playback re-schedules from the mirror.
 *
 * @param clipId Id of the clip to re-comp.
 * @param segments New comp selection (at least one valid segment).
 */
export function setClipCompSegments(
  clipId: number,
  segments: ReadonlyArray<ClipCompSegment>,
): void {
  const store = useProjectStore();
  const index = requireClipWithTakes(store, clipId);
  const clip = store.clips[index];
  const takes = clip.takes as ClipTake[];
  const sanitized = sanitizeCompSegments(segments, takes.length, clip.lengthPpq);
  if (sanitized.length === 0) {
    throw new RangeError('Comp selection must keep at least one valid segment');
  }
  execute(0, () => {
    store.clips = store.clips.map((entry, i) =>
      i === index
        ? {
            ...entry,
            assetId: takes[sanitized[0].takeIndex].assetId,
            compSegments: sanitized,
          }
        : entry,
    );
    store.refresh();
  });
}

/**
 * Selects one take for the whole clip (a single-segment comp selection), as
 * one undoable edit.
 *
 * @param clipId Id of the clip.
 * @param takeIndex Index into the clip's takes list.
 */
export function setClipActiveTake(clipId: number, takeIndex: number): void {
  setClipCompSegments(clipId, [{ startPpq: 0, takeIndex }]);
}

/**
 * Replaces the takes list of an audio clip as one undoable edit. The comp
 * selection resets to the active take throughout and the clip's assetId is
 * rebased onto it. App-metadata only (no Project edit).
 *
 * @param clipId Id of the audio clip.
 * @param takes New takes (non-empty, each with a non-empty assetId).
 * @param activeTakeIndex Take selected for the whole clip (defaults to the last).
 */
export function setClipTakes(
  clipId: number,
  takes: ReadonlyArray<ClipTake>,
  activeTakeIndex?: number,
): void {
  const store = useProjectStore();
  const index = store.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new RangeError(`Unknown clip id ${clipId}`);
  const clip = store.clips[index];
  if ((clip.kind ?? 'midi') !== 'audio') {
    throw new RangeError(`Clip ${clipId} is not an audio clip`);
  }
  if (takes.length === 0) throw new RangeError('Takes must not be empty');
  for (const take of takes) {
    if (typeof take.assetId !== 'string' || take.assetId.length === 0) {
      throw new RangeError('Every take needs a non-empty assetId');
    }
  }
  const next = takes.map((take) => ({ assetId: take.assetId, name: take.name }));
  const active = activeTakeIndex ?? next.length - 1;
  if (!Number.isInteger(active) || active < 0 || active >= next.length) {
    throw new RangeError(`Active take index ${active} is out of range`);
  }
  execute(0, () => {
    store.clips = store.clips.map((entry, i) =>
      i === index
        ? {
            ...entry,
            assetId: next[active].assetId,
            takes: next,
            compSegments: [{ startPpq: 0, takeIndex: active }],
          }
        : entry,
    );
    store.refresh();
  });
}

/**
 * Drops the take lanes of a comped clip, turning it back into a normal audio
 * clip, as one undoable edit. Without a baked asset the comp selection must
 * be a single segment (the clip keeps that take's asset); with one — see
 * flattenClipComp (src/project/comp-flatten.ts), which stitches the comp
 * into a new asset first — the clip is rebased onto the baked asset. The
 * clip's source offset is owned by the wasm Project and stays unchanged, so
 * the baked asset must cover the clip's source window (flattenClipComp pads
 * it with leading silence up to the source offset).
 *
 * @param clipId Id of the clip to flatten.
 * @param bakedAssetId Asset holding the stitched comp at the clip's source window.
 */
export function dropClipTakes(clipId: number, bakedAssetId?: string): void {
  const store = useProjectStore();
  const index = requireClipWithTakes(store, clipId);
  const clip = store.clips[index];
  const selection = sanitizeCompSegments(
    clip.compSegments ?? [{ startPpq: 0, takeIndex: 0 }],
    (clip.takes as ClipTake[]).length,
    clip.lengthPpq,
  );
  if (bakedAssetId === undefined && selection.length > 1) {
    throw new RangeError(
      `Clip ${clipId} has a multi-segment comp; bake it before dropping its takes`,
    );
  }
  execute(0, () => {
    store.clips = store.clips.map((entry, i) => {
      if (i !== index) return entry;
      const next: EditorClip = { ...entry };
      if (bakedAssetId !== undefined) {
        next.assetId = bakedAssetId;
      }
      delete next.takes;
      delete next.compSegments;
      return next;
    });
    store.refresh();
  });
}
