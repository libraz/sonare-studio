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
import { normalizeTempoMap, ppqToSeconds, secondsToPpq } from './tempo-map';
import type { EditorClip, TempoSegment } from './types';

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
 * @param tempoBpm Constant tempo (> 0) used for the window slice (the clip
 *   plays at its native sample rate, so the slice is fixed-tempo).
 * @param deps Injected asset loader and chord detector.
 * @param tempoSegments Project tempo map; detection times are placed on the
 *   timeline through it, so chords land correctly when the tempo varies under
 *   the clip. Empty (the default) reduces to the constant `tempoBpm` mapping.
 * @returns Detected chord symbols (unsorted; the caller sanitizes).
 */
export async function analyzeAudioClipChords(
  clip: EditorClip,
  tempoBpm: number,
  deps: AudioChordDeps,
  tempoSegments: ReadonlyArray<TempoSegment> = [],
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
  // Map window-relative detection seconds onto the timeline through the tempo
  // map: the inverse of how playback positions the clip. The clip's audio
  // starts at clip.startPpq, so a detection time `s` lands at the PPQ whose
  // elapsed seconds is (clip start seconds + s).
  const map = normalizeTempoMap(tempoSegments, tempoBpm);
  const clipStartSeconds = ppqToSeconds(map, clip.startPpq);
  const secondsToTimelinePpq = (seconds: number): number =>
    secondsToPpq(map, clipStartSeconds + Math.max(0, seconds));
  const symbols: EditorChordSymbol[] = [];
  for (const chord of result.chords ?? []) {
    const startPpq = secondsToTimelinePpq(chord.start);
    const endPpq = Math.min(clipEndPpq, secondsToTimelinePpq(chord.end));
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
