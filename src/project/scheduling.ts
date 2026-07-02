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
import { audioClipSegments } from './comping';
import { useProjectStore } from './store';
import { type NormalizedTempoMap, normalizeTempoMap, ppqToSamples } from './tempo-map';
import type { EditorNote, EditorTrack } from './types';
import { clipKind } from './types';
import { bakeWarpedClip } from './warp';

/** The mute/solo subset of a track relevant to audibility. */
export type TrackAudibilityState = Pick<EditorTrack, 'mute' | 'solo' | 'soloSafe'>;

/**
 * Decides whether a track is audible under the solo/mute rules: when any
 * track is soloed only soloed and solo-safe tracks play, and mute always
 * silences a track (mute wins over its own solo/solo-safe status).
 *
 * @param track Track to test.
 * @param tracks All tracks of the project (to detect active solos).
 * @returns True when the track's clips should be scheduled.
 */
export function isTrackAudible(
  track: TrackAudibilityState,
  tracks: ReadonlyArray<TrackAudibilityState>,
): boolean {
  if (track.mute) return false;
  const anySolo = tracks.some((t) => t.solo);
  return anySolo ? track.solo || track.soloSafe === true : true;
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
  const windowEnd = clip.sourceOffsetPpq + clip.lengthPpq;
  return clip.notes
    .filter((note) => note.startPpq >= clip.sourceOffsetPpq && note.startPpq < windowEnd)
    .map((note) => ({
      note: note.pitch,
      velocity: note.velocity,
      ...(note.offVelocity !== undefined ? { offVelocity: note.offVelocity } : {}),
      startPpq: note.startPpq - clip.sourceOffsetPpq,
      durationPpq: note.durationPpq,
      channel: note.channel,
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
): Float32Array[] {
  const frames = channels[0]?.length ?? 0;
  const startFrame =
    typeof tempo === 'number'
      ? Math.round(ppqToSeconds(sourceOffsetPpq, tempo) * sampleRate)
      : ppqToSamples(tempo, sourceOffsetPpq, sampleRate);
  const endFrame =
    typeof tempo === 'number'
      ? startFrame + Math.round(ppqToSeconds(lengthPpq, tempo) * sampleRate)
      : ppqToSamples(tempo, sourceOffsetPpq + lengthPpq, sampleRate);
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
  tempoBpm: number,
  fadeInPpq: number,
  fadeOutPpq: number,
): Float32Array[] {
  const frames = channels[0]?.length ?? 0;
  if (frames === 0) return channels;
  const inFrames = Math.min(
    frames,
    Math.max(0, Math.round(ppqToSeconds(fadeInPpq, tempoBpm) * sampleRate)),
  );
  const outFrames = Math.min(
    frames,
    Math.max(0, Math.round(ppqToSeconds(fadeOutPpq, tempoBpm) * sampleRate)),
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
 * The legacy track.pan field and clip looping are not applied.
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
  const scheduled: ScheduledProjectClip[] = [];
  for (const track of store.tracks) {
    // Frozen tracks play their baked pre-fader render from the timeline
    // start instead of their own clips (which stay silent until unfreeze).
    if (track.frozen !== undefined) {
      try {
        const asset = await loadAudio(track.frozen.assetId);
        const targetRate = options.sampleRate ?? handle.ctx.sampleRate;
        const channels = resampleChannelsLinear(
          asset.channels.map((channel) => channel.slice()),
          asset.meta.sampleRate,
          targetRate,
        );
        if (channels.length > 0 && channels[0].length > 0) {
          const engineClipId = handle.engine.addClip(track.id, channels, 0, { gain: 1 });
          scheduled.push({ engineClipId, clipId: -track.id, trackId: track.id });
        }
      } catch {
        // Missing or unreadable frozen asset: the track stays silent.
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
        // Tempo-following clips bake their window through the offline
        // stretch instead of the fixed-rate slice (takes-free clips only).
        let channels =
          clip.warp?.enabled && (clip.takes?.length ?? 0) === 0
            ? await bakeWarpedClip(asset.channels, asset.meta.sampleRate, clip, tempoMap, {
                cacheKey: segment.assetId,
              })
            : sliceAudioClipWindow(
                asset.channels,
                asset.meta.sampleRate,
                segment.sourceOffsetPpq,
                segment.lengthPpq,
                tempoMap,
              );
        channels = applyAudioClipFades(
          channels,
          asset.meta.sampleRate,
          tempoBpm,
          segment.fadeInPpq,
          segment.fadeOutPpq,
        );
        const targetRate = options.sampleRate ?? handle.ctx.sampleRate;
        channels = resampleChannelsLinear(channels, asset.meta.sampleRate, targetRate);
        if (channels.length === 0 || channels[0].length === 0) continue;
        const engineClipId = handle.engine.addClip(
          track.id,
          channels,
          clip.startPpq + segment.offsetPpq,
          { gain },
        );
        scheduled.push({ engineClipId, clipId: clip.id, trackId: track.id });
      }
    }
  }
  return scheduled;
}
