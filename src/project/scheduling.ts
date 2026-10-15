/**
 * Project-wide playback scheduling: loads and schedules every audio clip of
 * every track into the engine. MIDI clips and instruments are realtime engine
 * state, fed by the engine's MIDI scheduling (src/engine/midi-sync.ts) and not
 * scheduled here.
 *
 * Clips are scheduled raw: track strips (inserts/EQ), gain/pan, solo/mute,
 * sends/buses and the master strip are realtime engine mixer state, applied
 * without re-scheduling. The offline export renderer
 * (src/export/engine-render.ts) reuses the same clip transforms and drives
 * an offline engine instance, so exports apply identical mixer state.
 *
 * Nothing here produces sound by itself: engine.addClip only places content
 * on the engine timeline, which stays silent until the transport plays.
 */

import type { EngineHandle } from '@/engine/engine';
import type { MidiNote } from '@/engine/instruments';
import { PayloadMemoryLimitError } from '@/lib/payload-memory';
import {
  type AudioAssetMeta,
  type LoadedAudioAsset,
  loadAsset,
  loadAssetMeta,
} from '@/persistence/assets';
import { type AudioClipSegment, audioClipSegments, type CompableClipFields } from './comping';
import type { MediaCompletenessIssue } from './media-completeness';
import { audibleMidiProjector } from './midi-projection';
import { useProjectStore } from './store';
import {
  type NormalizedTempoMap,
  normalizeTempoMap,
  ppqDurationSamples,
  ppqToSamples,
} from './tempo-map';
import type { ClipTake, ClipWarp, EditorClip, EditorNote, EditorTrack } from './types';
import { clipKind } from './types';
import {
  renderWarpedClipSource,
  type WarpAnchorFrames,
  type WarpRenderFn,
  warpedClipSource,
} from './warp';

/** The mute/solo subset of a track relevant to audibility. */
export type TrackAudibilityState = Pick<EditorTrack, 'mute' | 'solo' | 'soloSafe'>;

/**
 * Optional group-membership hooks used to expand a soloed folder/submix track
 * to the member lanes whose audio actually feeds that group.
 */
export interface TrackSoloExpansionOptions<T extends TrackAudibilityState> {
  /** True when the track is a folder/submix group track. */
  isGroup?: (track: T, index: number) => boolean;
  /** Stable key identifying a group track. */
  groupKey?: (track: T, index: number) => number | string | undefined;
  /** Stable key of the group this member routes into, if any. */
  memberGroupKey?: (track: T, index: number) => number | string | undefined;
}

/**
 * Computes the effective solo group after expanding soloed group tracks to
 * their routed members and adding solo-safe lanes while any solo is active.
 *
 * @param tracks All tracks in project/lane order.
 * @param options Optional group membership extractors.
 * @returns One effective solo flag per track index.
 */
export function expandedSoloStates<T extends TrackAudibilityState>(
  tracks: ReadonlyArray<T>,
  options: TrackSoloExpansionOptions<T> = {},
): boolean[] {
  const anySolo = tracks.some((track) => track.solo);
  const soloedGroups = new Set<number | string>();
  if (options.isGroup && options.groupKey) {
    tracks.forEach((track, index) => {
      if (!track.solo || !options.isGroup?.(track, index)) return;
      const key = options.groupKey?.(track, index);
      if (key !== undefined) soloedGroups.add(key);
    });
  }
  return tracks.map((track, index) => {
    const memberGroup = options.memberGroupKey?.(track, index);
    return (
      track.solo ||
      (memberGroup !== undefined && soloedGroups.has(memberGroup)) ||
      (anySolo && track.soloSafe === true)
    );
  });
}

/**
 * Decides whether a track is audible under the solo/mute rules: when any
 * track is soloed only soloed and solo-safe tracks play, and mute always
 * silences a track (mute wins over its own solo/solo-safe status).
 *
 * @param track Track to test.
 * @param tracks All tracks of the project (to detect active solos).
 * @returns True when the track's clips should be scheduled.
 */
export function isTrackAudible<T extends TrackAudibilityState>(
  track: T,
  tracks: ReadonlyArray<T>,
  options: TrackSoloExpansionOptions<T> = {},
): boolean {
  if (track.mute) return false;
  const anySolo = tracks.some((t) => t.solo);
  if (!anySolo) return true;
  const index = tracks.indexOf(track);
  return (expandedSoloStates(tracks, options)[index] ?? track.solo) || track.soloSafe === true;
}

