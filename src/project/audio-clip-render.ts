/**
 * Audio clip transforms shared by live scheduling, the offline export renderer
 * and clip analysis: source-window slicing, fades, resampling, per-segment
 * engine sources (plain or warped), and the complete audible clip-local render.
 */

import type { LoadedAudioAsset } from '@/persistence/assets';
import { type AudioClipSegment, audioClipSegments, type CompableClipFields } from './comping';
import {
  type NormalizedTempoMap,
  normalizeTempoMap,
  ppqDurationSamples,
  ppqToSamples,
} from './tempo-map';
import type { ClipTake, ClipWarp } from './types';
import {
  renderWarpedClipSource,
  type WarpAnchorFrames,
  type WarpRenderFn,
  warpedClipSource,
} from './warp';

/**
 * Converts a PPQ span to seconds at a constant tempo. Distinct from the
 * tempo-map `ppqToSeconds(map, ppq)`, which resolves an absolute position under
 * a variable-tempo map; this one takes a bare span and a single BPM.
 *
 * @param spanPpq Span in quarter-note PPQ.
 * @param tempoBpm Tempo in BPM (> 0).
 * @returns Span in seconds.
 */
export function ppqSpanToSeconds(spanPpq: number, tempoBpm: number): number {
  return (spanPpq * 60) / tempoBpm;
}

/** Tempo source used when cutting PPQ windows into audio-source frames. */
export type AudioClipSliceTempo = number | NormalizedTempoMap;

/**
 * Cuts an audio clip's source window out of the asset buffers: the window
 * [sourceOffsetPpq, sourceOffsetPpq + lengthPpq) is converted to frames at the
 * asset sample rate and sliced per channel, clamped to the available frames.
 * A constant BPM preserves the legacy conversion; a tempo map matches the
 * engine's variable-tempo PPQ-to-sample math.
 *
 * @param channels Planar asset channel buffers.
 * @param sampleRate Asset sample rate in Hz.
 * @param sourceOffsetPpq Offset of the clip window into the source, in PPQ.
 * @param lengthPpq Clip window length in PPQ.
 * @param tempo Tempo used to convert PPQ to source frames.
 * @returns One sliced copy per channel (possibly zero-length).
 */
export function sliceAudioClipWindow(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  sourceOffsetPpq: number,
  lengthPpq: number,
  tempo: AudioClipSliceTempo,
  timelineOriginPpq = 0,
): Float32Array[] {
  const { start, end } = audioClipWindowFrames(
    channels[0]?.length ?? 0,
    sampleRate,
    sourceOffsetPpq,
    lengthPpq,
    tempo,
    timelineOriginPpq,
  );
  return channels.map((channel) => channel.slice(start, end));
}

/**
 * Frame range of an audio clip's source window, as {@link sliceAudioClipWindow}
 * would cut it. Reading a clip's audio straight out of its stored asset (rather
 * than slicing a decoded copy) needs the same range, and a second derivation
 * would be free to drift from the one playback uses.
 *
 * @param sourceFrames Frames available in the source asset.
 * @param sampleRate Asset sample rate in Hz.
 * @param sourceOffsetPpq Offset of the clip window into the source, in PPQ.
 * @param lengthPpq Clip window length in PPQ.
 * @param tempo Tempo used to convert PPQ to source frames.
 * @param timelineOriginPpq Project PPQ the source window's origin sits at.
 * @returns Half-open `[start, end)` clamped into the available frames.
 */
export function audioClipWindowFrames(
  sourceFrames: number,
  sampleRate: number,
  sourceOffsetPpq: number,
  lengthPpq: number,
  tempo: AudioClipSliceTempo,
  timelineOriginPpq = 0,
): { start: number; end: number } {
  const startFrame =
    typeof tempo === 'number'
      ? Math.round(ppqSpanToSeconds(sourceOffsetPpq, tempo) * sampleRate)
      : ppqToSamples(tempo, timelineOriginPpq + sourceOffsetPpq, sampleRate) -
        ppqToSamples(tempo, timelineOriginPpq, sampleRate);
  const endFrame =
    typeof tempo === 'number'
      ? startFrame + Math.round(ppqSpanToSeconds(lengthPpq, tempo) * sampleRate)
      : ppqToSamples(tempo, timelineOriginPpq + sourceOffsetPpq + lengthPpq, sampleRate) -
        ppqToSamples(tempo, timelineOriginPpq, sampleRate);
  const start = Math.min(sourceFrames, Math.max(0, startFrame));
  return { start, end: Math.min(sourceFrames, Math.max(start, endFrame)) };
}

