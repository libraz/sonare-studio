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
 * Applies linear fade-in/fade-out ramps to the buffer edges in place.
 *
 * The engine clip options for fades are not part of the typed API, so fades
 * are baked into the scheduled buffer instead: the first fade-in frame is
 * silent and the ramp reaches unity right after the fade (multiplier i/n for
 * frame i of n); the fade-out mirrors that (the last frame is silent). A
 * rounded one-frame fade is treated as no fade: it cannot form a ramp and
 * would otherwise silence a clip edge. Fades longer than the buffer are
 * clamped to its length.
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
  if (inFrames > 1 || outFrames > 1) {
    for (const channel of channels) {
      if (inFrames > 1) {
        for (let i = 0; i < inFrames; i++) {
          channel[i] *= i / inFrames;
        }
      }
      if (outFrames > 1) {
        for (let i = 0; i < outFrames; i++) {
          channel[frames - 1 - i] *= i / outFrames;
        }
      }
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
    ? Math.max(0, Math.round(ppqSpanToSeconds(lengthPpq, tempo) * sampleRate))
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
  const tempoMap =
    typeof tempo === 'number' ? normalizeTempoMap([{ startPpq: 0, bpm: tempo }], tempo) : tempo;
  const segments = audioClipSegments(clip, { tempoMap, clipStartPpq: clip.startPpq });
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
  /** JS/WASM PCM payload represented by this scheduled clip. */
  payloadBytes?: number;
}

/** Peak budget for decoded source + next schedule + retained old schedule. */
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
 * Replaces an already-added next schedule. On old-removal failure it rolls
 * every next clip back and throws with the exact residual ownership set.
 */
export function replaceScheduledProjectClips(
  handle: EngineHandle,
  previous: ReadonlyArray<ScheduledProjectClip>,
  next: ReadonlyArray<ScheduledProjectClip>,
): ScheduledProjectClip[] {
  const removedPrevious = cleanupScheduledProjectClips(handle, previous, 'previous');
  if (removedPrevious.failures.length === 0) return [...next];
  const rolledBackNext = cleanupScheduledProjectClips(handle, next, 'rollback');
  throw new AudioScheduleReplaceError(
    [...removedPrevious.remaining, ...rolledBackNext.remaining],
    [...removedPrevious.failures, ...rolledBackNext.failures],
  );
}

interface PreparedProjectClip {
  channels: Float32Array[];
  clipId: number;
  gain: number;
  startPpq: number;
  trackId: number;
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
      'Live audio schedule',
      Number.isSafeInteger(bytes) ? bytes : Number.MAX_SAFE_INTEGER,
      budgetBytes,
    );
  }
}

