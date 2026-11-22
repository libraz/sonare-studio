/**
 * Part selection over a notated score: the read-only copies a printed part or
 * a multi-part extract is serialized from.
 */

import type { NotatedScore } from './model';

/**
 * Returns a new score containing one part, preserving shared score annotations
 * useful for a printed part. The input score is not mutated.
 */
export function extractPartScore(
  score: NotatedScore,
  partIdOrIndex: string | number,
): NotatedScore {
  const index =
    typeof partIdOrIndex === 'number'
      ? partIdOrIndex
      : score.parts.findIndex((part) => part.id === partIdOrIndex);
  const part = score.parts[index];
  if (part === undefined) {
    throw new RangeError(`Unknown score part: ${String(partIdOrIndex)}`);
  }
  return extractPartsScore(score, [index]);
}

/**
 * Returns a new score containing the selected parts in the requested order.
 *
 * The source score and all of its part/event objects are read only; only the
 * top-level score, metadata and parts array are copied. Shared score-level
 * notation data (annotations, lyrics, breaks, harmonies, and so on) remains
 * available to the serializer, which naturally ignores entries that do not
 * resolve onto a selected part.
 *
 * A one-part selection gets the selected part's name as `metadata.partName`,
 * matching {@link extractPartScore}; multi-part selections preserve the
 * source metadata unchanged.
 */
export function extractPartsScore(
  score: NotatedScore,
  indices: ReadonlyArray<number>,
): NotatedScore {
  if (indices.length === 0) {
    throw new RangeError('At least one score part must be selected');
  }
  const seenIndices = new Set<number>();
  const parts = indices.map((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= score.parts.length) {
      throw new RangeError(`Unknown score part index: ${String(index)}`);
    }
    if (seenIndices.has(index)) {
      throw new RangeError(`Score part indices must be unique: ${index}`);
    }
    seenIndices.add(index);
    return score.parts[index];
  });
  const metadata =
    parts.length === 1
      ? { ...score.metadata, partName: parts[0].name }
      : score.metadata === undefined
        ? undefined
        : { ...score.metadata };
  return { ...score, metadata, parts };
}
