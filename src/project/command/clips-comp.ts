import { audioAssetUri } from '@/persistence/assets';
import { sanitizeCompSegments } from '../comping';
import {
  getAudioSourceId,
  getProject,
  placeholderSourceAudio,
  setAudioSourceId,
  useProjectStore,
} from '../store';
import type { ClipCompSegment, ClipTake, EditorClip } from '../types';
import { clearProjectClipWarp } from '../warp';
import { execute, executeAtomic } from './history';
import { parkClipForReplacement, requireEditableClip } from './utils';

// ---------------------------------------------------------------------------
// Clip comp / take commands
// ---------------------------------------------------------------------------

/** Returns the index of an audio clip with takes, or throws. */
function requireClipWithTakes(store: ReturnType<typeof useProjectStore>, clipId: number): number {
  const index = store.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new RangeError(`Unknown clip id ${clipId}`);
  const clip = requireEditableClip(store, clipId);
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
  const clip = requireEditableClip(store, clipId);
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
 * baked asset is exactly the audible clip window, so the clip is rebased to
 * source offset 0 rather than baking leading silence for the original offset.
 * Looping and warp are reset when rebasing; outer clip fades remain metadata
 * because flattenClipComp deliberately does not bake them.
 *
 * @param clipId Id of the clip to flatten.
 * @param bakedAssetId Asset holding the stitched comp at the clip's source window.
 */
export function dropClipTakes(clipId: number, bakedAssetId?: string): void {
  dropClipTakesBatch([{ clipId, ...(bakedAssetId !== undefined ? { bakedAssetId } : {}) }]);
}

/** One clip in a track-level flatten commit. */
export interface DropClipTakesInput {
  clipId: number;
  /** Stitched asset for a multi-segment comp; omitted for a single selected take. */
  bakedAssetId?: string;
}

/**
 * Drops several clips' take lanes in one prevalidated undo transaction.
 * No mirror field is changed until every clip and baked-asset requirement is
 * valid, which is the synchronous commit half of track-level comp flattening.
 */
export function dropClipTakesBatch(inputs: ReadonlyArray<DropClipTakesInput>): void {
  if (inputs.length === 0) return;
  const store = useProjectStore();
  const project = getProject();
  const seen = new Set<number>();
  const replacements = new Map<number, string | undefined>();
  for (const input of inputs) {
    if (seen.has(input.clipId)) throw new RangeError(`Duplicate clip id ${input.clipId}`);
    seen.add(input.clipId);
    const index = requireClipWithTakes(store, input.clipId);
    const clip = store.clips[index];
    const selection = sanitizeCompSegments(
      clip.compSegments ?? [{ startPpq: 0, takeIndex: 0 }],
      (clip.takes as ClipTake[]).length,
      clip.lengthPpq,
    );
    if (input.bakedAssetId === undefined && selection.length > 1) {
      throw new RangeError(
        `Clip ${input.clipId} has a multi-segment comp; bake it before dropping its takes`,
      );
    }
    if (input.bakedAssetId !== undefined && input.bakedAssetId.length === 0) {
      throw new RangeError(`Clip ${input.clipId} baked asset id must not be empty`);
    }
    replacements.set(input.clipId, input.bakedAssetId);
  }
  // Old clip id -> rebased clip id for baked clips. The native source offset
  // has no setter, so rebasing to offset 0 means recreating the clip over the
  // baked asset (which is exactly the audible window) and dropping the old one.
  const rebased = new Map<number, number>();
  executeAtomic((edit) => {
    for (const input of inputs) {
      const bakedAssetId = replacements.get(input.clipId);
      if (bakedAssetId === undefined) continue;
      const clip = store.clips.find((entry) => entry.id === input.clipId);
      if (!clip) continue;
      const known = getAudioSourceId(bakedAssetId);
      const sourceId =
        known !== undefined && known >= 1 && known <= project.sourceCount() ? known : undefined;
      // The rebased clip occupies the original's range, and a track holds no
      // two overlapping clips, so the original steps aside until it is dropped.
      parkClipForReplacement(store, clip, (startPpq) =>
        edit(1, () => project.moveClip(input.clipId, startPpq)),
      );
      const newClipId = edit(2, () =>
        project.addClip({
          trackId: clip.trackId,
          isMidi: false,
          startPpq: clip.startPpq,
          lengthPpq: clip.lengthPpq,
          sourceOffsetPpq: 0,
          gain: clip.gain,
          ...placeholderSourceAudio(),
          ...(sourceId === undefined ? { sourceUri: audioAssetUri(bakedAssetId) } : {}),
        }),
      );
      if (sourceId === undefined) setAudioSourceId(bakedAssetId, project.sourceCount());
      else edit(1, () => project.setClipSource(newClipId, sourceId));
      if ((clip.fadeInPpq ?? 0) > 0 || (clip.fadeOutPpq ?? 0) > 0) {
        edit(1, () =>
          project.setClipFade(
            newClipId,
            { lengthPpq: clip.fadeInPpq ?? 0 },
            { lengthPpq: clip.fadeOutPpq ?? 0 },
          ),
        );
      }
      // Destructive step last: the replacement clip is fully valid by now.
      if (clip.warp !== undefined) {
        clearProjectClipWarp(project, input.clipId, (mutation) => edit(1, mutation));
      }
      edit(1, () => project.removeClip(input.clipId));
      rebased.set(input.clipId, newClipId);
    }
    store.clips = store.clips.map((entry) => {
      if (!replacements.has(entry.id)) return entry;
      const bakedAssetId = replacements.get(entry.id);
      const newId = rebased.get(entry.id);
      const next: EditorClip = { ...entry, ...(newId !== undefined ? { id: newId } : {}) };
      if (bakedAssetId !== undefined) {
        next.assetId = bakedAssetId;
        // The baked asset is exactly the audible clip window, so the clip is
        // rebased to source offset 0 rather than prepending leading silence.
        next.sourceOffsetPpq = 0;
        next.loopEnabled = false;
        next.loopLengthPpq = 0;
        delete next.warp;
      }
      delete next.takes;
      delete next.compSegments;
      return next;
    });
    for (const [oldId, newId] of rebased) {
      if (store.clipId === oldId) store.clipId = newId;
    }
    store.refresh();
  });
}
