/**
 * Preview range derivation for the mastering panel: the transport's loop
 * window when one is active, otherwise the first bars of the project (bar
 * length taken from the time signature in effect at the timeline start).
 * PPQ unit is quarter notes throughout.
 */

import type { MixdownRangePpq } from '@/export/mixdown';

/** Bars previewed when no loop region is active. */
export const DEFAULT_PREVIEW_BARS = 8;

/** Transport loop state as the panel receives it. */
export interface PreviewLoopState {
  /** True when a loop region is active. */
  enabled: boolean;
  /** Loop start in PPQ. */
  startPpq: number;
  /** Loop end in PPQ (exclusive). */
  endPpq: number;
}

/** One time-signature segment (the project mirror's shape). */
export interface PreviewTimeSignature {
  startPpq: number;
  numerator: number;
  denominator: number;
}

/**
 * Length of one bar in PPQ for a time signature (4/4 = 4 quarter notes).
 * Unusable signatures fall back to 4/4.
 *
 * @param signature The time signature, or undefined for the default.
 * @returns Bar length in PPQ (> 0).
 */
export function barLengthPpq(signature?: PreviewTimeSignature): number {
  if (
    !signature ||
    !Number.isFinite(signature.numerator) ||
    !Number.isFinite(signature.denominator) ||
    signature.numerator <= 0 ||
    signature.denominator <= 0
  ) {
    return 4;
  }
  return (4 * signature.numerator) / signature.denominator;
}

/** Returns the time signature in effect at the timeline start. */
function signatureAtStart(
  segments: ReadonlyArray<PreviewTimeSignature>,
): PreviewTimeSignature | undefined {
  let best: PreviewTimeSignature | undefined;
  for (const segment of segments) {
    if (best === undefined || segment.startPpq < best.startPpq) best = segment;
  }
  return best;
}

/**
 * Derives the mixdown range a mastering preview renders.
 *
 * An active loop with a positive extent wins; otherwise the preview covers
 * the first `bars` bars from the timeline start, using the time signature in
 * effect there (default 4/4).
 *
 * @param loop Transport loop state, or null when unavailable.
 * @param timeSignatures Project time-signature segments.
 * @param bars Fallback length in bars (default {@link DEFAULT_PREVIEW_BARS}).
 * @returns The preview window in PPQ.
 */
export function derivePreviewRange(
  loop: PreviewLoopState | null,
  timeSignatures: ReadonlyArray<PreviewTimeSignature> = [],
  bars: number = DEFAULT_PREVIEW_BARS,
): MixdownRangePpq {
  if (
    loop?.enabled &&
    Number.isFinite(loop.startPpq) &&
    Number.isFinite(loop.endPpq) &&
    loop.endPpq > loop.startPpq &&
    loop.startPpq >= 0
  ) {
    return { startPpq: loop.startPpq, endPpq: loop.endPpq };
  }
  const barCount = Number.isFinite(bars) && bars > 0 ? bars : DEFAULT_PREVIEW_BARS;
  return { startPpq: 0, endPpq: barCount * barLengthPpq(signatureAtStart(timeSignatures)) };
}