/**
 * The note-window subset of a clip needed to derive its playback notes:
 * satisfied by editor mirror clips and by document clips alike.
 */
export interface ClipNoteWindow {
  /** Offset of the clip window into its source, in PPQ. */
  sourceOffsetPpq: number;
  /** Clip window length in PPQ. */
  lengthPpq: number;
  /** Source-relative note content. */
  notes: ReadonlyArray<Omit<EditorNote, 'id'>>;
}

/**
 * Extracts a clip's audible notes in clip-local PPQ: notes are stored in
 * source coordinates, so the clip window [sourceOffsetPpq, sourceOffsetPpq +
 * lengthPpq) is selected (by note start) and shifted to start at 0.
 *
 * @param clip Clip mirror or document entry.
 * @returns Engine-facing notes relative to the clip start.
 */
export function clipPlaybackNotes(clip: ClipNoteWindow): MidiNote[] {
  return audibleMidiProjector(
    { ...clip, startPpq: 0, loopEnabled: false, loopLengthPpq: 0 },
    { expandLoops: false },
  ).map((entry) => ({
    note: entry.note.pitch,
    velocity: entry.note.velocity,
    ...(entry.note.offVelocity !== undefined ? { offVelocity: entry.note.offVelocity } : {}),
    startPpq: entry.clipStartPpq,
    durationPpq: entry.durationPpq,
    channel: entry.note.channel,
  }));
}

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
export function audioClipFadeFrames(
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
  warpMode?: 'time-stretch';
  warpAnchors?: WarpAnchorFrames[];
} {
  return {
    lengthSamples: source.lengthFrames,
    fadeInSamples: source.fadeInFrames,
    fadeOutSamples: source.fadeOutFrames,
    ...(source.warpAnchors && source.warpAnchors.length >= 2
      ? { warpMode: 'time-stretch' as const, warpAnchors: source.warpAnchors }
      : {}),
  };
}

/**
 * Renders one segment from {@link audioClipSegments} to PCM with its fades,
 * for offline consumers; a warped segment renders through the engine's
 * time-stretch mode so it matches playback.
 */
