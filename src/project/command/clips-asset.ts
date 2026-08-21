import { audioAssetUri } from '@/persistence/assets';
import {
  getAudioSourceId,
  getProject,
  placeholderSourceAudio,
  setAudioSourceId,
  useProjectStore,
} from '../store';
import { normalizeTempoMap } from '../tempo-map';
import { isAudioClip } from '../types';
import { clearProjectClipWarp, installProjectClipWarp } from '../warp';
import { executeAtomic } from './history';
import { parkClipForReplacement, requireEditableClip } from './utils';

/**
 * Replaces one audio clip's asset as a single failure-atomic command. The new
 * clip/source and all native loop/fade/warp state are established before the
 * old clip is removed. One undo restores the original clip and identity.
 */
export function replaceAudioClipAsset(clipId: number, assetId: string): number {
  const store = useProjectStore();
  const project = getProject();
  const clip = requireEditableClip(store, clipId);
  if (!isAudioClip(clip)) throw new RangeError(`Clip ${clipId} is not an audio clip`);
  if (typeof assetId !== 'string' || assetId.length === 0) {
    throw new RangeError('Replacement assetId must not be empty');
  }
  if (clip.assetId === assetId) return clipId;

  const known = getAudioSourceId(assetId);
  const sourceId =
    known !== undefined && known >= 1 && known <= project.sourceCount() ? known : undefined;
  const activeTakeIndex = clip.compSegments?.[0]?.takeIndex ?? 0;
  const takes = clip.takes?.map((take, index) => ({
    ...take,
    assetId: index === activeTakeIndex ? assetId : take.assetId,
  }));
  const compSegments = clip.compSegments?.map((segment) => ({ ...segment }));

  return executeAtomic((edit) => {
    // The replacement occupies the original's range, and a track holds no two
    // overlapping clips, so the original steps aside until it is dropped below.
    parkClipForReplacement(store, clip, (startPpq) =>
      edit(1, () => project.moveClip(clipId, startPpq)),
    );
    const newClipId = edit(2, () =>
      project.addClip({
        trackId: clip.trackId,
        isMidi: false,
        startPpq: clip.startPpq,
        lengthPpq: clip.lengthPpq,
        sourceOffsetPpq: clip.sourceOffsetPpq,
        gain: clip.gain,
        ...placeholderSourceAudio(),
        ...(sourceId === undefined ? { sourceUri: audioAssetUri(assetId) } : {}),
      }),
    );
    if (sourceId === undefined) setAudioSourceId(assetId, project.sourceCount());
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
    if (clip.loopEnabled) {
      edit(1, () => project.setClipLoop(newClipId, 'loop', clip.loopLengthPpq || clip.lengthPpq));
    }
    if (clip.warp !== undefined) {
      installProjectClipWarp(
        project,
        { ...clip, id: newClipId },
        normalizeTempoMap(store.tempoSegments, store.tempoBpm),
        (mutation) => edit(1, mutation),
      );
    }

    // Destructive step last: all replacement state is valid at this point.
    clearProjectClipWarp(project, clipId, (mutation) => edit(1, mutation));
    edit(1, () => project.removeClip(clipId));
    store.clips = store.clips.map((entry) =>
      entry.id === clipId
        ? {
            ...clip,
            id: newClipId,
            assetId,
            notes: [],
            ...(takes ? { takes, compSegments } : {}),
          }
        : entry,
    );
    if (store.clipId === clipId) store.clipId = newClipId;
    store.refresh();
    return newClipId;
  });
}
