/**
 * Audio clip scheduling for the engine-backed offline renderer: loads each
 * clip's asset, expands comp segments, resolves each segment the way live
 * playback does (a sliced window, or a warp source slice with its anchors),
 * resamples it to the render rate at high quality and emits engine clip specs
 * with their fades placed at their timeline PPQ. Frozen tracks play
 * their baked pre-fader render from the timeline start instead of their clips.
 */

import { errorMessage } from '@/lib/errors';
import type { AudioAssetMeta, LoadedAudioAsset } from '@/persistence/assets';
import { audioClipSegments } from '@/project/comping';
import {
  audioClipSegmentSource,
  audioClipSegmentSourceAtRate,
  engineClipPlayback,
} from '@/project/scheduling';
import type { DocumentClip, ProjectDocument } from '@/project/serialization';
import { type NormalizedTempoMap, ppqDurationSamples } from '@/project/tempo-map';
import { audioClipSegmentKey, frozenTrackStreamKey } from './clip-page-plan';
import type { EngineClipSpec } from './engine-render-types';
import type { ExportMediaIssue } from './mixdown';

/** Inputs the audio clip builder needs beyond the document. */
export interface AudioClipBuildContext {
  /** Synthetic engine track ids, one per document track. */
  trackIds: number[];
  /** Tempo map used by source-window and fade transforms. */
  tempoMap: NormalizedTempoMap;
  /** Render sample rate in Hz. */
  sampleRate: number;
  /** Audio asset loader. */
  loadAudio: (assetId: string) => Promise<LoadedAudioAsset>;
  /** Offline-quality mono resampler supplied by the WASM module. */
  resampleAudio: (
    samples: Float32Array,
    sourceRate: number,
    targetRate: number,
  ) => Float32Array | Promise<Float32Array>;
  /** Throws MixdownCancelledError when the render was cancelled. */
  checkCancel: () => void;
  /** Structured non-fatal omissions returned in the final render report. */
  mediaIssues?: ExportMediaIssue[];
  /** Resolved render range, used to avoid loading clips wholly outside it. */
  range?: { startPpq: number; endPpq: number | null };
  /** Track indices that can contribute to this render. Omit to include all. */
  audibleTrackIndices?: ReadonlySet<number>;
  /**
   * Segment keys (see {@link audioClipSegmentKey}) whose audio the render
   * pages straight out of its asset. Those segments are not decoded here.
   */
  streamedKeys?: ReadonlySet<string>;
}

export interface AudioClipMemoryPreflight {
  sourceAudioBytes: number;
  preparedClipBytes: number;
  /** Minimal clip facts used to include frozen audio in an open-ended window. */
  audioWindowClips: Array<{ startPpq: number; lengthSamples: number }>;
}

function segmentIntersectsRange(
  startPpq: number,
  lengthPpq: number,
  range: AudioClipBuildContext['range'],
): boolean {
  if (!range) return true;
  const endPpq = startPpq + lengthPpq;
  return endPpq > range.startPpq && (range.endPpq === null || startPpq < range.endPpq);
}

function safeAddBytes(total: number, bytes: number): number {
  const next = total + bytes;
  if (!Number.isSafeInteger(next) || next < 0) {
    throw new RangeError('Audio render payload byte estimate exceeds the safe integer range');
  }
  return next;
}

/**
 * Reads sidecar metadata only and rejects oversized renders before source PCM
 * or transformed clip buffers are allocated.
 */