/**
 * Fade lengths of a clip window, in frames. The ramps are the engine's clip
 * fades: frame i of an n-frame fade-in is scaled by i/n, and the fade-out
 * mirrors it so the last frame is silent. A rounded one-frame fade cannot form
 * a ramp and would silence a clip edge, so it counts as none; fades are
 * clamped to the window.
 */
function audioClipFadeFrames(
  frames: number,
  sampleRate: number,
  tempo: AudioClipSliceTempo,
  fadeInPpq: number,
  fadeOutPpq: number,
  timelineStartPpq = 0,
  timelineLengthPpq?: number,
): { fadeInFrames: number; fadeOutFrames: number } {
  const inFrames = Math.min(
    frames,
    Math.max(
      0,
      typeof tempo === 'number'
        ? Math.round(ppqSpanToSeconds(fadeInPpq, tempo) * sampleRate)
        : ppqDurationSamples(tempo, timelineStartPpq, fadeInPpq, sampleRate),
    ),
  );
  const outFrames = Math.min(
    frames,
    Math.max(
      0,
      typeof tempo === 'number'
        ? Math.round(ppqSpanToSeconds(fadeOutPpq, tempo) * sampleRate)
        : ppqDurationSamples(
            tempo,
            timelineStartPpq + Math.max(0, (timelineLengthPpq ?? fadeOutPpq) - fadeOutPpq),
            fadeOutPpq,
            sampleRate,
          ),
    ),
  );
  return {
    fadeInFrames: inFrames > 1 ? inFrames : 0,
    fadeOutFrames: outFrames > 1 ? outFrames : 0,
  };
}

/** Applies fade ramps of the given frame counts to the buffer edges in place. */
function applyFadeFrames(
  channels: Float32Array[],
  fadeInFrames: number,
  fadeOutFrames: number,
): Float32Array[] {
  const frames = channels[0]?.length ?? 0;
  for (const channel of channels) {
    for (let i = 0; i < Math.min(fadeInFrames, frames); i++) channel[i] *= i / fadeInFrames;
    for (let i = 0; i < Math.min(fadeOutFrames, frames); i++) {
      channel[frames - 1 - i] *= i / fadeOutFrames;
    }
  }
  return channels;
}

/**
 * Applies linear fade-in/fade-out ramps to the buffer edges in place, with the
 * lengths and ramp shape of {@link audioClipFadeFrames}.
 *
 * @param channels Planar buffers to modify (typically fresh slices).
 * @param sampleRate Buffer sample rate in Hz.
 * @param tempo Tempo (or map) used to convert fade PPQ to time.
 * @param fadeInPpq Fade-in length in PPQ (0 = none).
 * @param fadeOutPpq Fade-out length in PPQ (0 = none).
 * @returns The same channel array, for chaining.
 */
export function applyAudioClipFades(
  channels: Float32Array[],
  sampleRate: number,
  tempo: AudioClipSliceTempo,
  fadeInPpq: number,
  fadeOutPpq: number,
  timelineStartPpq = 0,
  timelineLengthPpq?: number,
): Float32Array[] {
  const frames = channels[0]?.length ?? 0;
  if (frames === 0) return channels;
  const { fadeInFrames, fadeOutFrames } = audioClipFadeFrames(
    frames,
    sampleRate,
    tempo,
    fadeInPpq,
    fadeOutPpq,
    timelineStartPpq,
    timelineLengthPpq,
  );
  return applyFadeFrames(channels, fadeInFrames, fadeOutFrames);
}

