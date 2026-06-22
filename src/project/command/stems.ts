import { ensureWasm } from '@/lib/wasm';
import { type AudioAssetMeta, audioAssetUri, loadAsset, saveAsset } from '@/persistence/assets';
import {
  type AudioStemSeparator,
  type SeparatedStem,
  separateAudioClipStems,
} from '../audio-stems';
import {
  getAudioSourceId,
  getProject,
  placeholderSourceAudio,
  setAudioSourceId,
  useProjectStore,
} from '../store';
import { clipKind, TRACK_COLOR_PALETTE } from '../types';
import { execute } from './history';
import { requireClip } from './utils';

/**
 * Splits an audio clip into harmonic / percussive / residual stems, each laid
 * down on a new audio track aligned under the source clip, as one undoable
 * edit.
 *
 * The clip's played source window is separated with libsonare's
 * `hpssWithResidual` (delegated; see {@link separateAudioClipStems}); each band
 * is stored as a new audio asset and placed as a clip at the source clip's
 * start with its length and gain. The async work (separation and asset stores)
 * runs first; the tracks, asset sources and clips are then created inside a
 * single `execute`, so undo reverts the whole split at once.
 *
 * @param clipId Id of the audio clip to split.
 * @returns The new clip ids (one per stem, in band order), or [] when stem
 *   separation is unavailable or the clip has no audible window.
 * @throws RangeError when the clip is not an audio clip.
 */
export async function splitAudioClipToStems(clipId: number): Promise<number[]> {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if (clipKind(clip) !== 'audio') {
    throw new RangeError(`Clip ${clipId} is not an audio clip`);
  }
  const wasm = (await ensureWasm()) as unknown as { hpssWithResidual?: AudioStemSeparator };
  if (typeof wasm.hpssWithResidual !== 'function') return [];
  const stems = await separateAudioClipStems(clip, store.tempoBpm, {
    loadAudioAsset: loadAsset,
    separateStems: wasm.hpssWithResidual,
  });
  if (stems.length === 0) return [];

  // Store each band as an asset before touching the Project (async work first).
  const baseName = clip.name;
  const saved: { stem: SeparatedStem; meta: AudioAssetMeta }[] = [];
  for (const stem of stems) {
    const meta = await saveAsset(
      { name: `${baseName} ${stem.kind}`, sampleRate: stem.sampleRate },
      stem.channels,
    );
    saved.push({ stem, meta });
  }

  const project = getProject();
  const startPpq = clip.startPpq;
  const lengthPpq = clip.lengthPpq;
  const gain = clip.gain;
  // Each stem asset is freshly stored and distinct, so its source state is
  // resolved up front: an unregistered source is registered by addClip (two
  // Project edits), an already-known one is rebound with setClipSource (three).
  // addTrack adds one edit per stem on top.
  const sourceCount = project.sourceCount();
  const plans = saved.map(({ stem, meta }) => {
    const known = getAudioSourceId(meta.id);
    const sourceId = known !== undefined && known >= 1 && known <= sourceCount ? known : undefined;
    return { stem, meta, sourceId };
  });
  const projectEdits = plans.reduce(
    (sum, plan) => sum + 1 + (plan.sourceId === undefined ? 2 : 3),
    0,
  );

  return execute(projectEdits, () => {
    const newClipIds: number[] = [];
    for (const { stem, meta, sourceId } of plans) {
      const name = `${baseName} ${stem.kind}`;
      const color = TRACK_COLOR_PALETTE[store.tracks.length % TRACK_COLOR_PALETTE.length];
      const trackId = project.addTrack({ kind: 'audio', name });
      store.tracks = [
        ...store.tracks,
        {
          id: trackId,
          name,
          color,
          kind: 'audio',
          mute: false,
          solo: false,
          volume: 1,
          pan: 0,
          order: store.tracks.length,
        },
      ];
      const newClipId = project.addClip({
        trackId,
        isMidi: false,
        startPpq,
        lengthPpq,
        gain,
        ...placeholderSourceAudio(),
        ...(sourceId === undefined ? { sourceUri: audioAssetUri(meta.id) } : {}),
      });
      if (sourceId === undefined) setAudioSourceId(meta.id, project.sourceCount());
      else project.setClipSource(newClipId, sourceId);
      store.clips = [
        ...store.clips,
        {
          id: newClipId,
          trackId,
          name,
          startPpq,
          lengthPpq,
          sourceOffsetPpq: 0,
          gain,
          loopEnabled: false,
          loopLengthPpq: 0,
          notes: [],
          kind: 'audio',
          assetId: meta.id,
        },
      ];
      newClipIds.push(newClipId);
    }
    store.refresh();
    return newClipIds;
  });
}
