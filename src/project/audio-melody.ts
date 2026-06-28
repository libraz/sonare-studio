/**
 * Audio-driven melody extraction: runs libsonare's `analyzeMelody` over an
 * audio clip's source window and segments the per-frame pitch contour into
 * discrete MIDI notes for a new clip.
 *
 * Like {@link analyzeAudioClipChords} and {@link analyzeAudioClipSections}, the
 * analyzed buffer is cut with the same fixed-tempo slice as playback, and frame
 * times (seconds, relative to the window start) map to clip-relative PPQ with
 * that same constant tempo. Consecutive voiced frames that round to the same
 * MIDI pitch are merged into one note; unvoiced frames (frequency 0) break the
 * run. Side-effect-free and dependency-injected for testing; the clip/track
 * creation lives in command/melody.
 */

import type { LoadedAudioAsset } from '@/persistence/assets';
import { mixdownToMono } from './audio-import';
import { sliceAudioClipWindow } from './scheduling';
import { normalizeTempoMap, ppqToSeconds, secondsToPpq } from './tempo-map';
import type { TempoSegment } from './types';

/** One frame of the melody contour returned by the engine. */
export interface DetectedMelodyPoint {
  /** Window-relative frame time in seconds. */
  time: number;
  /** Estimated f0 in Hz; 0 marks an unvoiced frame. */
  frequency: number;
  /** Voicing confidence in [0, 1]. */
  confidence: number;
}

/** The melody analyzer signature (libsonare `analyzeMelody`). */
export type AudioMelodyAnalyzer = (
  samples: Float32Array,
  sampleRate?: number,
) => { points: ReadonlyArray<DetectedMelodyPoint> };

/** A detected note ready for a new MIDI clip (clip-relative PPQ). */
export interface MelodyNoteInput {
  /** MIDI note number (integer, 0-127). */
  pitch: number;
  /** Note start within the clip, in PPQ (>= 0). */
  startPpq: number;
  /** Note length in PPQ (> 0). */
  durationPpq: number;
  /** Note-on velocity (integer, 1-127), derived from voicing confidence. */
  velocity: number;
}

/** Injectable dependencies for {@link analyzeAudioClipMelody}. */
export interface AudioMelodyDeps {
  /** Loads an audio asset's PCM (defaults to the OPFS asset store). */
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>;
  /** The melody analyzer. */
  analyzeMelody: AudioMelodyAnalyzer;
}

/** Tuning for {@link analyzeAudioClipMelody}. */
export interface MelodyExtractOptions {
  /** Drop notes shorter than this (seconds) to suppress blips. Default 0.05. */
  minNoteSeconds?: number;
}

/** 12-TET MIDI number of a frequency (A4 = 440 Hz = MIDI 69). */
function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

/** True when a frame is voiced and its pitch lands in the MIDI range. */
function pitchOf(point: DetectedMelodyPoint): number | null {
  if (!(point.frequency > 0)) return null;
  const midi = Math.round(hzToMidi(point.frequency));
  return midi >= 0 && midi <= 127 ? midi : null;
}

/** Velocity (1-127) from a mean voicing confidence in [0, 1]. */
function velocityFromConfidence(meanConfidence: number): number {
  const scaled = Math.round(meanConfidence * 127);
  return Math.min(127, Math.max(1, scaled));
}

/**
 * Extracts a monophonic melody from an audio clip and returns it as notes in
 * clip-relative PPQ. Returns `[]` when the clip has no asset, the tempo is
 * non-positive, or the source window is empty.
 *
 * @param clip Audio clip to analyze (needs `assetId`).
 * @param tempoBpm Constant tempo (> 0) used for the window slice (the clip
 *   plays at its native sample rate, so the slice is fixed-tempo).
 * @param deps Injected asset loader and melody analyzer.
 * @param options Optional minimum note length.
 * @param tempoSegments Project tempo map; frame times become clip-relative PPQ
 *   through it, so the transcription stays aligned when the tempo varies under
 *   the clip. Empty (the default) reduces to the constant `tempoBpm` mapping.
 * @returns Detected notes sorted by start (ids/channel assigned by the command).
 */
export async function analyzeAudioClipMelody(
  clip: { assetId?: string; startPpq: number; lengthPpq: number; sourceOffsetPpq: number },
  tempoBpm: number,
  deps: AudioMelodyDeps,
  options: MelodyExtractOptions = {},
  tempoSegments: ReadonlyArray<TempoSegment> = [],
): Promise<MelodyNoteInput[]> {
  if (clip.assetId === undefined || !(tempoBpm > 0)) return [];
  const asset = await deps.loadAudioAsset(clip.assetId);
  const window = sliceAudioClipWindow(
    asset.channels,
    asset.meta.sampleRate,
    clip.sourceOffsetPpq,
    clip.lengthPpq,
    tempoBpm,
  );
  const mono = mixdownToMono(window);
  if (mono.length === 0) return [];
  const points = deps.analyzeMelody(mono, asset.meta.sampleRate).points ?? [];
  const minNoteSeconds = options.minNoteSeconds ?? 0.05;
  // Map window-relative frame seconds to clip-relative PPQ through the tempo
  // map (the inverse of how the new MIDI clip plays back), so the transcription
  // stays aligned when the tempo varies under the clip.
  const map = normalizeTempoMap(tempoSegments, tempoBpm);
  const clipStartSeconds = ppqToSeconds(map, clip.startPpq);
  const secondsToClipPpq = (seconds: number): number =>
    secondsToPpq(map, clipStartSeconds + seconds) - clip.startPpq;
  const windowEndSeconds = ppqToSeconds(map, clip.startPpq + clip.lengthPpq) - clipStartSeconds;

  const notes: MelodyNoteInput[] = [];
  let runMidi: number | null = null;
  let runStart = 0;
  let confSum = 0;
  let confCount = 0;

  /** Closes the open run, ending at `endSeconds`, and appends a kept note. */
  const flush = (endSeconds: number): void => {
    if (runMidi === null) return;
    const startSeconds = runStart;
    const clampedEnd = Math.min(windowEndSeconds, Math.max(startSeconds, endSeconds));
    if (clampedEnd - startSeconds >= minNoteSeconds) {
      const startPpq = Math.max(0, secondsToClipPpq(startSeconds));
      const endPpq = Math.min(clip.lengthPpq, secondsToClipPpq(clampedEnd));
      if (endPpq > startPpq) {
        notes.push({
          pitch: runMidi,
          startPpq,
          durationPpq: endPpq - startPpq,
          velocity: velocityFromConfidence(confCount > 0 ? confSum / confCount : 0),
        });
      }
    }
    runMidi = null;
    confSum = 0;
    confCount = 0;
  };

  for (const point of points) {
    const midi = pitchOf(point);
    if (midi === null) {
      flush(point.time); // unvoiced frame ends the run here
      continue;
    }
    if (midi !== runMidi) {
      flush(point.time); // pitch change: previous note ends at this frame
      runMidi = midi;
      runStart = point.time;
    }
    confSum += Math.min(1, Math.max(0, point.confidence));
    confCount += 1;
  }
  flush(windowEndSeconds); // last run extends to the window end

  return notes;
}