/**
 * Linearly resamples planar buffers to a new sample rate (endpoint-preserving
 * interpolation). Adequate for playback-rate matching; offline DSP-grade
 * resampling is out of scope here.
 *
 * @param channels Planar buffers at `sourceRate`.
 * @param sourceRate Source sample rate in Hz (> 0).
 * @param targetRate Target sample rate in Hz (> 0).
 * @returns New planar buffers at `targetRate` (the input when rates match).
 */
export function resampleChannelsLinear(
  channels: Float32Array[],
  sourceRate: number,
  targetRate: number,
): Float32Array[] {
  if (sourceRate === targetRate) return channels;
  if (
    !Number.isFinite(sourceRate) ||
    sourceRate <= 0 ||
    !Number.isFinite(targetRate) ||
    targetRate <= 0
  ) {
    throw new RangeError(`Sample rates must be finite and > 0, got ${sourceRate} -> ${targetRate}`);
  }
  return channels.map((channel) => {
    const frames = channel.length;
    if (frames === 0) return new Float32Array(0);
    const outFrames = Math.max(1, Math.round((frames * targetRate) / sourceRate));
    const out = new Float32Array(outFrames);
    if (outFrames === 1 || frames === 1) {
      out.fill(channel[0]);
      return out;
    }
    const step = (frames - 1) / (outFrames - 1);
    for (let i = 0; i < outFrames; i++) {
      const pos = i * step;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const next = Math.min(frames - 1, idx + 1);
      out[i] = channel[idx] + (channel[next] - channel[idx]) * frac;
    }
    return out;
  });
}

/** Clip fields needed to render one segment for live playback or export. */
export interface SegmentRenderableAudioClip {
  id?: number;
  startPpq: number;
  lengthPpq: number;
  sourceOffsetPpq: number;
  warp?: ClipWarp;
  takes?: ReadonlyArray<ClipTake>;
}

/**
 * One audio clip segment as the engine plays it. A plain segment carries its
 * sliced window; a warped one carries the source slice and the anchors the
 * engine time-stretches it by. Fades are engine clip fades, in output frames.
 */
export interface AudioClipSegmentSource {
  channels: Float32Array[];
  sampleRate: number;
  /** Output frames the segment plays for. */
  lengthFrames: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  /** Present for a warped segment: output frame -> source frame, strictly increasing. */
  warpAnchors?: WarpAnchorFrames[];
}

/**
 * Resolves one segment from {@link audioClipSegments} into what the engine
 * plays. A warped segment gets a window derived for that occurrence only, so a
 * loop repeat follows the tempo map at its own timeline position. Whole-clip
 * fades stay attached only to the first/last segment by `audioClipSegments`.
 */
export function audioClipSegmentSource(
  asset: LoadedAudioAsset,
  clip: SegmentRenderableAudioClip,
  segment: AudioClipSegment,
  tempo: AudioClipSliceTempo,
  fadeTempo: AudioClipSliceTempo = tempo,
): AudioClipSegmentSource {
  const sampleRate = asset.meta.sampleRate;
  const timelineStartPpq = clip.startPpq + segment.offsetPpq;
  const warped =
    clip.warp?.enabled && (clip.takes?.length ?? 0) === 0
      ? warpedClipSource(
          asset.channels,
          sampleRate,
          {
            ...(clip.id !== undefined ? { id: clip.id } : {}),
            startPpq: timelineStartPpq,
            lengthPpq: segment.lengthPpq,
            sourceOffsetPpq: segment.sourceOffsetPpq,
            warp: clip.warp,
          },
          tempo,
        )
      : undefined;
  const channels =
    warped === undefined
      ? sliceAudioClipWindow(
          asset.channels,
          sampleRate,
          segment.sourceOffsetPpq,
          segment.lengthPpq,
          tempo,
          timelineStartPpq - segment.sourceOffsetPpq,
        )
      : (warped?.channels ?? []);
  const lengthFrames =
    warped === undefined ? (channels[0]?.length ?? 0) : (warped?.lengthFrames ?? 0);
  return {
    channels,
    sampleRate,
    lengthFrames,
    ...audioClipFadeFrames(
      lengthFrames,
      sampleRate,
      fadeTempo,
      segment.fadeInPpq,
      segment.fadeOutPpq,
      timelineStartPpq,
      segment.lengthPpq,
    ),
    ...(warped ? { warpAnchors: warped.anchors } : {}),
  };
}

