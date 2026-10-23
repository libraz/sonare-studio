/**
 * The audio window clip analysis reads. Detectors take their input from here
 * and nowhere else, so what they hear is what playback schedules: the
 * project tempo map, the timeline origin `startPpq - sourceOffsetPpq`, loops,
 * takes and warp all apply exactly as in {@link renderAudibleAudioClipWindow}
 * and {@link audioClipWindowFrames}.
 */

import { downmixToMono } from '@/lib/audio-channels';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { MIN_LOOP_WINDOW_PPQ } from './midi-projection';
import {
  type AudibleAudioClipFields,
  audioClipWindowFrames,
  renderAudibleAudioClipWindow,
} from './scheduling';
import { type NormalizedTempoMap, normalizeTempoMap } from './tempo-map';
import type { TempoSegment } from './types';
import { type WarpRenderFn, warpSegments } from './warp';

/** A clip's audible content as one mono buffer, starting at the clip start. */
export interface AudibleClipMono {
  mono: Float32Array;
  sampleRate: number;
  /** The tempo map the window was rendered under; map detector seconds back through it. */
  map: NormalizedTempoMap;
}

/**
 * Renders the audible content of an audio clip as mono, clip-local audio.
 *
 * @param clip Audio clip to analyze.
 * @param tempoBpm Fallback tempo (> 0) when `tempoSegments` is empty.
 * @param tempoSegments Project tempo map.
 * @param loadAudioAsset Asset loader.
 * @param options Warped-clip render override for tests; production renders through the engine.
 * @returns The buffer, or null when nothing is audible.
 */
export async function renderAudibleClipMono(
  clip: AudibleAudioClipFields,
  tempoBpm: number,
  tempoSegments: ReadonlyArray<TempoSegment>,
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>,
  options: { renderWarp?: WarpRenderFn } = {},
): Promise<AudibleClipMono | null> {
  const map = normalizeTempoMap(tempoSegments, tempoBpm);
  const rendered = await renderAudibleAudioClipWindow(clip, map, loadAudioAsset, options);
  if (!rendered) return null;
  const mono = downmixToMono(rendered.channels, { copy: true });
  return mono.length === 0 ? null : { mono, sampleRate: rendered.sampleRate, map };
}

/** Clip fields that decide which source frames the clip's window covers. */
export interface ClipSourceWindowFields {
  startPpq: number;
  lengthPpq: number;
  sourceOffsetPpq: number;
  loopEnabled?: boolean;
  loopLengthPpq?: number;
  warp?: AudibleAudioClipFields['warp'];
}

/** Length one pass of the clip reads from its source: the clamped loop window when looping. */
function onePassLengthPpq(clip: ClipSourceWindowFields): number {
  const loopLengthPpq = clip.loopEnabled === true ? (clip.loopLengthPpq ?? 0) : 0;
  if (!(Number.isFinite(loopLengthPpq) && loopLengthPpq > 0)) return clip.lengthPpq;
  return Math.min(clip.lengthPpq, Math.max(loopLengthPpq, MIN_LOOP_WINDOW_PPQ));
}

/**
 * Source frames one asset contributes to one pass of a clip window, before
 * any stretch: the warp's source range for a warped clip, otherwise the span
 * playback cuts under the tempo map from the origin `startPpq -
 * sourceOffsetPpq`. A looping clip reads only its loop window. Used where
 * the source material itself is analyzed (tempo, beats) rather than the
 * rendered output.
 *
 * @returns Half-open `[start, end)` frames clamped into the asset.
 */
export function clipSourceWindowFrames(
  clip: ClipSourceWindowFields,
  sourceFrames: number,
  sampleRate: number,
  tempoBpm: number,
  tempoSegments: ReadonlyArray<TempoSegment>,
): { start: number; end: number } {
  const lengthPpq = onePassLengthPpq(clip);
  const segments = warpSegments({ ...clip, lengthPpq });
  if (segments.length > 0) {
    const last = segments[segments.length - 1];
    const start = Math.min(
      sourceFrames,
      Math.max(0, Math.round(segments[0].sourceStartSeconds * sampleRate)),
    );
    const endSeconds = last.sourceStartSeconds + last.sourceLengthSeconds;
    return {
      start,
      end: Math.min(sourceFrames, Math.max(start, Math.round(endSeconds * sampleRate))),
    };
  }
  return audioClipWindowFrames(
    sourceFrames,
    sampleRate,
    clip.sourceOffsetPpq,
    lengthPpq,
    normalizeTempoMap(tempoSegments, tempoBpm),
    clip.startPpq - clip.sourceOffsetPpq,
  );
}

/** One pass of a clip's source material as mono, with the frames it was cut from. */
export interface ClipSourceWindowMono {
  mono: Float32Array;
  sampleRate: number;
  /** First asset frame of the window; detector seconds are relative to it. */
  start: number;
  end: number;
}

/**
 * Downmixes the source material one pass of a clip reads (see
 * {@link clipSourceWindowFrames}), for detectors that analyse the recording
 * itself rather than the rendered clip.
 */
export function clipSourceWindowMono(
  clip: ClipSourceWindowFields,
  asset: LoadedAudioAsset,
  tempoBpm: number,
  tempoSegments: ReadonlyArray<TempoSegment>,
): ClipSourceWindowMono {
  const sampleRate = asset.meta.sampleRate;
  const window = clipSourceWindowFrames(
    clip,
    asset.channels[0]?.length ?? 0,
    sampleRate,
    tempoBpm,
    tempoSegments,
  );
  const mono = downmixToMono(
    asset.channels.map((channel) => channel.slice(window.start, window.end)),
  );
  return { mono, sampleRate, ...window };
}
