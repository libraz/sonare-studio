/**
 * Audio-driven melody extraction: runs libsonare's `analyzeMelody` over an
 * audio clip's source window and segments the per-frame pitch contour into
 * discrete MIDI notes for a new clip.
 *
 * Like {@link analyzeAudioClipChords} and {@link analyzeAudioClipSections}, the
 * analyzed buffer is cut with the same fixed-tempo slice as playback, and frame
 * times (seconds, relative to the window start) map to clip-relative PPQ with
 * that same constant tempo. Consecutive voiced frames that round to the same
 * MIDI pitch are merged into one note; unvoiced frames (no frequency) break the
 * run. Side-effect-free and dependency-injected for testing; the clip/track
 * creation lives in command/melody.
 */

import { nearestStep, noteToPitchClass, tryParseNote } from '@libraz/libcantus';
import type { KeyDetection, MelodyOptions, MelodyPoint, MelodyResult } from '@libraz/libsonare';
import { clamp01 } from '@/lib/math';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { renderAudibleClipMono } from './audible-clip-window';
import { quantizeNotes } from './audio-transcription';
import { ppqToSeconds, secondsToPpq } from './tempo-map';
import type { MeterGridStep } from './time-signature';
import { MAJOR_MODE_MASK, type TempoSegment, type TimeSignatureSegment } from './types';

/** The melody analyzer signature (libsonare `analyzeMelody`). */
export type AudioMelodyAnalyzer = (
  samples: Float32Array,
  sampleRate: number,
  options?: Pick<MelodyOptions, 'usePyin'>,
) => Pick<MelodyResult, 'points'>;

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
  /** Optional key detector used to choose the scale for pitch quantization. */
  detectKey?: (
    samples: Float32Array,
    sampleRate: number,
  ) => Pick<KeyDetection, 'name' | 'shortName'>;
  /** Optional scale quantizer; receives root pitch class and a 12-bit mode mask. */
  scaleQuantizeMidi?: (root: number, modeMask: number, midi: number) => number;
}

/** Tuning for {@link analyzeAudioClipMelody}. */
export interface MelodyExtractOptions {
  /** Drop notes shorter than this (seconds) to suppress blips. Default 0.05. */
  minNoteSeconds?: number;
  /** Use the pYIN tracker. Default true. */
  usePyin?: boolean;
  /** Quantize note starts/ends to this step of the project meter grid, or `'bar'`. Omit/0 to keep raw rhythm. */
  rhythmQuantizePpq?: MeterGridStep;
  /** Project meter map the rhythm grid is anchored to; omitted means 4/4 from PPQ 0. */
  timeSignatures?: readonly TimeSignatureSegment[];
  /** Snap detected pitches to the estimated key scale. Default false to preserve chromatic detail. */
  pitchQuantizeToScale?: boolean;
}

interface MelodyScale {
  root: number;
  modeMask: number;
}

const NATURAL_MINOR_MODE_MASK = 0b010110101101;

/** True when a frame is voiced and its pitch lands in the MIDI range. */
function pitchOf(point: MelodyPoint): number | null {
  const hz = point.frequencyHz;
  if (hz === undefined || !(hz > 0)) return null;
  // 12-TET step index is the MIDI number: A4 = 440 Hz = 69.
  const midi = nearestStep(hz);
  return midi >= 0 && midi <= 127 ? midi : null;
}

function clampMidi(value: number): number {
  return Math.min(127, Math.max(0, Math.round(value)));
}