/**
 * The same segment at another sample rate, given its channels already
 * resampled to that rate: frame counts and anchors scale with the rate.
 */
export function audioClipSegmentSourceAtRate(
  source: AudioClipSegmentSource,
  channels: Float32Array[],
  sampleRate: number,
): AudioClipSegmentSource {
  if (sampleRate === source.sampleRate) return { ...source, channels };
  const ratio = sampleRate / source.sampleRate;
  const scale = (frames: number): number => Math.round(frames * ratio);
  const sourceFrames = channels[0]?.length ?? 0;
  const lengthFrames = source.warpAnchors ? scale(source.lengthFrames) : (channels[0]?.length ?? 0);
  const scaled: AudioClipSegmentSource = {
    channels,
    sampleRate,
    lengthFrames,
    fadeInFrames: Math.min(lengthFrames, scale(source.fadeInFrames)),
    fadeOutFrames: Math.min(lengthFrames, scale(source.fadeOutFrames)),
  };
  if (source.warpAnchors) {
    const anchors: WarpAnchorFrames[] = [];
    for (const anchor of source.warpAnchors) {
      const next = {
        warpSample: Math.min(lengthFrames, scale(anchor.warpSample)),
        sourceSample: Math.min(sourceFrames, scale(anchor.sourceSample)),
      };
      const previous = anchors[anchors.length - 1];
      if (
        previous &&
        (next.warpSample <= previous.warpSample || next.sourceSample <= previous.sourceSample)
      ) {
        continue;
      }
      anchors.push(next);
    }
    scaled.warpAnchors = anchors;
  }
  return scaled;
}

/** Engine clip fields that play a segment source (length, fades and warp). */
export function engineClipPlayback(source: AudioClipSegmentSource): {
  lengthSamples: number;
  fadeInSamples: number;
  fadeOutSamples: number;
  warpMode?: 'timeStretch';
  warpAnchors?: WarpAnchorFrames[];
} {
  return {
    lengthSamples: source.lengthFrames,
    fadeInSamples: source.fadeInFrames,
    fadeOutSamples: source.fadeOutFrames,
    ...(source.warpAnchors && source.warpAnchors.length >= 2
      ? { warpMode: 'timeStretch' as const, warpAnchors: source.warpAnchors }
      : {}),
  };
}

/**
 * Renders one segment from {@link audioClipSegments} to PCM with its fades,
 * for offline consumers; a warped segment renders through the engine's
 * time-stretch mode so it matches playback.
 */
async function renderAudioClipSegment(
  asset: LoadedAudioAsset,
  clip: SegmentRenderableAudioClip,
  segment: AudioClipSegment,
  tempo: AudioClipSliceTempo,
  fadeTempo: AudioClipSliceTempo = tempo,
  options: { renderWarp?: WarpRenderFn } = {},
): Promise<Float32Array[]> {
  const source = audioClipSegmentSource(asset, clip, segment, tempo, fadeTempo);
  if (source.lengthFrames === 0) return [];
  const channels = source.warpAnchors
    ? await (options.renderWarp ?? renderWarpedClipSource)(
        {
          channels: source.channels,
          lengthFrames: source.lengthFrames,
          anchors: source.warpAnchors,
        },
        source.sampleRate,
      )
    : source.channels;
  return applyFadeFrames(channels, source.fadeInFrames, source.fadeOutFrames);
}

/** Clip fields needed to render the complete audible clip-local window. */
export type AudibleAudioClipFields = SegmentRenderableAudioClip & CompableClipFields;

/** A frame range of the clip-local buffer, so a long clip can be rendered a piece at a time. */
export interface AudibleClipFrameWindow {
  startFrame: number;
  frameCount: number;
}

