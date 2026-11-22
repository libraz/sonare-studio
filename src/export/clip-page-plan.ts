/**
 * Deciding which of a document's audio clip segments an offline render can read
 * straight out of their stored assets.
 *
 * A project's audio normally reaches the engine as one decoded buffer per clip
 * segment, so the peak payload of a render grows with the project's total PCM.
 * Reading a clip from its asset instead is only sound when the bytes the asset
 * holds are exactly the bytes the clip plays: any transform the renderer bakes
 * into the buffer (a warp, a fade, a sample-rate conversion) disqualifies the
 * clip, which then takes the decoded path unchanged.
 *
 * The window bookkeeping that follows a plan lives in clip-page-stream.ts,
 * which deliberately knows nothing about the project model.
 */

import type { AudioAssetMeta } from '@/persistence/assets';
import { audioClipSegments } from '@/project/comping';
import { audioClipWindowFrames } from '@/project/scheduling';
import type { DocumentClip, ProjectDocument } from '@/project/serialization';
import { type NormalizedTempoMap, ppqToSamples } from '@/project/tempo-map';
import type { AudioClipStreamPlan } from './clip-page-stream';

/**
 * Clips shorter than this stay on the decoded path: their whole PCM is smaller
 * than the window a stream would hold anyway.
 */
export const MIN_CLIP_STREAM_FRAMES = 1 << 18;

/** Identifies one clip segment across the planning and building passes. */
export function audioClipSegmentKey(
  trackIndex: number,
  clipIndex: number,
  segmentIndex: number,
): string {
  return `${trackIndex}:${clipIndex}:${segmentIndex}`;
}

/** Identifies a frozen track's baked render (which has no clip of its own). */
export function frozenTrackStreamKey(trackIndex: number): string {
  return `${trackIndex}:frozen`;
}

/** Inputs {@link planAudioClipStreams} needs beyond the document. */
export interface AudioClipStreamPlanContext {
  /** Synthetic engine track ids, one per document track. */
  trackIds: number[];
  /** Tempo map used to place clips and cut source windows. */
  tempoMap: NormalizedTempoMap;
  /** Render sample rate in Hz. */
  sampleRate: number;
  /** Metadata-only asset loader (no PCM is read while planning). */
  loadAudioMeta: (assetId: string) => Promise<AudioAssetMeta>;
  /** Throws when the render was cancelled. */
  checkCancel: () => void;
  /** Resolved render range; segments wholly outside it are not planned. */
  range?: { startPpq: number; endPpq: number | null };
  /** Track indices that can contribute. Omit to include all. */
  audibleTrackIndices?: ReadonlySet<number>;
  /** Shortest clip worth streaming; defaults to {@link MIN_CLIP_STREAM_FRAMES}. */
  minFrames?: number;
}

/** Whether a segment overlaps the render range; no range means everything overlaps. */
export function segmentIntersectsRange(
  startPpq: number,
  lengthPpq: number,
  range: AudioClipStreamPlanContext['range'],
): boolean {
  if (!range) return true;
  const endPpq = startPpq + lengthPpq;
  return endPpq > range.startPpq && (range.endPpq === null || startPpq < range.endPpq);
}

/**
 * True when the renderer would bake a transform into a clip's buffer, so the
 * stored asset's bytes are not what the clip plays.
 */
function clipBakesATransform(clip: DocumentClip, fadeInPpq: number, fadeOutPpq: number): boolean {
  if (fadeInPpq > 0 || fadeOutPpq > 0) return true;
  return clip.warp?.enabled === true && (clip.takes?.length ?? 0) === 0;
}

/**
 * Plans which audio clip segments an offline render can read from their stored
 * assets. Walks the document exactly as the decoded clip builder does, so the
 * keys it returns line up one for one with the segments that builder would
 * otherwise decode.
 *
 * Only metadata is read: a plan costs one sidecar per distinct asset.
 *
 * @param doc Plain project document.
 * @param context Track ids, tempo map, sample rate and injectable seams.
 * @returns One plan per streamable segment, in document order.
 */
export async function planAudioClipStreams(
  doc: ProjectDocument,
  context: AudioClipStreamPlanContext,
): Promise<AudioClipStreamPlan[]> {
  const minFrames = context.minFrames ?? MIN_CLIP_STREAM_FRAMES;
  const metas = new Map<string, AudioAssetMeta | null>();
  const plans: AudioClipStreamPlan[] = [];
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
      // An unreadable sidecar is the decoded builder's problem to report; here
      // it simply means the segment is not streamable.
      metas.set(assetId, null);
      return null;
    }
  };

  for (let trackIndex = 0; trackIndex < doc.tracks.length; trackIndex += 1) {
    if (context.audibleTrackIndices && !context.audibleTrackIndices.has(trackIndex)) continue;
    const track = doc.tracks[trackIndex];
    const trackId = context.trackIds[trackIndex];
    if (trackId === undefined) continue;
    if (track.frozen !== undefined) {
      const meta = await getMeta(track.frozen.assetId);
      if (!meta || meta.sampleRate !== context.sampleRate || meta.numFrames < minFrames) continue;
      plans.push({
        key: frozenTrackStreamKey(trackIndex),
        trackId,
        assetId: track.frozen.assetId,
        startPpq: 0,
        gain: 1,
        numChannels: meta.numChannels,
        sourceStartFrame: 0,
        frameCount: meta.numFrames,
        timelineStartFrame: 0,
      });
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
        if (clipBakesATransform(clip, segment.fadeInPpq, segment.fadeOutPpq)) continue;
        const meta = await getMeta(segment.assetId);
        if (!meta || meta.sampleRate !== context.sampleRate) continue;
        const window = audioClipWindowFrames(
          meta.numFrames,
          meta.sampleRate,
          segment.sourceOffsetPpq,
          segment.lengthPpq,
          context.tempoMap,
          startPpq - segment.sourceOffsetPpq,
        );
        const frameCount = window.end - window.start;
        if (frameCount < minFrames) continue;
        plans.push({
          key: audioClipSegmentKey(trackIndex, clipIndex, segmentIndex),
          trackId,
          assetId: segment.assetId,
          startPpq,
          gain: clip.gain,
          numChannels: meta.numChannels,
          sourceStartFrame: window.start,
          frameCount,
          timelineStartFrame: ppqToSamples(context.tempoMap, startPpq, context.sampleRate),
        });
      }
    }
  }
  return plans;
}