export async function renderAudioClipSegment(
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

/** One clip scheduled by {@link scheduleProjectClips}. */
export interface ScheduledProjectClip {
  /** Engine clip id (pass to engine.removeClip to unschedule). */
  engineClipId: number;
  /** Project clip id the render came from. */
  clipId: number;
  /** Project track id the clip belongs to. */
  trackId: number;
  /** JS/WASM PCM payload represented by this scheduled clip. */
  payloadBytes?: number;
}

/** Peak budget for one decoded source asset + next schedule + old schedule. */
export const DEFAULT_LIVE_SCHEDULE_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;

/** Options for {@link scheduleProjectClips}. */
export interface ScheduleProjectClipsOptions {
  /** Render sample rate; defaults to the engine context rate. */
  sampleRate?: number;
  /** Tempo used for the bounce; defaults to the store's tempo. */
  tempoBpm?: number;
  /** Tempo map used by source-window slicing; defaults to the store map. */
  tempoSegments?: ReadonlyArray<{ startPpq: number; bpm: number; endBpm?: number }>;
  /**
   * Audio asset loader (defaults to the OPFS asset store's loadAsset).
   * Injectable for tests and alternative storage backends.
   */
  loadAudioAsset?: (assetId: string) => Promise<LoadedAudioAsset>;
  /** Metadata-only loader used for allocation-free memory preflight. */
  loadAudioAssetMeta?: (assetId: string) => Promise<AudioAssetMeta>;
  /** Maximum source/next/old schedule payload retained during replacement. */
  memoryBudgetBytes?: number;
  /** PCM bytes already owned by the schedule being replaced. */
  retainedScheduleBytes?: number;
  /**
   * The schedule being replaced. Clips whose rendered content and placement
   * are unchanged are carried into the result as-is instead of re-prepared;
   * pass the result to {@link replaceScheduledProjectClips} with the same
   * list. Overrides `retainedScheduleBytes` with the list's own payload size.
   */
  previous?: ReadonlyArray<ScheduledProjectClip>;
  /** Cancels preparation before any further load/render/live-engine mutation. */
  signal?: AbortSignal;
  /** Receives every skipped unreadable source with its track/clip identity. */
  onMediaIssue?: (issue: MediaCompletenessIssue) => void;
}

export interface AudioScheduleCleanupFailure {
  phase: 'previous' | 'rollback';
  clip: ScheduledProjectClip;
  error: unknown;
}

/** A failed replace retains exact ownership of every clip whose removal threw. */
export class AudioScheduleReplaceError extends Error {
  constructor(
    readonly ownedClips: ScheduledProjectClip[],
    readonly failures: AudioScheduleCleanupFailure[],
    readonly operationError?: unknown,
  ) {
    super(`Audio schedule replace failed to remove ${failures.length} engine clip(s)`, {
      ...(operationError !== undefined ? { cause: operationError } : {}),
    });
    this.name = 'AudioScheduleReplaceError';
  }
}

/** Best-effort cleanup that returns only clips still owned after a failed removal. */
export function cleanupScheduledProjectClips(
  handle: EngineHandle,
  clips: ReadonlyArray<ScheduledProjectClip>,
  phase: AudioScheduleCleanupFailure['phase'] = 'rollback',
): { remaining: ScheduledProjectClip[]; failures: AudioScheduleCleanupFailure[] } {
  const remaining: ScheduledProjectClip[] = [];
  const failures: AudioScheduleCleanupFailure[] = [];
  for (let index = clips.length - 1; index >= 0; index -= 1) {
    const clip = clips[index];
    try {
      handle.engine.removeClip(clip.engineClipId);
    } catch (error) {
      remaining.unshift(clip);
      failures.push({ phase, clip, error });
    }
  }
  return { remaining, failures };
}

/**
 * Replaces an already-added next schedule. Clips present in both lists stay in
 * the engine; only the stale previous clips are removed. On old-removal
 * failure it rolls back every newly added clip and throws with the exact
 * residual ownership set.
 */
export function replaceScheduledProjectClips(
  handle: EngineHandle,
  previous: ReadonlyArray<ScheduledProjectClip>,
  next: ReadonlyArray<ScheduledProjectClip>,
): ScheduledProjectClip[] {
  const nextIds = new Set(next.map((clip) => clip.engineClipId));
  const previousIds = new Set(previous.map((clip) => clip.engineClipId));
  const removedPrevious = cleanupScheduledProjectClips(
    handle,
    previous.filter((clip) => !nextIds.has(clip.engineClipId)),
    'previous',
  );
  if (removedPrevious.failures.length === 0) return [...next];
  const rolledBackNext = cleanupScheduledProjectClips(
    handle,
    next.filter((clip) => !previousIds.has(clip.engineClipId)),
    'rollback',
  );
  throw new AudioScheduleReplaceError(
    [
      ...removedPrevious.remaining,
      ...previous.filter((clip) => nextIds.has(clip.engineClipId)),
      ...rolledBackNext.remaining,
    ],
    [...removedPrevious.failures, ...rolledBackNext.failures],
  );
}

/**
 * Removes the clips of a superseded next schedule that the previous schedule
 * does not own, leaving carried-over clips in the engine.
 */
export function discardUnownedScheduledClips(
  handle: EngineHandle,
  previous: ReadonlyArray<ScheduledProjectClip>,
  next: ReadonlyArray<ScheduledProjectClip>,
): { remaining: ScheduledProjectClip[]; failures: AudioScheduleCleanupFailure[] } {
  const owned = new Set(previous.map((clip) => clip.engineClipId));
  return cleanupScheduledProjectClips(
    handle,
    next.filter((clip) => !owned.has(clip.engineClipId)),
  );
}

/** The engine's default and largest time-stretch voice pool. */
export const DEFAULT_WARP_VOICES = 8;
export const MAX_WARP_VOICES = 64;

interface PreparedProjectClip {
  channels: Float32Array[];
  clipId: number;
  gain: number;
  startPpq: number;
  trackId: number;
  /** Length, fades and warp the engine plays the channels with; absent = as-is. */
  playback?: ReturnType<typeof engineClipPlayback>;
}

function preparedClipBytes(channels: ReadonlyArray<Float32Array>): number {
  return channels.reduce((sum, channel) => sum + channel.byteLength, 0);
}

function assertLiveScheduleMemory(bytes: number, budgetBytes: number): void {
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
    throw new RangeError('Live audio schedule memory budget must be finite and greater than zero');
  }
  if (!Number.isSafeInteger(bytes) || bytes > budgetBytes) {
    throw new PayloadMemoryLimitError(
      'live-schedule',
      Number.isSafeInteger(bytes) ? bytes : Number.MAX_SAFE_INTEGER,
      budgetBytes,
    );
  }
}

