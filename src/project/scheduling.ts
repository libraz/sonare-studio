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
import { type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import { type AudioClipSegment, audioClipSegments, type CompableClipFields } from './comping';
import { audibleMidiProjector } from './midi-projection';
import { useProjectStore } from './store';
import {
  type NormalizedTempoMap,
  normalizeTempoMap,
  ppqDurationSamples,
  ppqToSamples,
} from './tempo-map';
import type { ClipTake, ClipWarp, EditorNote, EditorTrack } from './types';
import { clipKind } from './types';
import { bakeWarpedClip, type StretchFn } from './warp';

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
 * Converts a PPQ span to seconds at a constant tempo.
 *
 * @param ppq Span in quarter-note PPQ.
 * @param tempoBpm Tempo in BPM (> 0).
 * @returns Span in seconds.
 */
export function ppqToSeconds(ppq: number, tempoBpm: number): number {
  return (ppq * 60) / tempoBpm;
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
  const frames = channels[0]?.length ?? 0;
  const startFrame =
    typeof tempo === 'number'
      ? Math.round(ppqToSeconds(sourceOffsetPpq, tempo) * sampleRate)
      : ppqToSamples(tempo, timelineOriginPpq + sourceOffsetPpq, sampleRate) -
        ppqToSamples(tempo, timelineOriginPpq, sampleRate);
  const endFrame =
    typeof tempo === 'number'
      ? startFrame + Math.round(ppqToSeconds(lengthPpq, tempo) * sampleRate)
      : ppqToSamples(tempo, timelineOriginPpq + sourceOffsetPpq + lengthPpq, sampleRate) -
        ppqToSamples(tempo, timelineOriginPpq, sampleRate);
  const start = Math.min(frames, Math.max(0, startFrame));
  const end = Math.min(frames, Math.max(start, endFrame));
  return channels.map((channel) => channel.slice(start, end));
}

/**
 * Applies linear fade-in/fade-out ramps to the buffer edges in place.
 *
 * The engine clip options for fades are not part of the typed API, so fades
 * are baked into the scheduled buffer instead: the first fade-in frame is
 * silent and the ramp reaches unity right after the fade (multiplier i/n for
 * frame i of n); the fade-out mirrors that (the last frame is silent). Fades
 * longer than the buffer are clamped to its length.
 *
 * @param channels Planar buffers to modify (typically fresh slices).
 * @param sampleRate Buffer sample rate in Hz.
 * @param tempoBpm Tempo used to convert fade PPQ to time.
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
  const inFrames = Math.min(
    frames,
    Math.max(
      0,
      typeof tempo === 'number'
        ? Math.round(ppqToSeconds(fadeInPpq, tempo) * sampleRate)
        : ppqDurationSamples(tempo, timelineStartPpq, fadeInPpq, sampleRate),
    ),
  );
  const outFrames = Math.min(
    frames,
    Math.max(
      0,
      typeof tempo === 'number'
        ? Math.round(ppqToSeconds(fadeOutPpq, tempo) * sampleRate)
        : ppqDurationSamples(
            tempo,
            timelineStartPpq + Math.max(0, (timelineLengthPpq ?? fadeOutPpq) - fadeOutPpq),
            fadeOutPpq,
            sampleRate,
          ),
    ),
  );
  for (const channel of channels) {
    for (let i = 0; i < inFrames; i++) {
      channel[i] *= i / inFrames;
    }
    for (let i = 0; i < outFrames; i++) {
      channel[frames - 1 - i] *= i / outFrames;
    }
  }
  return channels;
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
 * Renders one segment from {@link audioClipSegments}. Warp-enabled segments
 * receive a derived clip window whose source and target coordinates describe
 * that occurrence only; this prevents a loop repeat from baking the original
 * full clip and lets every occurrence follow the tempo map at its own
 * timeline position. Whole-clip fades remain attached only to the first/last
 * segment by `audioClipSegments`.
 */
export async function renderAudioClipSegment(
  asset: LoadedAudioAsset,
  clip: SegmentRenderableAudioClip,
  segment: AudioClipSegment,
  tempo: AudioClipSliceTempo,
  fadeTempo: AudioClipSliceTempo = tempo,
  options: { stretch?: StretchFn } = {},
): Promise<Float32Array[]> {
  const timelineStartPpq = clip.startPpq + segment.offsetPpq;
  const sourceTimelineOriginPpq = timelineStartPpq - segment.sourceOffsetPpq;
  let channels =
    clip.warp?.enabled && (clip.takes?.length ?? 0) === 0
      ? await bakeWarpedClip(
          asset.channels,
          asset.meta.sampleRate,
          {
            ...(clip.id !== undefined ? { id: clip.id } : {}),
            startPpq: clip.startPpq + segment.offsetPpq,
            lengthPpq: segment.lengthPpq,
            sourceOffsetPpq: segment.sourceOffsetPpq,
            warp: clip.warp,
          },
          tempo,
          { cacheKey: segment.assetId, stretch: options.stretch },
        )
      : sliceAudioClipWindow(
          asset.channels,
          asset.meta.sampleRate,
          segment.sourceOffsetPpq,
          segment.lengthPpq,
          tempo,
          sourceTimelineOriginPpq,
        );
  channels = applyAudioClipFades(
    channels,
    asset.meta.sampleRate,
    fadeTempo,
    segment.fadeInPpq,
    segment.fadeOutPpq,
    timelineStartPpq,
    segment.lengthPpq,
  );
  return channels;
}

/** Clip fields needed to render the complete audible clip-local window. */
export type AudibleAudioClipFields = SegmentRenderableAudioClip & CompableClipFields;

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
    ? Math.max(0, Math.round(ppqToSeconds(lengthPpq, tempo) * sampleRate))
    : Math.max(0, ppqDurationSamples(tempo, startPpq, lengthPpq, sampleRate));
}

