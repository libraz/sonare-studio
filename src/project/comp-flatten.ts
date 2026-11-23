/**
 * Comp flattening: stitches the comp selection of an audio clip with takes
 * into one new asset, then turns the clip back into a normal audio clip over
 * that asset (one undoable edit for the clip change; the baked asset itself
 * is not part of undo history).
 */

import { OperationGeneration } from '@/lib/operation-generation';
import { createAudioAssetTransaction } from '@/persistence/asset-transaction';
import { type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import { createAssetReferenceGuard } from './asset-references';
import { type AudioClipSliceTempo, renderAudibleAudioClipWindow } from './audio-clip-render';
import { dropClipTakesBatch } from './commands';
import { audioClipSegments } from './comping';
import { defaultName } from './default-names';
import {
  assertProjectOperationCurrent,
  beginProjectOperation,
  StaleProjectOperationError,
} from './operation';
import { useProjectStore } from './store';
import { normalizeTempoMap } from './tempo-map';
import type { EditorClip } from './types';

const flattenOperations = new OperationGeneration();

/** Options for {@link flattenClipComp}. */
export interface FlattenClipCompOptions {
  /** Tempo used to convert PPQ to samples; defaults to the project tempo. */
  tempoBpm?: number;
  /** Full tempo map override; takes precedence over tempoBpm. */
  tempoSegments?: ReadonlyArray<{ startPpq: number; bpm: number; endBpm?: number }>;
  /** Audio asset loader (defaults to the OPFS asset store's loadAsset). */
  loadAudioAsset?: (assetId: string) => Promise<LoadedAudioAsset>;
  /** Asset ingester (defaults to ingestAudioBuffer without analysis). */
  ingest?: (channels: Float32Array[], sampleRate: number, name: string) => Promise<{ id: string }>;
}

/** Options for {@link flattenTrackComps}; identical seams apply to every clip. */
export type FlattenTrackCompsOptions = FlattenClipCompOptions;

function flattenClipToken(clip: EditorClip): string {
  return JSON.stringify({
    id: clip.id,
    trackId: clip.trackId,
    startPpq: clip.startPpq,
    lengthPpq: clip.lengthPpq,
    sourceOffsetPpq: clip.sourceOffsetPpq,
    assetId: clip.assetId,
    loopEnabled: clip.loopEnabled,
    loopLengthPpq: clip.loopLengthPpq,
    fadeInPpq: clip.fadeInPpq,
    fadeOutPpq: clip.fadeOutPpq,
    warp: clip.warp,
    takes: clip.takes,
    compSegments: clip.compSegments,
  });
}

function isFlattenSourceCurrent(
  store: ReturnType<typeof useProjectStore>,
  clipId: number,
  token: string,
): boolean {
  const current = store.clips.find((entry) => entry.id === clipId);
  return current !== undefined && flattenClipToken(current) === token;
}

interface RenderedComp {
  channels: Float32Array[];
  sampleRate: number;
  name: string;
}

/** Renders one already-validated multi-segment comp without publishing state. */
async function renderClipComp(
  clip: EditorClip,
  tempo: AudioClipSliceTempo,
  loadAudio: (assetId: string) => Promise<LoadedAudioAsset>,
): Promise<RenderedComp> {
  // Internal comp-boundary fades are baked by the canonical renderer. The
  // outer clip fades stay as clip metadata and are zeroed only for this bake,
  // preventing a second fade application after the clip is rebased.
  const rendered = await renderAudibleAudioClipWindow(
    { ...clip, fadeInPpq: 0, fadeOutPpq: 0 },
    tempo,
    loadAudio,
  );
  if (!rendered) throw new Error(`Clip ${clip.id} comp rendered no audio`);
  // The rendered buffer is exactly the audible clip window; the clip is rebased
  // onto it at sourceOffsetPpq 0 (see dropClipTakesBatch), so no leading silence
  // is prepended for the source offset — a large offset would otherwise bake
  // megabytes of silence and blow the asset ingest budget.
  return {
    channels: rendered.channels,
    sampleRate: rendered.sampleRate,
    name: defaultName('comp', { name: clip.name }),
  };
}

/** Renders/saves all inputs, then drops every take lane in one command. */
async function flattenCompClips(
  clips: ReadonlyArray<EditorClip>,
  options: FlattenClipCompOptions,
): Promise<string[]> {
  if (clips.length === 0) return [];
  const store = useProjectStore();
  const resolveTempo = (): AudioClipSliceTempo => {
    if (options.tempoSegments) {
      return normalizeTempoMap(options.tempoSegments, options.tempoBpm ?? store.tempoBpm);
    }
    if (options.tempoBpm !== undefined) return options.tempoBpm;
    return normalizeTempoMap(store.tempoSegments, store.tempoBpm);
  };
  const loadAudio = options.loadAudioAsset ?? loadAsset;
  const assets = createAudioAssetTransaction();
  const isReferenced = createAssetReferenceGuard(store);
  const inputs = clips.map((clip) => ({ clip, token: flattenClipToken(clip) }));
  const clipIds = inputs.map(({ clip }) => clip.id);
  const targetId = `comp:${clipIds.join(',')}`;
  const revision = (): string =>
    JSON.stringify({
      tempo: resolveTempo(),
      clips: clipIds.map((clipId) => {
        const current = store.clips.find((clip) => clip.id === clipId);
        return current ? flattenClipToken(current) : null;
      }),
    });
  const operation = beginProjectOperation(flattenOperations, store, targetId, revision());
  const assertCurrent = (): void =>
    assertProjectOperationCurrent(flattenOperations, operation, store, targetId, revision());
  try {
    const plans: Array<{ clipId: number; assetId: string; bakedAssetId?: string }> = [];
    for (const { clip } of inputs) {
      const tempo = resolveTempo();
      const tempoMap =
        typeof tempo === 'number' ? normalizeTempoMap([{ startPpq: 0, bpm: tempo }], tempo) : tempo;
      const segments = audioClipSegments(clip, { tempoMap, clipStartPpq: clip.startPpq });
      if (segments.length <= 1) {
        const assetId = segments[0]?.assetId ?? clip.assetId;
        if (!assetId) throw new Error(`Clip ${clip.id} selected take has no audio asset`);
        plans.push({ clipId: clip.id, assetId });
        continue;
      }
      const rendered = await renderClipComp(clip, resolveTempo(), loadAudio);
      assertCurrent();
      const meta = options.ingest
        ? await options.ingest(rendered.channels, rendered.sampleRate, rendered.name)
        : await assets.save(
            { name: rendered.name, sampleRate: rendered.sampleRate },
            rendered.channels,
          );
      assertCurrent();
      if (!meta.id) throw new Error(`Clip ${clip.id} comp ingest returned an empty asset id`);
      plans.push({ clipId: clip.id, assetId: meta.id, bakedAssetId: meta.id });
    }
    assertCurrent();
    if (inputs.some(({ clip, token }) => !isFlattenSourceCurrent(store, clip.id, token))) {
      throw new StaleProjectOperationError();
    }
    dropClipTakesBatch(
      plans.map(({ clipId, bakedAssetId }) => ({
        clipId,
        ...(bakedAssetId !== undefined ? { bakedAssetId } : {}),
      })),
    );
    assets.commit();
    return plans.map((plan) => plan.assetId);
  } catch (error) {
    await assets.rollback(isReferenced);
    if (error instanceof StaleProjectOperationError) return [];
    throw error;
  } finally {
    if (flattenOperations.isCurrent(operation.token)) flattenOperations.invalidate();
  }
}

/**
 * Bakes the current comp selection of a clip with takes into a single new
 * asset and rebases the clip onto it (dropping the take lanes). Single-take
 * selections skip the bake and just drop the takes.
 *
 * @param clipId Id of the comped clip.
 * @returns The clip's asset id after flattening.
 */
export async function flattenClipComp(
  clipId: number,
  options: FlattenClipCompOptions = {},
): Promise<string> {
  const store = useProjectStore();
  const clip = store.clips.find((entry) => entry.id === clipId);
  if (!clip) throw new RangeError(`Unknown clip id ${clipId}`);
  if ((clip.takes?.length ?? 0) === 0) throw new RangeError(`Clip ${clipId} has no takes`);
  const [assetId = ''] = await flattenCompClips([clip], options);
  return assetId;
}

/**
 * Flattens every comped audio clip on a track as one user operation. All
 * renders and asset saves complete under leases first; only then are every
 * clip's takes removed through one undo entry.
 *
 * @returns Resulting asset ids in timeline clip order, or [] if the source
 *   track changed while rendering.
 */
export async function flattenTrackComps(
  trackId: number,
  options: FlattenTrackCompsOptions = {},
): Promise<string[]> {
  const store = useProjectStore();
  const track = store.tracks.find((entry) => entry.id === trackId);
  if (!track) throw new RangeError(`Unknown track id ${trackId}`);
  if (track.kind !== 'audio') throw new RangeError(`Track ${trackId} is not an audio track`);
  const clips = store.clips
    .filter((clip) => clip.trackId === trackId && (clip.takes?.length ?? 0) > 0)
    .sort((a, b) => a.startPpq - b.startPpq || a.id - b.id);
  return flattenCompClips(clips, options);
}
