/**
 * Chord-progression generation command.
 *
 * Generates a diatonic chord progression for the project key with libcantus's
 * `generateProgression` and writes it to the project chord track as one
 * undoable edit (via {@link setProjectChords}, `execute(1)`). Generation is
 * deterministic in its `seed`, so re-running with the same options reproduces
 * the progression.
 *
 * libcantus lays out one chord per bar with four beats per bar (it assumes
 * 4/4); PPQ equals quarter-note beats, so a chord's beat position is its PPQ
 * position. The result is placed from `startPpq` (default the project start).
 */

import {
  type ChordQuality,
  generateProgression as generateProgressionSpans,
  type ProgStyle,
} from '@libraz/libcantus';
import { chordSpanToEditorChord } from '@/compose/chord-io';
import type { EditorChordSymbol } from '../chords';
import { useProjectStore } from '../store';
import { isFourFourBarRange } from '../time-signature';
import { setProjectChords } from './chords';
import { generationKeyAt } from './generation-key';

/** Beats per bar libcantus's progression generator assumes (4/4). */
const BEATS_PER_BAR = 4;

/** Options for {@link generateProgressionCommand}. */
export interface GenerateProgressionParams {
  /** Progression style pool (default 'minimal'). */
  style?: ProgStyle;
  /** Number of bars / chords to generate (default 4). */
  bars?: number;
  /** Force a specific preset id; omitted = deterministic pick from `style`. */
  presetId?: string;
  /** Deterministic seed (default 0). */
  seed?: number;
  /** Replace some chords with secondary dominants of the following chord. */
  reharmonize?: boolean;
  /** Force a chord quality on every chord; omitted/'auto' = diatonic triads. */
  ext?: ChordQuality | 'auto';
  /**
   * How to combine with any existing chord track:
   *  - 'replace' (default): overwrite the whole chord track;
   *  - 'append': keep existing chords and place the new run after the last one;
   *  - 'range': keep chords outside [startPpq, startPpq + bars * 4 PPQ) and
   *    replace whatever overlaps it with the generated run.
   */
  mode?: 'replace' | 'append' | 'range';
  /** Absolute PPQ to place the first chord at (default: project start, or the
   *  end of the existing track in 'append' mode; required in 'range' mode). */
  startPpq?: number;
}

/**
 * Generates a chord progression into the project chord track.
 *
 * @param params Generation options (see {@link GenerateProgressionParams}).
 * @returns The number of chords generated.
 * @throws RangeError when `bars` is not a positive integer, or when an unknown
 *   `presetId` is supplied (libcantus rejects it).
 */
export function generateProgressionCommand(params: GenerateProgressionParams = {}): number {
  const store = useProjectStore();
  const bars = params.bars ?? 4;
  if (!Number.isInteger(bars) || bars <= 0) {
    throw new RangeError(`Progression bars must be a positive integer, got ${bars}`);
  }
  const mode = params.mode ?? 'replace';
  let existing: EditorChordSymbol[];
  let startPpq: number;
  if (mode === 'append') {
    existing = [...store.chords];
    const lastEnd = existing.reduce((max, chord) => Math.max(max, chord.endPpq), 0);
    startPpq = params.startPpq ?? lastEnd;
  } else if (mode === 'range') {
    startPpq = params.startPpq ?? 0;
    const rangeEnd = startPpq + bars * BEATS_PER_BAR;
    // Preserve the parts of a chord that lie outside the replaced range. This
    // matters for manually entered chords that cross either boundary: dropping
    // the whole symbol would erase harmonic context the user did not replace.
    existing = store.chords.flatMap((chord) => {
      if (chord.endPpq <= startPpq || chord.startPpq >= rangeEnd) return [chord];
      const preserved: EditorChordSymbol[] = [];
      if (chord.startPpq < startPpq) {
        preserved.push({ ...chord, endPpq: startPpq });
      }
      if (chord.endPpq > rangeEnd) {
        preserved.push({ ...chord, startPpq: rangeEnd });
      }
      return preserved;
    });
  } else {
    existing = [];
    startPpq = params.startPpq ?? 0;
  }
  if (!isFourFourBarRange(store.timeSignatures, startPpq, bars)) {
    throw new RangeError('Progression generation currently supports 4/4 bars only.');
  }

  const key = generationKeyAt(store, startPpq);
  const spans = generateProgressionSpans({
    key,
    style: params.style ?? 'minimal',
    bars,
    ...(params.presetId !== undefined ? { presetId: params.presetId } : {}),
    // `params.reharmonize` is a boolean toggle (secondary-dominant substitution
    // on/off); libcantus 1.0 folds it into the continuous harmonic-complexity
    // dial, so true/false map to above/below its midpoint.
    ctx: {
      seed: params.seed ?? 0,
      ...(params.reharmonize !== undefined
        ? { complexity: { harmonic: params.reharmonize ? 0.75 : 0.25 } }
        : {}),
    },
    ...(params.ext !== undefined ? { ext: params.ext } : {}),
  });

  const generated: EditorChordSymbol[] = spans.map((span, index) => {
    const spanStart = startPpq + span.startBeat;
    const nextStart =
      index + 1 < spans.length
        ? startPpq + spans[index + 1].startBeat
        : startPpq + bars * BEATS_PER_BAR;
    return chordSpanToEditorChord(span, spanStart, nextStart);
  });

  setProjectChords([...existing, ...generated]);
  return generated.length;
}