export async function preflightAudioClipMemory(
  doc: ProjectDocument,
  context: Pick<
    AudioClipBuildContext,
    'sampleRate' | 'tempoMap' | 'checkCancel' | 'range' | 'audibleTrackIndices' | 'streamedKeys'
  > & { loadAudioMeta: (assetId: string) => Promise<AudioAssetMeta> },
): Promise<AudioClipMemoryPreflight> {
  const metas = new Map<string, AudioAssetMeta | null>();
  let preparedClipBytes = 0;
  const audioWindowClips: AudioClipMemoryPreflight['audioWindowClips'] = [];
  // A paged segment decodes nothing, but an asset shared with a segment that
  // still decodes is loaded whole all the same; only the assets no segment
  // decodes drop out of the source total.
  const decodedAssetIds = new Set<string>();
  const isStreamed = (key: string): boolean => context.streamedKeys?.has(key) === true;
  const getMeta = async (assetId: string): Promise<AudioAssetMeta | null> => {
    if (metas.has(assetId)) return metas.get(assetId) ?? null;
    context.checkCancel();
    try {
      const meta = await context.loadAudioMeta(assetId);
      context.checkCancel();
      metas.set(assetId, meta);
      return meta;
    } catch {
      context.checkCancel();
      metas.set(assetId, null);
      return null;
    }
  };

  for (let trackIndex = 0; trackIndex < doc.tracks.length; trackIndex += 1) {
    if (context.audibleTrackIndices && !context.audibleTrackIndices.has(trackIndex)) {
      continue;
    }
    const track = doc.tracks[trackIndex];
    if (track.frozen) {
      const meta = await getMeta(track.frozen.assetId);
      if (!meta) continue;
      const lengthSamples = Math.round((meta.numFrames / meta.sampleRate) * context.sampleRate);
      if (!isStreamed(frozenTrackStreamKey(trackIndex))) {
        decodedAssetIds.add(track.frozen.assetId);
        preparedClipBytes = safeAddBytes(
          preparedClipBytes,
          lengthSamples * meta.numChannels * Float32Array.BYTES_PER_ELEMENT,
        );
      }
      audioWindowClips.push({ startPpq: 0, lengthSamples });
      continue;
    }
    for (let clipIndex = 0; clipIndex < track.clips.length; clipIndex += 1) {
      const clip = track.clips[clipIndex];
      if ((clip.kind ?? 'midi') !== 'audio' || clip.gain <= 0) continue;
      const segments = audioClipSegments(clip, {
        tempoMap: context.tempoMap,
        clipStartPpq: clip.startPpq,
      });
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const segment = segments[segmentIndex];
        const startPpq = clip.startPpq + segment.offsetPpq;
        if (!segmentIntersectsRange(startPpq, segment.lengthPpq, context.range)) continue;
        const meta = await getMeta(segment.assetId);
        if (!meta) continue;
        const lengthSamples = ppqDurationSamples(
          context.tempoMap,
          startPpq,
          segment.lengthPpq,
          context.sampleRate,
        );
        if (!isStreamed(audioClipSegmentKey(trackIndex, clipIndex, segmentIndex))) {
          decodedAssetIds.add(segment.assetId);
          preparedClipBytes = safeAddBytes(
            preparedClipBytes,
            lengthSamples * meta.numChannels * Float32Array.BYTES_PER_ELEMENT,
          );
        }
        audioWindowClips.push({ startPpq, lengthSamples });
      }
    }
  }
  let sourceAudioBytes = 0;
  for (const assetId of decodedAssetIds) {
    const meta = metas.get(assetId);
    if (!meta) continue;
    sourceAudioBytes = safeAddBytes(
      sourceAudioBytes,
      meta.numFrames * meta.numChannels * Float32Array.BYTES_PER_ELEMENT,
    );
  }
  return { sourceAudioBytes, preparedClipBytes, audioWindowClips };
}

/**
 * Builds the engine audio clip schedules for a document. Mirrors live
 * scheduling exactly: one engine clip per comp segment, missing assets leave
 * the slice silent, tempo-following clips bake through the offline stretch.
 *
 * @param doc Plain project document.
 * @param context Track ids, tempo map, sample rate and injectable seams.
 * @returns The engine clip specs consumed by setClips.
 */
