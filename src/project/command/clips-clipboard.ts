import { shallowRef } from 'vue';
import { audioAssetUri } from '@/persistence/assets';
import { type ClipScoreAnnotations, remapClipScoreAnnotations } from '../annotations';
import {
  getAudioSourceId,
  getProject,
  notesToProjectEvents,
  placeholderSourceAudio,
  setAudioSourceId,
  useProjectStore,
} from '../store';
import { normalizeTempoMap } from '../tempo-map';
import { canTrackContainClip, clipKind, type EditorClip } from '../types';
import { installProjectClipWarp } from '../warp';
import { clipsCollidingWith } from './clip-lane';
import { deleteClip } from './clips-editing';
import { shapeClipWithin } from './clips-internal';
import { executeAtomic } from './history';
import { requireEditableTrack, validatePpq } from './utils';

/** Detached, process-local arrangement clipboard. Audio media is referenced, never copied. */
interface ClipClipboard {
  clip: EditorClip;
  scoreAnnotations?: ClipScoreAnnotations;
}

let clipClipboard: ClipClipboard | null = null;

/** Invalidates menu models when the process-local arrangement clipboard changes. */
export const clipClipboardVersion = shallowRef(0);

function detachedClip(clip: EditorClip): EditorClip {
  return structuredClone(clip);
}

/** Copies the active arrangement clip and its display-only score annotations. */
export function copyActiveClip(): boolean {
  const store = useProjectStore();
  const clip = store.activeClip;
  if (clip === null) return false;
  const annotations = store.scoreAnnotations[clip.id];
  clipClipboard = {
    clip: detachedClip(clip),
    ...(annotations === undefined ? {} : { scoreAnnotations: structuredClone(annotations) }),
  };
  clipClipboardVersion.value += 1;
  return true;
}

/** Returns whether an arrangement clip is currently available to paste. */
export function hasCopiedClip(): boolean {
  return clipClipboard !== null;
}

/**
 * Returns whether the copied clip can be pasted into a track at a timeline
 * position. This mirrors the command's compatibility and editability guards
 * so menu surfaces can disable an action before it throws.
 */
export function canPasteClipAt(trackId: number, startPpq = 0): boolean {
  if (
    clipClipboard === null ||
    !Number.isFinite(startPpq) ||
    startPpq < 0 ||
    !Number.isFinite(clipClipboard.clip.lengthPpq) ||
    clipClipboard.clip.lengthPpq <= 0
  ) {
    return false;
  }
  const store = useProjectStore();
  const destination = store.tracks.find((track) => track.id === trackId);
  if (
    destination === undefined ||
    destination.frozen !== undefined ||
    !canTrackContainClip(destination.kind, clipKind(clipClipboard.clip))
  ) {
    return false;
  }
  if (clipKind(clipClipboard.clip) === 'audio' && !clipClipboard.clip.assetId) return false;
  const endPpq = startPpq + clipClipboard.clip.lengthPpq;
  if (!Number.isFinite(endPpq)) return false;
  return (
    clipsCollidingWith(store.clips, trackId, startPpq, clipClipboard.clip.lengthPpq).length === 0
  );
}

/** Copies the active clip before removing it, so it can be pasted elsewhere. */
export function cutActiveClip(): boolean {
  const store = useProjectStore();
  const clipId = store.clipId;
  if (!copyActiveClip() || clipId < 0) return false;
  deleteClip(clipId);
  return true;
}

/**
 * Pastes the copied clip at a timeline PPQ position on a destination track.
 * Audio copies retain their asset and take references; their PCM is not
 * duplicated. Returns the newly allocated clip id, or null when there is no
 * compatible clipboard/destination.
 */
export function pasteClipAt(trackId: number, startPpq: number): number | null {
  if (!canPasteClipAt(trackId, startPpq) || clipClipboard === null) return null;
  const store = useProjectStore();
  const project = getProject();
  const source = detachedClip(clipClipboard.clip);
  const destination = requireEditableTrack(store, trackId);
  const kind = clipKind(source);
  if (!canTrackContainClip(destination.kind, kind)) return null;
  validatePpq(startPpq, 'Clip startPpq');

  return executeAtomic((edit) => {
    const placement = {
      trackId,
      startPpq,
      lengthPpq: source.lengthPpq,
      sourceOffsetPpq: source.sourceOffsetPpq,
      gain: source.gain,
    };
    const newClipId =
      kind === 'midi'
        ? edit(1, () => project.addClip({ ...placement, isMidi: true }))
        : (() => {
            const assetId = source.assetId;
            if (assetId === undefined || assetId.length === 0) {
              throw new RangeError('Copied audio clip has no asset reference');
            }
            const knownSourceId = getAudioSourceId(assetId);
            const sourceId =
              knownSourceId !== undefined &&
              knownSourceId >= 1 &&
              knownSourceId <= project.sourceCount()
                ? knownSourceId
                : undefined;
            const id = edit(1, () =>
              project.addClip({
                ...placement,
                isMidi: false,
                ...placeholderSourceAudio(),
                ...(sourceId === undefined ? { sourceUri: audioAssetUri(assetId) } : {}),
              }),
            );
            if (sourceId === undefined) setAudioSourceId(assetId, project.sourceCount());
            else edit(1, () => project.setClipSource(id, sourceId));
            return id;
          })();
    shapeClipWithin(edit, newClipId, source);
    if (kind === 'midi') {
      edit(1, () => project.setMidiEvents(newClipId, notesToProjectEvents(source.notes)));
    } else if (source.warp !== undefined) {
      const { trackId: _sourceTrackId, ...warpClip } = source;
      installProjectClipWarp(
        project,
        { ...warpClip, id: newClipId, startPpq },
        normalizeTempoMap(store.tempoSegments, store.tempoBpm),
        (mutation) => edit(1, mutation),
      );
    }

    // Seed every app-level field, then recover native note ids from Project.
    store.clips = [...store.clips, { ...source, id: newClipId, trackId, startPpq, notes: [] }];
    store.refresh();
    const copied = store.clips.find((clip) => clip.id === newClipId);
    if (kind === 'midi' && copied !== undefined && clipClipboard?.scoreAnnotations !== undefined) {
      const annotations = remapClipScoreAnnotations(
        clipClipboard.scoreAnnotations,
        source.notes,
        copied.notes,
      );
      if (Object.keys(annotations).length > 0) {
        store.scoreAnnotations = { ...store.scoreAnnotations, [newClipId]: annotations };
      }
    }
    store.activeTrackId = trackId;
    store.clipId = newClipId;
    store.selection = new Set();
    return newClipId;
  });
}