/** Identity of a scheduled clip: what it was rendered from, and its warp use. */
interface ScheduledClipOrigin {
  key: string;
  warped: boolean;
}

const scheduledClipOrigins = new WeakMap<ScheduledProjectClip, ScheduledClipOrigin>();

/** One engine clip the schedule consists of: a clip segment or a frozen render. */
interface ScheduleUnit {
  /** Equal keys mean equal rendered content and placement. */
  key: string;
  track: EditorTrack;
  assetId: string;
  /** Absent for a frozen track's baked render. */
  clip?: EditorClip;
  segment?: AudioClipSegment;
}

/**
 * Enumerates the engine clips the project should have scheduled. The key
 * covers everything the render depends on (clip fields except its name, the
 * segment window, the tempo map and the engine rate).
 */
function* scheduleUnits(
  store: ReturnType<typeof useProjectStore>,
  tempoMap: NormalizedTempoMap,
  targetRate: number,
): Generator<ScheduleUnit> {
  const context = JSON.stringify([targetRate, tempoMap]);
  const clipsByTrack = new Map<number, EditorClip[]>();
  for (const clip of store.clips) {
    const list = clipsByTrack.get(clip.trackId);
    if (list) list.push(clip);
    else clipsByTrack.set(clip.trackId, [clip]);
  }
  for (const track of store.tracks) {
    // Frozen tracks play their baked pre-fader render from the timeline
    // start instead of their own clips (which stay silent until unfreeze).
    if (track.frozen !== undefined) {
      yield {
        key: `${context}|frozen|${track.id}|${track.frozen.assetId}`,
        track,
        assetId: track.frozen.assetId,
      };
      continue;
    }
    for (const clip of clipsByTrack.get(track.id) ?? []) {
      if (clipKind(clip) !== 'audio' || clip.gain <= 0) continue;
      const { name: _name, ...content } = clip;
      const clipKey = `${context}|${JSON.stringify(content)}`;
      // A clip expands to one engine clip per comp segment (one segment for
      // clips without takes); each slice loads its segment's asset.
      for (const segment of audioClipSegments(clip, { tempoMap, clipStartPpq: clip.startPpq })) {
        yield {
          key: `${clipKey}|${JSON.stringify(segment)}`,
          track,
          assetId: segment.assetId,
          clip,
          segment,
        };
      }
    }
  }
}

async function preflightLiveScheduleMemory(
  units: ReadonlyArray<ScheduleUnit>,
  tempoMap: NormalizedTempoMap,
  targetRate: number,
  loadMeta: (assetId: string) => Promise<AudioAssetMeta>,
  signal?: AbortSignal,
): Promise<{ sourceBytes: number; preparedBytes: number }> {
  const metas = new Map<string, AudioAssetMeta | null>();
  // Sources load one at a time, so only the largest is resident at once.
  let sourceBytes = 0;
  let preparedBytes = 0;
  const metaFor = async (assetId: string): Promise<AudioAssetMeta | null> => {
    if (metas.has(assetId)) return metas.get(assetId) ?? null;
    signal?.throwIfAborted();
    try {
      const meta = await loadMeta(assetId);
      signal?.throwIfAborted();
      metas.set(assetId, meta);
      sourceBytes = Math.max(
        sourceBytes,
        meta.numFrames * meta.numChannels * Float32Array.BYTES_PER_ELEMENT,
      );
      return meta;
    } catch {
      if (signal?.aborted) signal.throwIfAborted();
      metas.set(assetId, null);
      return null;
    }
  };
  for (const unit of units) {
    signal?.throwIfAborted();
    const meta = await metaFor(unit.assetId);
    if (!meta) continue;
    if (unit.clip === undefined || unit.segment === undefined) {
      preparedBytes +=
        Math.round((meta.numFrames / meta.sampleRate) * targetRate) *
        meta.numChannels *
        Float32Array.BYTES_PER_ELEMENT;
      continue;
    }
    preparedBytes +=
      ppqDurationSamples(
        tempoMap,
        unit.clip.startPpq + unit.segment.offsetPpq,
        unit.segment.lengthPpq,
        targetRate,
      ) *
      meta.numChannels *
      Float32Array.BYTES_PER_ELEMENT;
  }
  if (!Number.isSafeInteger(sourceBytes + preparedBytes)) {
    throw new PayloadMemoryLimitError('live-schedule', Number.MAX_SAFE_INTEGER, 1);
  }
  return { sourceBytes, preparedBytes };
}

