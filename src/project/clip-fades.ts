/**
 * Clamps one edited clip fade against the clip window and the opposite fade.
 * Shared by pointer/inspector inputs; commands validate the resulting pair.
 */
export function clampClipFadePpq(
  proposedPpq: number,
  clipLengthPpq: number,
  oppositeFadePpq: number,
): number {
  if (!Number.isFinite(proposedPpq) || !Number.isFinite(clipLengthPpq)) return 0;
  const limit = Math.max(0, clipLengthPpq - Math.max(0, oppositeFadePpq));
  return Math.max(0, Math.min(proposedPpq, limit));
}

/** Throws when two fade envelopes overlap beyond the clip window. */
export function validateClipFadePair(
  fadeInPpq: number,
  fadeOutPpq: number,
  clipLengthPpq: number,
): void {
  if (fadeInPpq + fadeOutPpq > clipLengthPpq + 1e-9) {
    throw new RangeError(
      `Clip fades (${fadeInPpq} + ${fadeOutPpq}) must not exceed clip length ${clipLengthPpq}`,
    );
  }
}
