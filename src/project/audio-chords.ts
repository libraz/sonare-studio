/**
 * Audio-driven chord detection: runs libsonare's audio chord detector over an
 * audio clip's source window and maps the detected progression onto the
 * project's chord-track timeline.
 *
 * The analyzed buffer is cut with the same fixed-tempo slice as playback
 * (`sliceAudioClipWindow`), so what the detector hears matches what the clip
 * sounds like; detection times (seconds, relative to the window start) are then
 * mapped back to absolute PPQ with that same constant tempo. The detector's
 * `quality` ordinal already matches {@link EditorChordSymbol} (Major = 0), so
 * no remap is needed. The app-side merge and undoable commit live in
 * command/chords.ts; this module is side-effect-free and dependency-injected
 * for testing.
 */

import type { LoadedAudioAsset } from '@/persistence/assets';
import { mixdownToMono } from './audio-import';
import type { EditorChordSymbol } from './chords';
import { sliceAudioClipWindow } from './scheduling';
import type { EditorClip } from './types';

/** A chord returned by the engine's audio detector (the fields we consume). */
export interface DetectedAudioChord {
  /** Root pitch class 0..11 (C = 0). */
  root: number;
  /** Bass pitch class 0..11; a slash chord when it differs from the root. */
  bass: number;
  /** ChordQuality ordinal (Major = 0), matching {@link EditorChordSymbol}. */
  quality: number;
  /** Window-relative start in seconds. */
  start: number;
  /** Window-relative end in seconds. */
  end: number;
}

/** The audio chord detector signature (libsonare `detectChords`). */
export type AudioChordDetector = (
  samples: Float32Array,
  sampleRate?: number,
) => { chords: ReadonlyArray<DetectedAudioChord> };

/** Injectable dependencies for {@link analyzeAudioClipChords}. */
export interface AudioChordDeps {
  /** Loads an audio asset's PCM (defaults to the OPFS asset store). */
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>;
  /** The audio chord detector. */
  detectChords: AudioChordDetector;
}

/**
 * Detects chords from an audio clip and returns them as chord-track symbols in
 * absolute PPQ, clamped to the clip's region. Returns `[]` when the clip has no
 * asset, the tempo is non-positive, or the source window is empty.
 *
 * @param clip Audio clip to analyze.
 * @param tempoBpm Constant tempo (> 0) used for both the window slice and the
 *   seconds-to-PPQ mapping.
 * @param deps Injected asset loader and chord detector.
 * @returns Detected chord symbols (unsorted; the caller sanitizes).
 */
export async function analyzeAudioClipChords(
  clip: EditorClip,
  tempoBpm: number,
  deps: AudioChordDeps,
): Promise<EditorChordSymbol[]> {
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
  const result = deps.detectChords(mono, asset.meta.sampleRate);
  const clipEndPpq = clip.startPpq + clip.lengthPpq;
  // Inverse of scheduling.ppqToSeconds(ppq, tempoBpm) = ppq * 60 / tempoBpm.
  const secondsToClipPpq = (seconds: number): number => (seconds * tempoBpm) / 60;
  const symbols: EditorChordSymbol[] = [];
  for (const chord of result.chords ?? []) {
    const startPpq = clip.startPpq + secondsToClipPpq(Math.max(0, chord.start));
    const endPpq = Math.min(clipEndPpq, clip.startPpq + secondsToClipPpq(chord.end));
    if (!(endPpq > startPpq)) continue;
    const symbol: EditorChordSymbol = {
      startPpq,
      endPpq,
      rootPc: chord.root,
      quality: chord.quality,
    };
    if (chord.bass !== chord.root) symbol.bassPc = chord.bass;
    symbols.push(symbol);
  }
  return symbols;
}
