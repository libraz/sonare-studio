/**
 * The combined reference-pair analysis the Match EQ panel renders alongside an
 * applied match. Built in the wasm-ops layer from the core's `match.*` pair
 * analyses (`masteringAnalyzePair`), whose results are typed objects.
 */

import type {
  MatchEqCurveResult,
  MatchReferenceLoudnessResult,
  MatchTonalBalanceBand,
} from '@/wasm/index.js';

/** The combined Match EQ analysis shown next to the applied match. */
export interface MatchEqAnalysis {
  /** The match EQ correction curve: gain in dB per frequency in Hz. */
  curve: MatchEqCurveResult;
  /** Tonal-balance bands, low to high. */
  tonalBalance: MatchTonalBalanceBand[];
  /** Loudness comparison, or null when a silent take gave no loudness. */
  loudness: Required<MatchReferenceLoudnessResult> | null;
}