/** Complete, transform-baked clip content ready for clip-level offline DSP. */
export interface RenderedAudibleAudioClip {
  channels: Float32Array[];
  sampleRate: number;
}

function audioSpanSamples(
  tempo: AudioClipSliceTempo,
  startPpq: number,
  lengthPpq: number,
  sampleRate: number,
): number {
  return typeof tempo === 'number'
    ? Math.max(0, Math.round(ppqSpanToSeconds(lengthPpq, tempo) * sampleRate))
    : Math.max(0, ppqDurationSamples(tempo, startPpq, lengthPpq, sampleRate));
}

/**
 * Renders the complete audible content of one audio clip into a contiguous
 * clip-local buffer. This is the clip-DSP seam shared with live/export:
 * take/comp selection, loop occurrences, warp, source windows, fades and the
 * project tempo map all flow through `audioClipSegments` and
 * `renderAudioClipSegment` before the segments are summed. `window` limits the
 * output buffer to a frame range of that same clip-local timeline.
 */
export async function renderAudibleAudioClipWindow(
  clip: AudibleAudioClipFields,
  tempo: AudioClipSliceTempo,
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>,
  options: { renderWarp?: WarpRenderFn; window?: AudibleClipFrameWindow } = {},
): Promise<RenderedAudibleAudioClip | null> {
  if (!(clip.lengthPpq > 0) || (typeof tempo === 'number' && !(tempo > 0))) return null;
  const tempoMap =
    typeof tempo === 'number' ? normalizeTempoMap([{ startPpq: 0, bpm: tempo }], tempo) : tempo;
  const segments = audioClipSegments(clip, { tempoMap, clipStartPpq: clip.startPpq });
  if (segments.length === 0) return null;
  const renderedAssets = await Promise.all(
    segments.map(async (segment) => ({ segment, asset: await loadAudioAsset(segment.assetId) })),
  );
  const sampleRate = renderedAssets[0]?.asset.meta.sampleRate ?? 0;
  if (!(sampleRate > 0)) return null;
  const clipFrames = audioSpanSamples(tempo, clip.startPpq, clip.lengthPpq, sampleRate);
  const windowStart = Math.min(clipFrames, Math.max(0, options.window?.startFrame ?? 0));
  const frames = Math.min(clipFrames - windowStart, options.window?.frameCount ?? clipFrames);
  const channelCount = renderedAssets.reduce(
    (count, entry) => Math.max(count, entry.asset.channels.length),
    0,
  );
  if (frames <= 0 || channelCount === 0) return null;
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  let renderedAnyFrames = false;

  for (const { segment, asset } of renderedAssets) {
    const destinationStart =
      audioSpanSamples(tempo, clip.startPpq, segment.offsetPpq, sampleRate) - windowStart;
    const segmentEnd =
      destinationStart +
      audioSpanSamples(tempo, clip.startPpq + segment.offsetPpq, segment.lengthPpq, sampleRate);
    // A segment wholly outside the window is never rendered.
    if (destinationStart >= frames || segmentEnd <= 0) continue;
    let segmentChannels = await renderAudioClipSegment(asset, clip, segment, tempo, tempo, options);
    segmentChannels = resampleChannelsLinear(segmentChannels, asset.meta.sampleRate, sampleRate);
    const firstFrame = Math.max(0, -destinationStart);
    const available = Math.max(
      0,
      Math.min(segmentChannels[0]?.length ?? 0, frames - destinationStart),
    );
    if (available <= firstFrame) continue;
    renderedAnyFrames = true;
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const source =
        segmentChannels[channelIndex] ??
        (segmentChannels.length === 1 ? segmentChannels[0] : undefined);
      if (!source) continue;
      const destination = channels[channelIndex];
      for (let frame = firstFrame; frame < available; frame += 1) {
        destination[destinationStart + frame] += source[frame] ?? 0;
      }
    }
  }
  return renderedAnyFrames ? { channels, sampleRate } : null;
}