export async function buildAudioClips(
  doc: ProjectDocument,
  context: AudioClipBuildContext,
): Promise<EngineClipSpec[]> {
  const { trackIds, tempoMap, sampleRate, loadAudio, checkCancel, resampleAudio } = context;
  const audioClips: EngineClipSpec[] = [];
  const resampleChannels = async (
    channels: Float32Array[],
    sourceRate: number,
  ): Promise<Float32Array[]> => {
    if (sourceRate === sampleRate) return channels;
    return Promise.all(channels.map((channel) => resampleAudio(channel, sourceRate, sampleRate)));
  };
  const isStreamed = (key: string): boolean => context.streamedKeys?.has(key) === true;
  const renderAudioClip = async (
    clip: DocumentClip,
    trackId: number,
    trackIndex: number,
    clipIndex: number,
  ): Promise<void> => {
    if (clip.gain <= 0) return;
    // A clip expands to one engine clip per comp segment (one segment for
    // clips without takes), matching live scheduling exactly.
    const segments = audioClipSegments(clip, {
      tempoMap,
      clipStartPpq: clip.startPpq,
    });
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex];
      const segmentStartPpq = clip.startPpq + segment.offsetPpq;
      if (!segmentIntersectsRange(segmentStartPpq, segment.lengthPpq, context.range)) continue;
      if (isStreamed(audioClipSegmentKey(trackIndex, clipIndex, segmentIndex))) continue;
      checkCancel();
      let asset: LoadedAudioAsset;
      try {
        asset = await loadAudio(segment.assetId);
      } catch (error) {
        if (!context.mediaIssues?.some((issue) => issue.id === segment.assetId)) {
          context.mediaIssues?.push({
            kind: 'audio-asset',
            id: segment.assetId,
            reason: 'missing-or-unreadable',
            message: errorMessage(error),
          });
        }
        // Missing or unreadable asset: leave the slice silent, like live playback.
        continue;
      }
      checkCancel();
      const source = audioClipSegmentSource(asset, clip, segment, tempoMap);
      if (source.lengthFrames === 0 || (source.channels[0]?.length ?? 0) === 0) continue;
      const channels = await resampleChannels(source.channels, source.sampleRate);
      checkCancel();
      const atRate = audioClipSegmentSourceAtRate(source, channels, sampleRate);
      if (atRate.lengthFrames === 0) continue;
      audioClips.push({
        trackId,
        channels,
        startPpq: clip.startPpq + segment.offsetPpq,
        gain: clip.gain,
        ...engineClipPlayback(atRate),
      });
    }
  };
  for (let index = 0; index < doc.tracks.length; index++) {
    if (context.audibleTrackIndices && !context.audibleTrackIndices.has(index)) continue;
    const track = doc.tracks[index];
    // Frozen tracks play their baked pre-fader render from the timeline
    // start instead of their own clips.
    if (track.frozen !== undefined) {
      if (isStreamed(frozenTrackStreamKey(index))) continue;
      try {
        checkCancel();
        const asset = await loadAudio(track.frozen.assetId);
        checkCancel();
        const channels = await resampleChannels(
          asset.channels.map((channel) => channel.slice()),
          asset.meta.sampleRate,
        );
        checkCancel();
        if (channels.length > 0 && channels[0].length > 0) {
          audioClips.push({
            trackId: trackIds[index],
            channels,
            startPpq: 0,
            lengthSamples: channels[0].length,
            gain: 1,
          });
        }
      } catch (error) {
        if (!context.mediaIssues?.some((issue) => issue.id === track.frozen?.assetId)) {
          context.mediaIssues?.push({
            kind: 'audio-asset',
            id: track.frozen.assetId,
            reason: 'missing-or-unreadable',
            message: errorMessage(error),
          });
        }
        // Missing or unreadable frozen asset: the track stays silent.
      }
      continue;
    }
    for (let clipIndex = 0; clipIndex < track.clips.length; clipIndex += 1) {
      const clip = track.clips[clipIndex];
      if ((clip.kind ?? 'midi') !== 'audio') continue;
      checkCancel();
      await renderAudioClip(clip, trackIds[index], index, clipIndex);
    }
  }
  return audioClips;
}
