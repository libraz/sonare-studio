/**
 * Comp flattening: stitches the comp selection of an audio clip with takes
 * into one new asset, then turns the clip back into a normal audio clip over
 * that asset (one undoable edit for the clip change; the baked asset itself
 * is not part of undo history).
 */

import { type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import { ingestAudioBuffer } from './audio-import';
import { dropClipTakes } from './commands';
import { audioClipSegments } from './comping';
import { resampleChannelsLinear, sliceAudioClipWindow } from './scheduling';
import { useProjectStore } from './store';

/** Options for {@link flattenClipComp}. */
export interface FlattenClipCompOptions {
  /** Tempo used to convert PPQ to samples; defaults to the project tempo. */
  tempoBpm?: number;
  /** Audio asset loader (defaults to the OPFS asset store's loadAsset). */
  loadAudioAsset?: (assetId: string) => Promise<LoadedAudioAsset>;
  /** Asset ingester (defaults to ingestAudioBuffer without analysis). */
  ingest?: (channels: Float32Array[], sampleRate: number, name: string) => Promise<{ id: string }>;
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
  const segments = audioClipSegments(clip);
  if (segments.length <= 1) {
    // Whole-clip selection: the clip already points at the selected take.
    dropClipTakes(clipId);
    const flattened = store.clips.find((entry) => entry.id === clipId);
    return flattened?.assetId ?? '';
  }

  const tempoBpm = options.tempoBpm ?? store.tempoBpm;
  const loadAudio = options.loadAudioAsset ?? loadAsset;
  const ingest =
    options.ingest ??
    ((channels: Float32Array[], sampleRate: number, name: string) =>
      ingestAudioBuffer(channels, sampleRate, name, { analysis: null }));

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

  const meta = await ingest(stitched, sampleRate, `${clip.name} (comp)`);
  dropClipTakes(clipId, meta.id);
  return meta.id;
}
