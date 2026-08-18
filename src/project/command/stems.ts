import { ensureWasm } from '@/lib/wasm';
import { createAudioAssetTransaction } from '@/persistence/asset-transaction';
import { type AudioAssetMeta, audioAssetUri, loadAsset } from '@/persistence/assets';
import { collectReferencedAudioAssetIds } from '../asset-references';
import {
  type AudioStemEnhancers,
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
import { normalizeTempoMap } from '../tempo-map';
import { clipKind, TRACK_COLOR_PALETTE } from '../types';
import { executeAtomic } from './history';
import { requireClip } from './utils';

function stemSourceToken(
  store: ReturnType<typeof useProjectStore>,
  clip: Pick<
    ReturnType<typeof requireClip>,
    | 'id'
    | 'trackId'
    | 'name'
    | 'startPpq'
    | 'lengthPpq'
    | 'sourceOffsetPpq'
    | 'gain'
    | 'assetId'
    | 'kind'
    | 'loopEnabled'
    | 'loopLengthPpq'
    | 'fadeInPpq'
    | 'fadeOutPpq'
    | 'warp'
    | 'takes'
    | 'compSegments'
  >,
): string {
  return JSON.stringify({
    clip: {
      id: clip.id,
      trackId: clip.trackId,
      name: clip.name,
      startPpq: clip.startPpq,
      lengthPpq: clip.lengthPpq,
      sourceOffsetPpq: clip.sourceOffsetPpq,
      gain: clip.gain,
      assetId: clip.assetId,
      kind: clip.kind,
      loopEnabled: clip.loopEnabled,
      loopLengthPpq: clip.loopLengthPpq,
      fadeInPpq: clip.fadeInPpq,
      fadeOutPpq: clip.fadeOutPpq,
      warp: clip.warp,
      takes: clip.takes,
      compSegments: clip.compSegments,
    },
    tempoBpm: store.tempoBpm,
    tempoSegments: store.tempoSegments,
  });
}

function isStemSourceCurrent(
  store: ReturnType<typeof useProjectStore>,
  project: ReturnType<typeof getProject>,
  clipId: number,
  token: string,
): boolean {
  const current = store.clips.find((entry) => entry.id === clipId);
  return (
    getProject() === project && current !== undefined && stemSourceToken(store, current) === token
  );
}

/**
 * Splits an audio clip into harmonic / percussive / residual stems, each laid
 * down on a new audio track aligned under the source clip, as one undoable
 * edit.
 *
 * The clip's played source window is separated with libsonare's
 * `hpssWithResidual` (delegated; see {@link separateAudioClipStems}); newer
 * builds can also provide phase-vocoder length repair, an NN filter that
 * refines a band in place, and matrix NMF read as a bleed gate between the
 * harmonic and percussive bands. None of the three reconstructs a waveform, so
 * the bands laid down here are always the separator's own. Each band is
 * stored as a new audio asset and placed as a clip at the source clip's start
 * with its length and gain. The async work (separation and asset stores) runs
 * first; the tracks, asset sources and clips are then created inside a single
 * `execute`, so undo reverts the whole split at once.
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
  const project = getProject();
  const sourceToken = stemSourceToken(store, clip);
  const wasm = (await ensureWasm()) as unknown as {
    hpssWithResidual?: AudioStemSeparator;
  } & AudioStemEnhancers;
  if (typeof wasm.hpssWithResidual !== 'function') return [];
  const stems = await separateAudioClipStems(
    clip,
    normalizeTempoMap(store.tempoSegments, store.tempoBpm),
    {
      loadAudioAsset: loadAsset,
      separateStems: wasm.hpssWithResidual,
      enhancers: {
        phaseVocoder: wasm.phaseVocoder,
        decompose: wasm.decompose,
        decomposeWithInit: wasm.decomposeWithInit,
        nnFilter: wasm.nnFilter,
      },
    },
  );
  if (stems.length === 0) return [];
  if (!isStemSourceCurrent(store, project, clipId, sourceToken)) return [];

  // Store each band under one lease-backed transaction before touching the
  // Project. Any save/placement failure removes only newly-created content.
  const baseName = clip.name;
  const assets = createAudioAssetTransaction();
  const isReferenced = (assetId: string): boolean =>
    collectReferencedAudioAssetIds(store.clips, store.tracks).has(assetId);
  try {
    const saved: { stem: SeparatedStem; meta: AudioAssetMeta }[] = [];
    for (const stem of stems) {
      const meta = await assets.save(
        { name: `${baseName} ${stem.kind}`, sampleRate: stem.sampleRate },
        stem.channels,
      );
      saved.push({ stem, meta });
    }
    if (!isStemSourceCurrent(store, project, clipId, sourceToken)) {
      await assets.rollback(isReferenced);
      return [];
    }

    const startPpq = clip.startPpq;
    const lengthPpq = clip.lengthPpq;
    const gain = clip.gain;
    const sourceCount = project.sourceCount();
    const plans = saved.map(({ stem, meta }) => {
      const known = getAudioSourceId(meta.id);
      const sourceId =
        known !== undefined && known >= 1 && known <= sourceCount ? known : undefined;
      return { stem, meta, sourceId };
    });

    const result = executeAtomic((edit) => {
      const newClipIds: number[] = [];
      for (const { stem, meta, sourceId } of plans) {
        const name = `${baseName} ${stem.kind}`;
        const color = TRACK_COLOR_PALETTE[store.tracks.length % TRACK_COLOR_PALETTE.length];
        const trackId = edit(1, () => project.addTrack({ kind: 'audio', name }));
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
        const newClipId = edit(2, () =>
          project.addClip({
            trackId,
            isMidi: false,
            startPpq,
            lengthPpq,
            gain,
            ...placeholderSourceAudio(),
            ...(sourceId === undefined ? { sourceUri: audioAssetUri(meta.id) } : {}),
          }),
        );
        if (sourceId === undefined) setAudioSourceId(meta.id, project.sourceCount());
        else edit(1, () => project.setClipSource(newClipId, sourceId));
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
    assets.commit();
    return result;
  } catch (error) {
    await assets.rollback(isReferenced);
    throw error;
  }
}
