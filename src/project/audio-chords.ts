/**
 * Audio-driven chord detection: runs libsonare's audio chord detector over an
 * audio clip's source window and maps the detected progression onto the
 * project's chord-track timeline.
 *
 * The analyzed buffer is cut with the same fixed-tempo slice as playback
 * (`sliceAudioClipWindow`), so what the detector hears matches what the clip
 * sounds like; detection times (seconds, relative to the window start) are then
 * mapped back to absolute PPQ with that same constant tempo. The detector's
 * `quality` ordinals 0-15 are the editor's own (Major = 0); the qualities past
 * them are carried as a base ordinal plus extensions and omissions. The
 * app-side merge and undoable commit live in
 * command/chords.ts; this module is side-effect-free and dependency-injected
 * for testing.
 */

import type { ChordQuality } from '@libraz/libcantus';
import { type EditorQuality, libcantusQualityToEditor } from '@/compose/chord-quality';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { mixdownToMono } from './audio-import';
import { chordExtensionSignature, type EditorChordSymbol } from './chords';
import { sliceAudioClipWindow } from './scheduling';
import { normalizeTempoMap, ppqToSeconds, secondsToPpq } from './tempo-map';
import type { EditorClip, TempoSegment } from './types';

/** Identity of a chord for adjacency comparison (root/quality/bass). */
function chordIdentity(symbol: EditorChordSymbol): string {
  return `${symbol.rootPc}:${symbol.quality}:${chordExtensionSignature(symbol)}:${symbol.bassPc ?? -1}`;
}

/** Highest detector ordinal the editor shares one-for-one (Dominant9). */
const LAST_SHARED_QUALITY = 15;

/** Detector ordinals past the shared range, by the libcantus quality naming the same tones. */
const DETECTED_QUALITY_BEYOND_EDITOR: Readonly<Record<number, ChordQuality>> = {
  17: '6',
  18: 'min6',
  19: 'minMaj7',
  20: '7sus4',
  21: '11',
  22: '13',
  23: '7b9',
  24: '7#9',
};

/** Sus2Add4 (16): a sus2 triad with the fourth added, which no libcantus quality names. */
const SUS2_ADD4: EditorQuality = { quality: 7, extensions: [5] };

/** Maps a detector quality ordinal onto the editor's ordinal plus extensions and omissions. */
export function detectedChordQuality(ordinal: number): EditorQuality {
  if (ordinal <= LAST_SHARED_QUALITY) return { quality: ordinal };
  if (ordinal === 16) return SUS2_ADD4;
  const named = DETECTED_QUALITY_BEYOND_EDITOR[ordinal];
  if (named === undefined) throw new RangeError(`Unmapped detector chord quality ${ordinal}`);
  return libcantusQualityToEditor(named);
}

/** Onset tolerance (in PPQ) for treating two regions as contiguous. */
const CONTIGUOUS_EPSILON = 1e-6;

/**
 * Smooths a detected chord progression: absorbs short outlier chords that sit
 * between two identical neighbors and merges adjacent identical regions.
 *
 * The audio detector slices its input into fixed windows, so a single window can
 * mis-read the harmony and produce a lone spurious chord (e.g. `C G C` where the
 * `G` is one short window inside a held `C`). Such an outlier — shorter than
 * `minStableBeats` and flanked by the same chord on both sides — is absorbed into
 * the surrounding chord, and any adjacent identical regions are then merged into
 * one span. Pure and order-independent (the input is sorted by onset first).
 *
 * @param symbols Detected chord symbols (absolute PPQ; PPQ == beats).
 * @param minStableBeats Outliers shorter than this (in beats) may be absorbed.
 * @returns The smoothed, merged symbols in onset order.
 */
export function smoothDetectedChordSymbols(
  symbols: ReadonlyArray<EditorChordSymbol>,
  minStableBeats = 1,
): EditorChordSymbol[] {
  const sorted = symbols.map((symbol) => ({ ...symbol })).sort((a, b) => a.startPpq - b.startPpq);
  const kept: EditorChordSymbol[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    const previous = kept[kept.length - 1];
    const next = sorted[i + 1];
    const duration = current.endPpq - current.startPpq;
    if (
      previous !== undefined &&
      next !== undefined &&
      duration < minStableBeats &&
      chordIdentity(previous) === chordIdentity(next) &&
      chordIdentity(current) !== chordIdentity(previous)
    ) {
      // Absorb the outlier into the preceding chord; the identical `next` then
      // merges with it below, closing the gap the outlier left behind.
      previous.endPpq = Math.max(previous.endPpq, current.endPpq);
      continue;
    }
    kept.push(current);
  }
  const merged: EditorChordSymbol[] = [];
  for (const symbol of kept) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      chordIdentity(last) === chordIdentity(symbol) &&
      symbol.startPpq <= last.endPpq + CONTIGUOUS_EPSILON
    ) {
      last.endPpq = Math.max(last.endPpq, symbol.endPpq);
    } else {
      merged.push(symbol);
    }
  }
  return merged;
}

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
 * @returns Detected chord symbols in onset order, smoothed to absorb single-
 *   window detector outliers (see {@link smoothDetectedChordSymbols}).
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
    const { quality, extensions, omissions } = detectedChordQuality(chord.quality);
    const symbol: EditorChordSymbol = { startPpq, endPpq, rootPc: chord.root, quality };
    if (extensions) symbol.extensions = [...extensions];
    if (omissions) symbol.omissions = [...omissions];
    if (chord.bass !== chord.root) symbol.bassPc = chord.bass;
    symbols.push(symbol);
  }
  return smoothDetectedChordSymbols(symbols);
}
