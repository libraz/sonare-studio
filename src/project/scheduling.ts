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
import { MEBIBYTE } from '@/lib/bytes';
import { errorMessage } from '@/lib/errors';
import { PayloadMemoryLimitError } from '@/lib/payload-memory';
import {
  type AudioAssetMeta,
  type LoadedAudioAsset,
  loadAsset,
  loadAssetMeta,
} from '@/persistence/assets';
import {
  audioClipSegmentSource,
  audioClipSegmentSourceAtRate,
  engineClipPlayback,
  resampleChannelsLinear,
} from './audio-clip-render';
import { type AudioClipSegment, audioClipSegments } from './comping';
import type { MediaCompletenessIssue } from './media-completeness';
import { audibleMidiProjector } from './midi-projection';
import { useProjectStore } from './store';
import { type NormalizedTempoMap, normalizeTempoMap, ppqDurationSamples } from './tempo-map';
import type { EditorClip, EditorNote, EditorTrack } from './types';
import { clipKind } from './types';

export {
  type AudibleAudioClipFields,
  type AudibleClipFrameWindow,
  type AudioClipSegmentSource,
  type AudioClipSliceTempo,
  applyAudioClipFades,
  audioClipSegmentSource,
  audioClipSegmentSourceAtRate,
  audioClipWindowFrames,
  engineClipPlayback,
  ppqSpanToSeconds,
  type RenderedAudibleAudioClip,
  renderAudibleAudioClipWindow,
  resampleChannelsLinear,
  type SegmentRenderableAudioClip,
  sliceAudioClipWindow,
} from './audio-clip-render';
export {
  expandedSoloStates,
  type TrackAudibilityState,
  type TrackSoloExpansionOptions,
  trackAudibilityStates,
} from './track-audibility';

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
const DEFAULT_LIVE_SCHEDULE_MEMORY_BUDGET_BYTES = 512 * MEBIBYTE;

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
function cleanupScheduledProjectClips(
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
          message: errorMessage(error),
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
        message: errorMessage(error),
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
      const engineClipId = handle.engine.addClip(clip.trackId, {
        channels: clip.channels,
        startPpq: clip.startPpq,
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