async function preflightLiveScheduleMemory(
  store: ReturnType<typeof useProjectStore>,
  tempoMap: NormalizedTempoMap,
  targetRate: number,
  loadMeta: (assetId: string) => Promise<AudioAssetMeta>,
  signal?: AbortSignal,
): Promise<{ sourceBytes: number; preparedBytes: number }> {
  const metas = new Map<string, AudioAssetMeta | null>();
  let sourceBytes = 0;
  let preparedBytes = 0;
  const metaFor = async (assetId: string): Promise<AudioAssetMeta | null> => {
    if (metas.has(assetId)) return metas.get(assetId) ?? null;
    signal?.throwIfAborted();
    try {
      const meta = await loadMeta(assetId);
      signal?.throwIfAborted();
      metas.set(assetId, meta);
      sourceBytes += meta.numFrames * meta.numChannels * Float32Array.BYTES_PER_ELEMENT;
      return meta;
    } catch {
      if (signal?.aborted) signal.throwIfAborted();
      metas.set(assetId, null);
      return null;
    }
  };
  for (const track of store.tracks) {
    signal?.throwIfAborted();
    if (track.frozen) {
      const meta = await metaFor(track.frozen.assetId);
      if (meta) {
        preparedBytes +=
          Math.round((meta.numFrames / meta.sampleRate) * targetRate) *
          meta.numChannels *
          Float32Array.BYTES_PER_ELEMENT;
      }
      continue;
    }
    for (const clip of store.clips) {
      if (clip.trackId !== track.id || clipKind(clip) !== 'audio' || clip.gain <= 0) continue;
      for (const segment of audioClipSegments(clip, { tempoMap, clipStartPpq: clip.startPpq })) {
        const meta = await metaFor(segment.assetId);
        if (!meta) continue;
        preparedBytes +=
          ppqDurationSamples(
            tempoMap,
            clip.startPpq + segment.offsetPpq,
            segment.lengthPpq,
            targetRate,
          ) *
          meta.numChannels *
          Float32Array.BYTES_PER_ELEMENT;
      }
    }
  }
  if (!Number.isSafeInteger(sourceBytes + preparedBytes)) {
    throw new PayloadMemoryLimitError('Live audio schedule', Number.MAX_SAFE_INTEGER, 1);
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
  const retainedScheduleBytes = options.retainedScheduleBytes ?? 0;
  if (!Number.isSafeInteger(retainedScheduleBytes) || retainedScheduleBytes < 0) {
    throw new RangeError('Retained schedule bytes must be a non-negative safe integer');
  }
  const prepared: PreparedProjectClip[] = [];
  const preflight = loadMeta
    ? await preflightLiveScheduleMemory(store, tempoMap, targetRate, loadMeta, signal)
    : null;
  if (preflight) {
    assertLiveScheduleMemory(
      retainedScheduleBytes + preflight.sourceBytes + preflight.preparedBytes,
      budgetBytes,
    );
  }
  const actualSourceIds = new Set<string>();
  let actualSourceBytes = 0;
  let actualPreparedBytes = 0;
  const accountAsset = (assetId: string, asset: LoadedAudioAsset): void => {
    if (!actualSourceIds.has(assetId)) {
      actualSourceIds.add(assetId);
      actualSourceBytes += preparedClipBytes(asset.channels);
    }
    if (!preflight) {
      assertLiveScheduleMemory(
        retainedScheduleBytes + actualSourceBytes + actualPreparedBytes,
        budgetBytes,
      );
    }
  };
  const appendPrepared = (clip: PreparedProjectClip): void => {
    actualPreparedBytes += preparedClipBytes(clip.channels);
    assertLiveScheduleMemory(
      retainedScheduleBytes + (preflight?.sourceBytes ?? actualSourceBytes) + actualPreparedBytes,
      budgetBytes,
    );
    prepared.push(clip);
  };
  signal?.throwIfAborted();

  // Preparation performs every fallible asynchronous asset conversion before
  // mutating the live engine, keeping the following commit phase short.
  for (const track of store.tracks) {
    signal?.throwIfAborted();
    // Frozen tracks play their baked pre-fader render from the timeline
    // start instead of their own clips (which stay silent until unfreeze).
    if (track.frozen !== undefined) {
      let asset: LoadedAudioAsset;
      try {
        asset = await loadAudio(track.frozen.assetId);
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        options.onMediaIssue?.({
          kind: 'audio-asset',
          mediaId: track.frozen.assetId,
          role: 'frozen',
          reason: 'unreadable',
          trackId: track.id,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      signal?.throwIfAborted();
      accountAsset(track.frozen.assetId, asset);
      const channels = resampleChannelsLinear(
        asset.channels.map((channel) => channel.slice()),
        asset.meta.sampleRate,
        targetRate,
      );
      if (channels.length > 0 && channels[0].length > 0) {
        appendPrepared({
          channels,
          clipId: -track.id,
          gain: 1,
          startPpq: 0,
          trackId: track.id,
        });
      }
      continue;
    }
    const clips = store.clips.filter((clip) => clip.trackId === track.id);
    for (const clip of clips) {
      signal?.throwIfAborted();
      if (clipKind(clip) !== 'audio') continue;
      const gain = clip.gain;
      if (gain <= 0) continue;
      // A clip expands to one engine clip per comp segment (one segment for
      // clips without takes); each slice loads its segment's asset.
      for (const segment of audioClipSegments(clip, { tempoMap, clipStartPpq: clip.startPpq })) {
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
        accountAsset(segment.assetId, asset);
        let channels = await renderAudioClipSegment(asset, clip, segment, tempoMap);
        signal?.throwIfAborted();
        channels = resampleChannelsLinear(channels, asset.meta.sampleRate, targetRate);
        if (channels.length === 0 || channels[0].length === 0) continue;
        appendPrepared({
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
      signal?.throwIfAborted();
      const engineClipId = handle.engine.addClip(clip.trackId, clip.channels, clip.startPpq, {
        gain: clip.gain,
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
      scheduled.push(scheduledClip);
    }
    return scheduled;
  } catch (error) {
    const cleanup = cleanupScheduledProjectClips(handle, scheduled);
    if (cleanup.failures.length > 0) {
      throw new AudioScheduleReplaceError(cleanup.remaining, cleanup.failures, error);
    }
    throw error;
  }
}
