/**
 * Audio-driven chord detection: runs libsonare's audio chord detector over an
 * audio clip's source window and maps the detected progression onto the
 * project's chord-track timeline.
 *
 * The analyzed buffer is the clip's audible window (`renderAudibleClipMono`),
 * so what the detector hears is what plays; detection times (seconds, relative
 * to the clip start) are mapped back to absolute PPQ through the same tempo
 * map. The detector's
 * quality tokens 0-15 are the editor's own (Major = 0); the qualities past
 * them are carried as a base ordinal plus extensions and omissions. The
 * app-side merge and undoable commit live in
 * command/chords.ts; this module is side-effect-free and dependency-injected
 * for testing.
 */

import type { Chord, ChordQuality, detectChords } from '@libraz/libsonare';
import { type EditorQuality, libcantusQualityToEditor } from '@/compose/chord-quality';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { renderAudibleClipMono } from './audible-clip-window';
import { chordExtensionSignature, type EditorChordSymbol } from './chords';
import { ppqToSeconds, secondsToPpq } from './tempo-map';
import type { EditorClip, TempoSegment } from './types';

/** Identity of a chord for adjacency comparison (root/quality/bass). */
function chordIdentity(symbol: EditorChordSymbol): string {
  return `${symbol.rootPc}:${symbol.quality}:${chordExtensionSignature(symbol)}:${symbol.bassPc ?? -1}`;
}

/**
 * The editor's quality for each detector token: a shared ordinal, or a base
 * ordinal plus the extensions and omissions of the libcantus quality naming the
 * same tones. Exhaustive over the core's tokens.
 */
const EDITOR_QUALITY_BY_DETECTED: Readonly<Record<ChordQuality, EditorQuality>> = {
  major: { quality: 0 },
  minor: { quality: 1 },
  diminished: { quality: 2 },
  augmented: { quality: 3 },
  dominant7: { quality: 4 },
  major7: { quality: 5 },
  minor7: { quality: 6 },
  sus2: { quality: 7 },
  sus4: { quality: 8 },
  unknown: { quality: 9 },
  add9: { quality: 10 },
  minorAdd9: { quality: 11 },
  dim7: { quality: 12 },
  halfDim7: { quality: 13 },
  major9: { quality: 14 },
  dominant9: { quality: 15 },
  // A sus2 triad with the fourth added, which no libcantus quality names.
  sus2Add4: { quality: 7, extensions: [5] },
  major6: libcantusQualityToEditor('6'),
  minor6: libcantusQualityToEditor('min6'),
  minorMajor7: libcantusQualityToEditor('minMaj7'),
  dominant7Sus4: libcantusQualityToEditor('7sus4'),
  dominant11: libcantusQualityToEditor('11'),
  dominant13: libcantusQualityToEditor('13'),
  dominant7Flat9: libcantusQualityToEditor('7b9'),
  dominant7Sharp9: libcantusQualityToEditor('7#9'),
};

/** Maps a detector quality token onto the editor's ordinal plus extensions and omissions. */
export function detectedChordQuality(quality: ChordQuality): EditorQuality {
  return EDITOR_QUALITY_BY_DETECTED[quality];
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
export type DetectedAudioChord = Pick<Chord, 'root' | 'bass' | 'quality' | 'startSec' | 'endSec'>;

/** The audio chord detector (libsonare `detectChords`, positional form). */
export type AudioChordDetector = (...args: Parameters<typeof detectChords>) => {
  chords: ReadonlyArray<DetectedAudioChord>;
};

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
 * @param tempoBpm Fallback tempo (> 0) when `tempoSegments` is empty.
 * @param deps Injected asset loader and chord detector.
 * @param tempoSegments Project tempo map; the window is rendered under it and
 *   detection times are placed on the timeline through it. Empty (the default)
 *   reduces to the constant `tempoBpm`.
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
  const audible = await renderAudibleClipMono(clip, tempoBpm, tempoSegments, deps.loadAudioAsset);
  if (!audible) return [];
  const { mono, sampleRate, map } = audible;
  // An off-pitch recording is read on its own pitch grid.
  const result = deps.detectChords(mono, sampleRate, { tuningCents: 'auto' });
  const clipEndPpq = clip.startPpq + clip.lengthPpq;
  // The window starts at clip.startPpq, so a detection time `s` lands at the PPQ
  // whose elapsed seconds is (clip start seconds + s).
  const clipStartSeconds = ppqToSeconds(map, clip.startPpq);
  const secondsToTimelinePpq = (seconds: number): number =>
    secondsToPpq(map, clipStartSeconds + Math.max(0, seconds));
  const symbols: EditorChordSymbol[] = [];
  for (const chord of result.chords) {
    const startPpq = secondsToTimelinePpq(chord.startSec);
    const endPpq = Math.min(clipEndPpq, secondsToTimelinePpq(chord.endSec));
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
