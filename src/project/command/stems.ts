import { ensureWasm } from '@/lib/wasm';
import { createAudioAssetTransaction } from '@/persistence/asset-transaction';
import { type AudioAssetMeta, audioAssetUri, loadAsset } from '@/persistence/assets';
import { createAssetReferenceGuard } from '../asset-references';
import {
  type AudioStemEnhancers,
  type AudioStemSeparator,
  type SeparatedStem,
  separateAudioClipComponents,
  separateAudioClipStems,
} from '../audio-stems';
import { decomposeStemsInWorker } from '../decompose-stems-client';
import { assertCanAddTracks } from '../mixer';
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

function isAbortError(error: unknown): boolean {
  return (error instanceof Error || error instanceof DOMException) && error.name === 'AbortError';
}

/**
 * Stores each stem under one lease-backed transaction, then lays down one
 * track and one clip per stem, aligned under the source clip, as one
 * undoable edit. Returns [] and rolls back the saved assets without touching
 * the Project when the source clip's separation context went stale, or when
 * `signal` was aborted, while assets were being saved.
 */
async function placeSeparatedStems(
  clipId: number,
  clip: ReturnType<typeof requireClip>,
  project: ReturnType<typeof getProject>,
  sourceToken: string,
  stems: SeparatedStem[],
  nameStem: (stem: SeparatedStem) => string,
  signal?: AbortSignal,
): Promise<number[]> {
  const store = useProjectStore();
  assertCanAddTracks(store.tracks.length, stems.length);
  const assets = createAudioAssetTransaction();
  const isReferenced = createAssetReferenceGuard(store);
  try {
    const saved: { stem: SeparatedStem; meta: AudioAssetMeta }[] = [];
    for (const stem of stems) {
      const meta = await assets.save(
        { name: nameStem(stem), sampleRate: stem.sampleRate },
        stem.channels,
      );
      saved.push({ stem, meta });
    }
    if (signal?.aborted || !isStemSourceCurrent(store, project, clipId, sourceToken)) {
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

    assertCanAddTracks(store.tracks.length, plans.length);
    const result = executeAtomic((edit) => {
      const newClipIds: number[] = [];
      for (const { stem, meta, sourceId } of plans) {
        const name = nameStem(stem);
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
        const newClipId = edit(1, () =>
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

/**
 * Splits an audio clip into harmonic / percussive / residual stems, each laid
 * down on a new audio track aligned under the source clip, as one undoable
 * edit.
 *
 * The clip's played source window is separated with libsonare's
 * `hpssWithResidual` (delegated; see {@link separateAudioClipStems}); newer
 * builds can also provide phase-vocoder length repair and an NN filter that
 * refines a band in place. Neither reconstructs a waveform, so the bands laid
 * down here are always the separator's own. Each band is stored as a new
 * audio asset and placed as a clip at the source clip's start with its length
 * and gain. The async work (separation and asset stores) runs first; the
 * tracks, asset sources and clips are then created inside a single
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
        nnFilter: wasm.nnFilter,
      },
    },
  );
  if (stems.length === 0) return [];
  if (!isStemSourceCurrent(store, project, clipId, sourceToken)) return [];
  const baseName = clip.name;
  return placeSeparatedStems(clipId, clip, project, sourceToken, stems, (stem) => {
    return `${baseName} ${stem.kind}`;
  });
}

/** Injected NMF decomposer for {@link splitAudioClipToComponents}. */
export type ComponentDecomposer = (
  channels: Float32Array[],
  sampleRate: number,
  count: number,
  signal?: AbortSignal,
) => Promise<Float32Array[][]>;

function defaultComponentDecomposer(
  channels: Float32Array[],
  sampleRate: number,
  count: number,
  signal?: AbortSignal,
): Promise<Float32Array[][]> {
  return decomposeStemsInWorker(channels, sampleRate, count, { signal });
}

/**
 * Splits an audio clip into `count` NMF components, each laid down on a new
 * audio track aligned under the source clip, as one undoable edit. The
 * factorisation shares one model and mask across every channel (delegated;
 * see {@link separateAudioClipComponents}), so the stereo image survives and
 * the components sum back to the source.
 *
 * @param clipId Id of the audio clip to split.
 * @param count Number of components; an integer in [2, 8].
 * @param options.signal Aborts the split; already-saved assets are rolled
 *   back and [] is returned without touching the Project.
 * @param options.decompose Decomposer override (tests); production runs
 *   {@link decomposeStemsInWorker}.
 * @returns The new clip ids (one per component, in `decompose` order), or []
 *   when aborted or the clip has no audible window.
 * @throws RangeError when the clip is not an audio clip, or `count` is not an
 *   integer in [2, 8].
 */
export async function splitAudioClipToComponents(
  clipId: number,
  count: number,
  options: { signal?: AbortSignal; decompose?: ComponentDecomposer } = {},
): Promise<number[]> {
  if (!Number.isInteger(count) || count < 2 || count > 8) {
    throw new RangeError(`Component count must be an integer in [2, 8], got ${count}`);
  }
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if (clipKind(clip) !== 'audio') {
    throw new RangeError(`Clip ${clipId} is not an audio clip`);
  }
  const project = getProject();
  const sourceToken = stemSourceToken(store, clip);
  const { signal, decompose = defaultComponentDecomposer } = options;
  let stems: SeparatedStem[];
  try {
    stems = await separateAudioClipComponents(
      clip,
      normalizeTempoMap(store.tempoSegments, store.tempoBpm),
      count,
      {
        loadAudioAsset: loadAsset,
        decompose: (channels, sampleRate, n) => decompose(channels, sampleRate, n, signal),
      },
    );
  } catch (error) {
    if (isAbortError(error)) return [];
    throw error;
  }
  if (signal?.aborted || stems.length === 0) return [];
  if (!isStemSourceCurrent(store, project, clipId, sourceToken)) return [];
  const baseName = clip.name;
  return placeSeparatedStems(
    clipId,
    clip,
    project,
    sourceToken,
    stems,
    (stem) => `${baseName} component ${(stem.index ?? 0) + 1}`,
    signal,
  );
}
