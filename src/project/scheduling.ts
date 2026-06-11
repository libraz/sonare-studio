/**
 * Project-wide playback scheduling: prerenders and schedules every audible
 * MIDI clip of every track into the engine. The single-implicit-track flow
 * (scheduleMidiClip with one clip) remains the degenerate case.
 */

import type { EngineHandle } from '@/engine/engine';
import { type MidiNote, scheduleMidiClip } from '@/engine/instruments';
import { useProjectStore } from './store';
import type { EditorClip, EditorTrack } from './types';

/**
 * Default peak level scheduled clips are normalized to (-6 dBFS), matching
 * the scheduleMidiClip default.
 */
const DEFAULT_TARGET_PEAK = 0.5;

/** The mute/solo subset of a track relevant to audibility. */
export type TrackAudibilityState = Pick<EditorTrack, 'mute' | 'solo'>;

/**
 * Decides whether a track is audible under the solo/mute rules: when any
 * track is soloed only soloed tracks play, and mute always silences a track
 * (mute wins over its own solo).
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
  return anySolo ? track.solo : true;
}

/**
 * Maps a project track id onto the engine track identifier used for
 * engine.addClip scheduling.
 *
 * @param trackId Stable project track id.
 * @returns Engine track id string.
 */
export function engineTrackId(trackId: number): string {
  return `track-${trackId}`;
}

/**
 * Extracts a clip's audible notes in clip-local PPQ: notes are stored in
 * source coordinates, so the clip window [sourceOffsetPpq, sourceOffsetPpq +
 * lengthPpq) is selected (by note start) and shifted to start at 0.
 *
 * @param clip Clip mirror entry.
 * @returns Engine-facing notes relative to the clip start.
 */
export function clipPlaybackNotes(clip: EditorClip): MidiNote[] {
  const windowEnd = clip.sourceOffsetPpq + clip.lengthPpq;
  return clip.notes
    .filter((note) => note.startPpq >= clip.sourceOffsetPpq && note.startPpq < windowEnd)
    .map((note) => ({
      note: note.pitch,
      velocity: note.velocity,
      startPpq: note.startPpq - clip.sourceOffsetPpq,
      durationPpq: note.durationPpq,
      channel: note.channel,
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
}

/** Options for {@link scheduleProjectClips}. */
export interface ScheduleProjectClipsOptions {
  /** Render sample rate; defaults to the engine context rate. */
  sampleRate?: number;
  /** Tempo used for the bounce; defaults to the store's tempo. */
  tempoBpm?: number;
  /** NativeSynth preset name; defaults to the scheduleMidiClip default. */
  preset?: string;
  /**
   * Base peak level per clip before track volume and clip gain are applied
   * (default 0.5 = -6 dBFS). Pass null to schedule at the rendered level;
   * track volume and clip gain are then NOT applied (the engine has no
   * separate track-gain control for prerendered clips).
   */
  targetPeak?: number | null;
}

/**
 * Schedules every audible MIDI clip of every track into the engine.
 *
 * Audibility follows {@link isTrackAudible} (solo-any => only solo tracks,
 * mute => skip). Track volume and clip gain are folded into the per-clip
 * normalization target (the engine exposes only per-clip gain for
 * prerendered audio), so volume 0.5 plays the clip 6 dB below the base peak.
 * Empty clips and fully attenuated clips are skipped. Track pan and clip
 * looping are not applied (no engine support for prerendered clips).
 *
 * The caller owns unscheduling: keep the returned list and call
 * engine.removeClip(engineClipId) for each entry before re-scheduling.
 *
 * @param handle Running engine handle from createEngine.
 * @param options Optional render/level overrides.
 * @returns One entry per scheduled clip.
 */
export async function scheduleProjectClips(
  handle: EngineHandle,
  options: ScheduleProjectClipsOptions = {},
): Promise<ScheduledProjectClip[]> {
  const store = useProjectStore();
  const tempoBpm = options.tempoBpm ?? store.tempoBpm;
  const basePeak = options.targetPeak === undefined ? DEFAULT_TARGET_PEAK : options.targetPeak;
  const scheduled: ScheduledProjectClip[] = [];
  for (const track of store.tracks) {
    if (!isTrackAudible(track, store.tracks)) continue;
    const clips = store.clips.filter((clip) => clip.trackId === track.id);
    for (const clip of clips) {
      const notes = clipPlaybackNotes(clip);
      if (notes.length === 0) continue;
      const targetPeak = basePeak === null ? null : basePeak * track.volume * clip.gain;
      if (targetPeak !== null && targetPeak <= 0) continue;
      const engineClipId = await scheduleMidiClip(
        handle,
        engineTrackId(track.id),
        notes,
        clip.startPpq,
        {
          ...(options.sampleRate !== undefined ? { sampleRate: options.sampleRate } : {}),
          ...(options.preset !== undefined ? { preset: options.preset } : {}),
          tempoBpm,
          targetPeak,
        },
      );
      scheduled.push({ engineClipId, clipId: clip.id, trackId: track.id });
    }
  }
  return scheduled;
}
