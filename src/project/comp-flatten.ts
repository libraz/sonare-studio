/**
 * Comp flattening: stitches the comp selection of an audio clip with takes
 * into one new asset, then turns the clip back into a normal audio clip over
 * that asset (one undoable edit for the clip change; the baked asset itself
 * is not part of undo history).
 */

import { createAudioAssetTransaction } from '@/persistence/asset-transaction';
import { type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import { collectReferencedAudioAssetIds } from './asset-references';
import { dropClipTakesBatch } from './commands';
import { audioClipSegments } from './comping';
import { resampleChannelsLinear, sliceAudioClipWindow } from './scheduling';
import { useProjectStore } from './store';
import type { EditorClip } from './types';

/** Options for {@link flattenClipComp}. */
export interface FlattenClipCompOptions {
  /** Tempo used to convert PPQ to samples; defaults to the project tempo. */
  tempoBpm?: number;
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
  tempoBpm: number,
  loadAudio: (assetId: string) => Promise<LoadedAudioAsset>,
): Promise<RenderedComp> {
  const segments = audioClipSegments(clip);
  // Slice each segment from its take (fades stay clip fields, so they are
  // NOT baked here) and concatenate at a common sample rate / channel count.
  // The clip's source offset is owned by the wasm Project and survives the
  // flatten, so the baked asset gets that much leading silence: the clip
  // window then reads the stitched content at its unchanged offset.
  const slices: Float32Array[][] = [];
  let sampleRate = 0;
  let channelCount = 0;
  for (const segment of segments) {
    const asset = await loadAudio(segment.assetId);
    if (sampleRate === 0) sampleRate = asset.meta.sampleRate;
    let channels = sliceAudioClipWindow(
      asset.channels,
      asset.meta.sampleRate,
      segment.sourceOffsetPpq,
      segment.lengthPpq,
      tempoBpm,
    );
    channels = resampleChannelsLinear(channels, asset.meta.sampleRate, sampleRate);
    slices.push(channels);
    channelCount = Math.max(channelCount, channels.length);
  }
  if (!(sampleRate > 0)) throw new Error(`Clip ${clip.id} comp rendered no audio`);
  const padFrames = Math.max(0, Math.round(((clip.sourceOffsetPpq * 60) / tempoBpm) * sampleRate));
  const totalFrames = padFrames + slices.reduce((sum, slice) => sum + (slice[0]?.length ?? 0), 0);
  const stitched: Float32Array[] = Array.from(
    { length: Math.max(1, channelCount) },
    () => new Float32Array(totalFrames),
  );
  let offset = padFrames;
  for (const slice of slices) {
    const frames = slice[0]?.length ?? 0;
    for (let c = 0; c < stitched.length; c++) {
      // Mono slices feed every output channel.
      const source = slice[c] ?? slice[0];
      if (source) stitched[c].set(source, offset);
    }
    offset += frames;
  }
  return { channels: stitched, sampleRate, name: `${clip.name} (comp)` };
}

/** Renders/saves all inputs, then drops every take lane in one command. */
async function flattenCompClips(
  clips: ReadonlyArray<EditorClip>,
  options: FlattenClipCompOptions,
): Promise<string[]> {
  if (clips.length === 0) return [];
  const store = useProjectStore();
  const tempoBpm = options.tempoBpm ?? store.tempoBpm;
  const loadAudio = options.loadAudioAsset ?? loadAsset;
  const assets = createAudioAssetTransaction();
  const isReferenced = (assetId: string): boolean =>
    collectReferencedAudioAssetIds(store.clips, store.tracks).has(assetId);
  const inputs = clips.map((clip) => ({ clip, token: flattenClipToken(clip) }));
  try {
    const plans: Array<{ clipId: number; assetId: string; bakedAssetId?: string }> = [];
    for (const { clip } of inputs) {
      const segments = audioClipSegments(clip);
      if (segments.length <= 1) {
        const assetId = segments[0]?.assetId ?? clip.assetId;
        if (!assetId) throw new Error(`Clip ${clip.id} selected take has no audio asset`);
        plans.push({ clipId: clip.id, assetId });
        continue;
      }
      const rendered = await renderClipComp(clip, tempoBpm, loadAudio);
      const meta = options.ingest
        ? await options.ingest(rendered.channels, rendered.sampleRate, rendered.name)
        : await assets.save(
            { name: rendered.name, sampleRate: rendered.sampleRate },
            rendered.channels,
          );
      if (!meta.id) throw new Error(`Clip ${clip.id} comp ingest returned an empty asset id`);
      plans.push({ clipId: clip.id, assetId: meta.id, bakedAssetId: meta.id });
    }
    if (inputs.some(({ clip, token }) => !isFlattenSourceCurrent(store, clip.id, token))) {
      await assets.rollback(isReferenced);
      return [];
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
    throw error;
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