/**
 * Schedules every audio clip of every track into the engine.
 *
 * MIDI clips are skipped entirely: MIDI content and instruments are realtime
 * engine state, fed by the engine's MIDI scheduling (src/engine/midi-sync.ts).
 *
 * All tracks are scheduled regardless of mute/solo, and clips are scheduled
 * raw: audibility, track volume, track strips (inserts/EQ), gain/pan,
 * sends/buses and the master strip are realtime engine mixer state, applied
 * by the engine without re-scheduling.
 *
 * Audio clips load their asset from the asset store, slice the source window
 * (sourceOffsetPpq/lengthPpq at the schedule tempo), bake fades into the
 * buffer edges, resample to the engine rate when needed, and are scheduled
 * with gain = clip gain — never loudness-normalized. Clips whose asset is
 * missing or unreadable are skipped and reported through `onMediaIssue`.
 *
 * The legacy track.pan field is not applied. Clip looping is expanded by
 * `audioClipSegments`; warp repeats are rendered as segment-scoped windows.
 *
 * With `options.previous`, clips whose content and placement did not change
 * are carried over without being loaded or re-rendered, and only the rest is
 * prepared. The returned list is the complete new schedule (carried-over and
 * new clips); hand it to {@link replaceScheduledProjectClips} together with
 * the previous list. Without it every clip is rendered and added.
 *
 * The caller owns unscheduling: keep the returned list and call
 * engine.removeClip(engineClipId) for each entry before re-scheduling.
 *
 * @param handle Running engine handle from createEngine.
 * @param options Optional render overrides.
 * @returns One entry per scheduled clip.
 */