/**
 * Renders the complete audible content of one audio clip into a contiguous
 * clip-local buffer. This is the clip-DSP seam shared with live/export:
 * take/comp selection, loop occurrences, warp, source windows, fades and the
 * project tempo map all flow through `audioClipSegments` and
 * `renderAudioClipSegment` before the segments are summed.
 */
export async function renderAudibleAudioClipWindow(
  clip: AudibleAudioClipFields,
  tempo: AudioClipSliceTempo,
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>,
  options: { stretch?: StretchFn } = {},
): Promise<RenderedAudibleAudioClip | null> {
  if (!(clip.lengthPpq > 0) || (typeof tempo === 'number' && !(tempo > 0))) return null;
  const segments = audioClipSegments(clip);
  if (segments.length === 0) return null;
  const renderedAssets = await Promise.all(
    segments.map(async (segment) => ({ segment, asset: await loadAudioAsset(segment.assetId) })),
  );
  const sampleRate = renderedAssets[0]?.asset.meta.sampleRate ?? 0;
  if (!(sampleRate > 0)) return null;
  const frames = audioSpanSamples(tempo, clip.startPpq, clip.lengthPpq, sampleRate);
  const channelCount = renderedAssets.reduce(
    (count, entry) => Math.max(count, entry.asset.channels.length),
    0,
  );
  if (frames === 0 || channelCount === 0) return null;
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  let renderedAnyFrames = false;

  for (const { segment, asset } of renderedAssets) {
    let segmentChannels = await renderAudioClipSegment(asset, clip, segment, tempo, tempo, options);
    segmentChannels = resampleChannelsLinear(segmentChannels, asset.meta.sampleRate, sampleRate);
    const destinationStart = audioSpanSamples(tempo, clip.startPpq, segment.offsetPpq, sampleRate);
    const available = Math.max(
      0,
      Math.min(segmentChannels[0]?.length ?? 0, frames - destinationStart),
    );
    if (available === 0) continue;
    renderedAnyFrames = true;
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const source =
        segmentChannels[channelIndex] ??
        (segmentChannels.length === 1 ? segmentChannels[0] : undefined);
      if (!source) continue;
      const destination = channels[channelIndex];
      for (let frame = 0; frame < available; frame += 1) {
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
}

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
}

interface PreparedProjectClip {
  channels: Float32Array[];
  clipId: number;
  gain: number;
  startPpq: number;
  trackId: number;
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
 * missing or unreadable are skipped silently.
 *
 * The legacy track.pan field is not applied. Clip looping is expanded by
 * `audioClipSegments`; warp repeats are rendered as segment-scoped windows.
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
  const targetRate = options.sampleRate ?? handle.ctx.sampleRate;
  const prepared: PreparedProjectClip[] = [];

  // Preparation performs every fallible asynchronous asset conversion before
  // mutating the live engine, keeping the following commit phase short.
  for (const track of store.tracks) {
    // Frozen tracks play their baked pre-fader render from the timeline
    // start instead of their own clips (which stay silent until unfreeze).
    if (track.frozen !== undefined) {
      let asset: LoadedAudioAsset;
      try {
        asset = await loadAudio(track.frozen.assetId);
      } catch {
        // Missing or unreadable frozen asset: the track stays silent.
        continue;
      }
      const channels = resampleChannelsLinear(
        asset.channels.map((channel) => channel.slice()),
        asset.meta.sampleRate,
        targetRate,
      );
      if (channels.length > 0 && channels[0].length > 0) {
        prepared.push({ channels, clipId: -track.id, gain: 1, startPpq: 0, trackId: track.id });
      }
      continue;
    }
    const clips = store.clips.filter((clip) => clip.trackId === track.id);
    for (const clip of clips) {
      if (clipKind(clip) !== 'audio') continue;
      const gain = clip.gain;
      if (gain <= 0) continue;
      // A clip expands to one engine clip per comp segment (one segment for
      // clips without takes); each slice loads its segment's asset.
      for (const segment of audioClipSegments(clip)) {
        let asset: LoadedAudioAsset;
        try {
          asset = await loadAudio(segment.assetId);
        } catch {
          // Missing or unreadable asset: leave the slice silent.
          continue;
        }
        let channels = await renderAudioClipSegment(asset, clip, segment, tempoMap);
        channels = resampleChannelsLinear(channels, asset.meta.sampleRate, targetRate);
        if (channels.length === 0 || channels[0].length === 0) continue;
        prepared.push({
          channels,
          clipId: clip.id,
          gain,
          startPpq: clip.startPpq + segment.offsetPpq,
          trackId: track.id,
        });
      }
    }
  }

  const scheduled: ScheduledProjectClip[] = [];
  try {
    for (const clip of prepared) {
      const engineClipId = handle.engine.addClip(clip.trackId, clip.channels, clip.startPpq, {
        gain: clip.gain,
      });
      scheduled.push({ engineClipId, clipId: clip.clipId, trackId: clip.trackId });
    }
    return scheduled;
  } catch (error) {
    for (let index = scheduled.length - 1; index >= 0; index -= 1) {
      try {
        handle.engine.removeClip(scheduled[index].engineClipId);
      } catch {
        // Continue rolling back the remaining additions before surfacing the
        // original commit failure.
      }
    }
    throw error;
  }
}
