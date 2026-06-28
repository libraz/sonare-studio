/**
 * Audio clip scheduling for the engine-backed offline renderer: loads each
 * clip's asset, expands comp segments, applies the live offline transforms
 * (warp/slice window, baked fades, linear resample to the render rate) and
 * emits engine clip specs placed at their timeline PPQ. Frozen tracks play
 * their baked pre-fader render from the timeline start instead of their clips.
 */

import type { LoadedAudioAsset } from '@/persistence/assets';
import { audioClipSegments } from '@/project/comping';
import {
  applyAudioClipFades,
  resampleChannelsLinear,
  sliceAudioClipWindow,
} from '@/project/scheduling';
import type { DocumentClip, ProjectDocument } from '@/project/serialization';
import { bakeWarpedClip } from '@/project/warp';
import type { EngineClipSpec } from './engine-render-types';

/** Inputs the audio clip builder needs beyond the document. */
export interface AudioClipBuildContext {
  /** Synthetic engine track ids, one per document track. */
  trackIds: number[];
  /** Tempo (BPM) used by the fixed-rate slice transforms. */
  sliceTempoBpm: number;
  /** Render sample rate in Hz. */
  sampleRate: number;
  /** Audio asset loader. */
  loadAudio: (assetId: string) => Promise<LoadedAudioAsset>;
  /** Throws MixdownCancelledError when the render was cancelled. */
  checkCancel: () => void;
}

/**
 * Builds the engine audio clip schedules for a document. Mirrors live
 * scheduling exactly: one engine clip per comp segment, missing assets leave
 * the slice silent, tempo-following clips bake through the offline stretch.
 *
 * @param doc Plain project document.
 * @param context Track ids, slice tempo, sample rate and injectable seams.
 * @returns The engine clip specs consumed by setClips.
 */
export async function buildAudioClips(
  doc: ProjectDocument,
  context: AudioClipBuildContext,
): Promise<EngineClipSpec[]> {
  const { trackIds, sliceTempoBpm, sampleRate, loadAudio, checkCancel } = context;
  const audioClips: EngineClipSpec[] = [];
  const renderAudioClip = async (clip: DocumentClip, trackId: number): Promise<void> => {
    if (clip.gain <= 0) return;
    // A clip expands to one engine clip per comp segment (one segment for
    // clips without takes), matching live scheduling exactly.
    for (const segment of audioClipSegments(clip)) {
      let asset: LoadedAudioAsset;
      try {
        asset = await loadAudio(segment.assetId);
      } catch {
        // Missing or unreadable asset: leave the slice silent, like live playback.
        continue;
      }
      // Tempo-following clips bake their window through the offline stretch
      // instead of the fixed-rate slice (takes-free clips only).
      let channels =
        clip.warp?.enabled && (clip.takes?.length ?? 0) === 0
          ? await bakeWarpedClip(asset.channels, asset.meta.sampleRate, clip, sliceTempoBpm, {
              cacheKey: segment.assetId,
            })
          : sliceAudioClipWindow(
              asset.channels,
              asset.meta.sampleRate,
              segment.sourceOffsetPpq,
              segment.lengthPpq,
              sliceTempoBpm,
            );
      channels = applyAudioClipFades(
        channels,
        asset.meta.sampleRate,
        sliceTempoBpm,
        segment.fadeInPpq,
        segment.fadeOutPpq,
      );
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
      } catch {
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