export async function scheduleProjectClips(
  handle: EngineHandle,
  options: ScheduleProjectClipsOptions = {},
): Promise<ScheduledProjectClip[]> {
  const store = useProjectStore();
  const tempoBpm = options.tempoBpm ?? store.tempoBpm;
  const tempoMap = normalizeTempoMap(options.tempoSegments ?? store.tempoSegments, tempoBpm);
  const loadAudio = options.loadAudioAsset ?? loadAsset;
  const loadMeta =
    options.loadAudioAssetMeta ?? (options.loadAudioAsset === undefined ? loadAssetMeta : null);
  const targetRate = options.sampleRate ?? handle.ctx.sampleRate;
  const signal = options.signal;
  const budgetBytes = options.memoryBudgetBytes ?? DEFAULT_LIVE_SCHEDULE_MEMORY_BUDGET_BYTES;
  const retainedScheduleBytes = options.previous
    ? options.previous.reduce((sum, clip) => sum + (clip.payloadBytes ?? 0), 0)
    : (options.retainedScheduleBytes ?? 0);
  if (!Number.isSafeInteger(retainedScheduleBytes) || retainedScheduleBytes < 0) {
    throw new RangeError('Retained schedule bytes must be a non-negative safe integer');
  }

  // Carry over previous clips that still match a unit; the rest is prepared.
  const carryable = new Map<string, ScheduledProjectClip>();
  for (const clip of options.previous ?? []) {
    const origin = scheduledClipOrigins.get(clip);
    if (origin) carryable.set(origin.key, clip);
  }
  const units: ScheduleUnit[] = [];
  const carried = new Map<string, ScheduledProjectClip>();
  for (const unit of scheduleUnits(store, tempoMap, targetRate)) {
    const existing = carryable.get(unit.key);
    if (existing) {
      carryable.delete(unit.key);
      carried.set(unit.key, existing);
    }
    units.push(unit);
  }
  const pending = units.filter((unit) => !carried.has(unit.key));

  const prepared = new Map<string, PreparedProjectClip>();
  const preflight = loadMeta
    ? await preflightLiveScheduleMemory(pending, tempoMap, targetRate, loadMeta, signal)
    : null;
  if (preflight) {
    assertLiveScheduleMemory(
      retainedScheduleBytes + preflight.sourceBytes + preflight.preparedBytes,
      budgetBytes,
    );
  }
  // Sources load one at a time, so only the largest decoded one is resident.
  let actualSourcePeakBytes = 0;
  let actualPreparedBytes = 0;
  const accountAsset = (asset: LoadedAudioAsset): void => {
    actualSourcePeakBytes = Math.max(actualSourcePeakBytes, preparedClipBytes(asset.channels));
    if (!preflight) {
      assertLiveScheduleMemory(
        retainedScheduleBytes + actualSourcePeakBytes + actualPreparedBytes,
        budgetBytes,
      );
    }
  };
  const appendPrepared = (key: string, clip: PreparedProjectClip): void => {
    actualPreparedBytes += preparedClipBytes(clip.channels);
    assertLiveScheduleMemory(
      retainedScheduleBytes +
        (preflight?.sourceBytes ?? actualSourcePeakBytes) +
        actualPreparedBytes,
      budgetBytes,
    );
    prepared.set(key, clip);
  };
  signal?.throwIfAborted();

  // Preparation performs every fallible asynchronous asset conversion before
  // mutating the live engine, keeping the following commit phase short.
  for (const unit of pending) {
    signal?.throwIfAborted();
    const { track, clip, segment } = unit;
    if (clip === undefined || segment === undefined) {
      let asset: LoadedAudioAsset;
      try {
        asset = await loadAudio(unit.assetId);
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        options.onMediaIssue?.({
          kind: 'audio-asset',
          mediaId: unit.assetId,
          role: 'frozen',
          reason: 'unreadable',
          trackId: track.id,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      signal?.throwIfAborted();
      accountAsset(asset);
      const channels = resampleChannelsLinear(
        asset.channels.map((channel) => channel.slice()),
        asset.meta.sampleRate,
        targetRate,
      );
      if (channels.length > 0 && channels[0].length > 0) {
        appendPrepared(unit.key, {
          channels,
          clipId: -track.id,
          gain: 1,
          startPpq: 0,
          trackId: track.id,
        });
      }
      continue;
    }
    let asset: LoadedAudioAsset;
    try {
      asset = await loadAudio(segment.assetId);
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      options.onMediaIssue?.({
        kind: 'audio-asset',
        mediaId: segment.assetId,
        role: clip.takes?.some((take) => take.assetId === segment.assetId) ? 'take' : 'clip',
        reason: 'unreadable',
        trackId: track.id,
        clipId: clip.id,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    signal?.throwIfAborted();
    accountAsset(asset);
    const source = audioClipSegmentSource(asset, clip, segment, tempoMap);
    if (source.lengthFrames === 0 || (source.channels[0]?.length ?? 0) === 0) continue;
    const atRate = audioClipSegmentSourceAtRate(
      source,
      resampleChannelsLinear(source.channels, source.sampleRate, targetRate),
      targetRate,
    );
    appendPrepared(unit.key, {
      channels: atRate.channels,
      clipId: clip.id,
      gain: clip.gain,
      startPpq: clip.startPpq + segment.offsetPpq,
      trackId: track.id,
      playback: engineClipPlayback(atRate),
    });
  }

  // Every warped clip gets a stretch voice, up to the engine's ceiling.
  const warpedClips =
    [...prepared.values()].filter((clip) => clip.playback?.warpMode !== undefined).length +
    [...carried.values()].filter((clip) => scheduledClipOrigins.get(clip)?.warped).length;
  handle.engine.setWarpVoiceCapacity(
    Math.min(MAX_WARP_VOICES, Math.max(DEFAULT_WARP_VOICES, warpedClips)),
  );

  const added: ScheduledProjectClip[] = [];
  const schedule: ScheduledProjectClip[] = [];
  try {
    for (const unit of units) {
      const kept = carried.get(unit.key);
      if (kept) {
        schedule.push(kept);
        continue;
      }
      const clip = prepared.get(unit.key);
      if (!clip) continue;
      signal?.throwIfAborted();
      const engineClipId = handle.engine.addClip(clip.trackId, clip.channels, clip.startPpq, {
        gain: clip.gain,
        ...clip.playback,
      });
      const scheduledClip: ScheduledProjectClip = {
        engineClipId,
        clipId: clip.clipId,
        trackId: clip.trackId,
      };
      Object.defineProperty(scheduledClip, 'payloadBytes', {
        value: preparedClipBytes(clip.channels),
        enumerable: false,
      });
      scheduledClipOrigins.set(scheduledClip, {
        key: unit.key,
        warped: clip.playback?.warpMode !== undefined,
      });
      added.push(scheduledClip);
      schedule.push(scheduledClip);
    }
    return schedule;
  } catch (error) {
    const cleanup = cleanupScheduledProjectClips(handle, added);
    if (cleanup.failures.length > 0) {
      throw new AudioScheduleReplaceError(cleanup.remaining, cleanup.failures, error);
    }
    throw error;
  }
}