function parseDetectedScale(key: Pick<KeyDetection, 'name' | 'shortName'>): MelodyScale | null {
  const label = (key.shortName || key.name).trim();
  const match = label.match(/^([A-Ga-g])([#b]?)(?:\s*(major|minor|maj|min|m))?/);
  if (!match) return null;
  // The label comes from the audio analyzer's own shorthand ("C#m", "Amaj"),
  // so only the tonic is handed to the note parser; the mode word below is read
  // leniently because that shorthand is not a key name any parser would accept.
  const tonic = tryParseNote(`${match[1].toUpperCase()}${match[2].toLowerCase()}`);
  if (!tonic.ok) return null;
  const root = noteToPitchClass(tonic.value);
  const modeToken = match[3]?.toLowerCase();
  const isMinor =
    modeToken === 'minor' ||
    modeToken === 'min' ||
    modeToken === 'm' ||
    (/^[A-Ga-g][#b]?m$/.test(label) && !/maj/i.test(label));
  return { root, modeMask: isMinor ? NATURAL_MINOR_MODE_MASK : MAJOR_MODE_MASK };
}

function detectMelodyScale(
  mono: Float32Array,
  sampleRate: number,
  deps: AudioMelodyDeps,
): MelodyScale | null {
  if (deps.detectKey === undefined || deps.scaleQuantizeMidi === undefined) return null;
  try {
    return parseDetectedScale(deps.detectKey(mono, sampleRate));
  } catch {
    return null;
  }
}

function quantizePitch(midi: number, scale: MelodyScale | null, deps: AudioMelodyDeps): number {
  if (!scale || deps.scaleQuantizeMidi === undefined) return midi;
  const snapped = deps.scaleQuantizeMidi(scale.root, scale.modeMask, midi);
  return Number.isFinite(snapped) ? clampMidi(snapped) : midi;
}

function clampVelocity(value: number): number {
  return Math.min(127, Math.max(1, Math.round(value)));
}

function rms(samples: Float32Array, start = 0, end = samples.length): number {
  const from = Math.max(0, Math.min(samples.length, Math.floor(start)));
  const to = Math.max(from, Math.min(samples.length, Math.ceil(end)));
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i += 1) {
    const sample = samples[i];
    sum += sample * sample;
  }
  return Math.sqrt(sum / (to - from));
}

/**
 * Note-on velocity from analyzer confidence plus the actual audio envelope.
 *
 * Analyzer confidence is not loudness: pYIN often returns mid confidence for a
 * clearly audible note, so mapping confidence directly to velocity makes
 * transcribed melodies uniformly weak. The confidence value provides a musical
 * reliability baseline, while clip-local RMS restores relative performance
 * dynamics between notes.
 */
function velocityFromConfidenceAndLevel(
  meanConfidence: number,
  noteRms: number,
  referenceRms: number,
): number {
  const confidence = clamp01(meanConfidence);
  const confidenceVelocity = 48 + confidence * 79;
  const levelRatio = referenceRms > 1e-9 ? noteRms / referenceRms : 1;
  const dynamicFactor = Math.min(1.25, Math.max(0.6, Math.sqrt(levelRatio)));
  return clampVelocity(confidenceVelocity * dynamicFactor);
}

/**
 * Extracts a monophonic melody from an audio clip and returns it as notes in
 * clip-relative PPQ. Returns `[]` when the clip has no asset, the tempo is
 * non-positive, or the source window is empty.
 *
 * @param clip Audio clip to analyze (needs `assetId`).
 * @param tempoBpm Fallback tempo (> 0) when `tempoSegments` is empty.
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
  const audible = await renderAudibleClipMono(clip, tempoBpm, tempoSegments, deps.loadAudioAsset);
  if (!audible) return [];
  const { mono, sampleRate, map } = audible;
  const { points } = deps.analyzeMelody(mono, sampleRate, { usePyin: options.usePyin ?? true });
  const scale = options.pitchQuantizeToScale ? detectMelodyScale(mono, sampleRate, deps) : null;
  const minNoteSeconds = options.minNoteSeconds ?? 0.05;
  // Map window-relative frame seconds to clip-relative PPQ through the tempo
  // map (the inverse of how the new MIDI clip plays back), so the transcription
  // stays aligned when the tempo varies under the clip.
  const clipStartSeconds = ppqToSeconds(map, clip.startPpq);
  const secondsToClipPpq = (seconds: number): number =>
    secondsToPpq(map, clipStartSeconds + seconds) - clip.startPpq;
  const windowEndSeconds = ppqToSeconds(map, clip.startPpq + clip.lengthPpq) - clipStartSeconds;
  const referenceRms = rms(mono);

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
        const startFrame = startSeconds * sampleRate;
        const endFrame = clampedEnd * sampleRate;
        notes.push({
          pitch: runMidi,
          startPpq,
          durationPpq: endPpq - startPpq,
          velocity: velocityFromConfidenceAndLevel(
            confCount > 0 ? confSum / confCount : 0,
            rms(mono, startFrame, endFrame),
            referenceRms,
          ),
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
      flush(point.timeSec); // unvoiced frame ends the run here
      continue;
    }
    const snappedMidi = quantizePitch(midi, scale, deps);
    if (snappedMidi !== runMidi) {
      flush(point.timeSec); // pitch change: previous note ends at this frame
      runMidi = snappedMidi;
      runStart = point.timeSec;
    }
    confSum += clamp01(point.confidence);
    confCount += 1;
  }
  flush(windowEndSeconds); // last run extends to the window end

  return quantizeNotes(
    notes,
    options.rhythmQuantizePpq,
    clip.lengthPpq,
    clip.startPpq,
    options.timeSignatures,
  );
}
