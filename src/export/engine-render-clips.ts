/**
 * Audio clip scheduling for the engine-backed offline renderer: loads each
 * clip's asset, expands comp segments, applies the live offline transforms
 * (warp/slice window, baked fades, linear resample to the render rate) and
 * emits engine clip specs placed at their timeline PPQ. Frozen tracks play
 * their baked pre-fader render from the timeline start instead of their clips.
 */

import type { LoadedAudioAsset } from '@/persistence/assets';
import { audioClipSegments } from '@/project/comping';
import { renderAudioClipSegment, resampleChannelsLinear } from '@/project/scheduling';
import type { DocumentClip, ProjectDocument } from '@/project/serialization';
import type { NormalizedTempoMap } from '@/project/tempo-map';
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
  /** Throws MixdownCancelledError when the render was cancelled. */
  checkCancel: () => void;
  /** Structured non-fatal omissions returned in the final render report. */
  mediaIssues?: ExportMediaIssue[];
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
  const { trackIds, tempoMap, sampleRate, loadAudio, checkCancel } = context;
  const audioClips: EngineClipSpec[] = [];
  const renderAudioClip = async (clip: DocumentClip, trackId: number): Promise<void> => {
    if (clip.gain <= 0) return;
    // A clip expands to one engine clip per comp segment (one segment for
    // clips without takes), matching live scheduling exactly.
    for (const segment of audioClipSegments(clip)) {
      let asset: LoadedAudioAsset;
      try {
        asset = await loadAudio(segment.assetId);
      } catch (error) {
        if (!context.mediaIssues?.some((issue) => issue.id === segment.assetId)) {
          context.mediaIssues?.push({
            kind: 'audio-asset',
            id: segment.assetId,
            reason: 'missing-or-unreadable',
            message: error instanceof Error ? error.message : String(error),
          });
        }
        // Missing or unreadable asset: leave the slice silent, like live playback.
        continue;
      }
      let channels = await renderAudioClipSegment(asset, clip, segment, tempoMap);
      channels = resampleChannelsLinear(channels, asset.meta.sampleRate, sampleRate);
      if (channels.length === 0 || channels[0].length === 0) continue;
      audioClips.push({
        trackId,
        channels,
        startPpq: clip.startPpq + segment.offsetPpq,
        lengthSamples: channels[0].length,
        gain: clip.gain,
      });
    }
  };
  for (let index = 0; index < doc.tracks.length; index++) {
    const track = doc.tracks[index];
    // Frozen tracks play their baked pre-fader render from the timeline
    // start instead of their own clips.
    if (track.frozen !== undefined) {
      try {
        const asset = await loadAudio(track.frozen.assetId);
        const channels = resampleChannelsLinear(
          asset.channels.map((channel) => channel.slice()),
          asset.meta.sampleRate,
          sampleRate,
        );
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
            message: error instanceof Error ? error.message : String(error),
          });
        }
        // Missing or unreadable frozen asset: the track stays silent.
      }
      continue;
    }
    for (const clip of track.clips) {
      if ((clip.kind ?? 'midi') !== 'audio') continue;
      checkCancel();
      await renderAudioClip(clip, trackIds[index]);
    }
  }
  return audioClips;
}
