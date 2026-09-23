/**
 * Pitch-range presets for {@link EditorTrack.pitchRange}: the four SATB vocal
 * ranges plus a few common instrument ranges, so a track can be checked
 * against a singer's or a player's reachable pitches during placement
 * guidance. Values are taken from libcantus rather than hand-tuned, so they
 * track any future correction there.
 *
 * Pure data module: no store, no wasm, no history.
 */

import {
  BASS_4_STRING,
  BASS_5_STRING,
  GUITAR_STANDARD,
  instrumentRange,
  SATB_RANGES,
} from '@libraz/libcantus';

/** One inclusive MIDI pitch range (0-127, `low <= high`). */
export interface PitchRange {
  /** Lowest playable pitch, inclusive. */
  low: number;
  /** Highest playable pitch, inclusive. */
  high: number;
}

/** Preset ids offered when assigning a track's pitch range. */
export type PitchRangePresetId =
  | 'soprano'
  | 'alto'
  | 'tenor'
  | 'bass'
  | 'bass4'
  | 'bass5'
  | 'guitar';

/** Preset ids in display order (vocal ranges high to low, then instruments). */
export const PITCH_RANGE_PRESET_IDS: readonly PitchRangePresetId[] = [
  'soprano',
  'alto',
  'tenor',
  'bass',
  'bass4',
  'bass5',
  'guitar',
];

/**
 * Preset pitch ranges, keyed by id.
 *
 * The vocal ranges come from libcantus's {@link SATB_RANGES}, ascending from
 * index 0 (bass) to index 3 (soprano); the instrument ranges come from
 * {@link instrumentRange}.
 */
export const PITCH_RANGE_PRESETS: Readonly<Record<PitchRangePresetId, PitchRange>> = {
  soprano: { low: SATB_RANGES[3].min, high: SATB_RANGES[3].max },
  alto: { low: SATB_RANGES[2].min, high: SATB_RANGES[2].max },
  tenor: { low: SATB_RANGES[1].min, high: SATB_RANGES[1].max },
  bass: { low: SATB_RANGES[0].min, high: SATB_RANGES[0].max },
  bass4: instrumentRange(BASS_4_STRING),
  bass5: instrumentRange(BASS_5_STRING),
  guitar: instrumentRange(GUITAR_STANDARD),
};

/** True when `range` is a well-formed inclusive MIDI pitch range. */
export function isValidPitchRange(range: PitchRange): boolean {
  return (
    Number.isInteger(range.low) &&
    Number.isInteger(range.high) &&
    range.low >= 0 &&
    range.high <= 127 &&
    range.low <= range.high
  );
}
