import { clamp } from '@/lib/math';
/**
 * Geometry helpers for the arrangement section lane: locating sections,
 * deriving the span of a newly created section and clamping edge resizes.
 * Pure logic: no DOM, no framework imports.
 *
 * Sections are assumed sorted by startPpq and non-overlapping (the section
 * command keeps them that way).
 */

/** A section's extent on the timeline. */
export interface SectionSpan {
  /** Section start in PPQ (>= 0). */
  startPpq: number;
  /** Section end in PPQ (> startPpq). */
  endPpq: number;
}

/** Minimum section length kept by an edge resize, in PPQ (one quarter note). */
export const MIN_SECTION_LENGTH_PPQ = 1;

/**
 * Returns the index of the section containing a PPQ position, or -1 when the
 * position falls in a gap. Section ranges are [startPpq, endPpq).
 *
 * @param sections - Sections sorted by startPpq.
 * @param ppq - Position in PPQ.
 */
export function sectionIndexAt(sections: ReadonlyArray<SectionSpan>, ppq: number): number {
  return sections.findIndex((section) => ppq >= section.startPpq && ppq < section.endPpq);
}

/**
 * Derives the span of a section created in the gap around `ppq`.
 *
 * The new section starts at the containing bar (clamped so it does not eat
 * into the previous section) and spans to the next section's start, or to
 * `defaultLengthPpq` after its start when there is no next section.
 *
 * @param sections - Existing sections sorted by startPpq.
 * @param ppq - Position the user clicked, in PPQ.
 * @param barStartPpq - Start of the bar containing `ppq` (<= ppq).
 * @param defaultLengthPpq - Length used when no section follows (> 0).
 * @returns The new span, or null when `ppq` lies inside an existing section
 *   or the derived span would be empty.
 */
export function newSectionSpan(
  sections: ReadonlyArray<SectionSpan>,
  ppq: number,
  barStartPpq: number,
  defaultLengthPpq: number,
): SectionSpan | null {
  if (ppq < 0 || sectionIndexAt(sections, ppq) !== -1) return null;
  let previousEnd = 0;
  let nextStart = Number.POSITIVE_INFINITY;
  for (const section of sections) {
    if (section.endPpq <= ppq) previousEnd = Math.max(previousEnd, section.endPpq);
    if (section.startPpq > ppq) nextStart = Math.min(nextStart, section.startPpq);
  }
  const startPpq = Math.max(0, Math.min(barStartPpq, ppq), previousEnd);
  const endPpq = Number.isFinite(nextStart) ? nextStart : startPpq + defaultLengthPpq;
  if (!(endPpq > startPpq)) return null;
  return { startPpq, endPpq };
}

/**
 * Clamps the target position of a section edge drag so the section keeps a
 * minimum length and never overlaps its neighbors.
 *
 * @param sections - Sections sorted by startPpq.
 * @param index - Index of the section being resized.
 * @param edge - Which edge is dragged.
 * @param targetPpq - Desired edge position in PPQ.
 * @param minLengthPpq - Minimum section length. Default {@link MIN_SECTION_LENGTH_PPQ}.
 * @returns The clamped edge position in PPQ.
 */
export function clampSectionEdge(
  sections: ReadonlyArray<SectionSpan>,
  index: number,
  edge: 'start' | 'end',
  targetPpq: number,
  minLengthPpq: number = MIN_SECTION_LENGTH_PPQ,
): number {
  const section = sections[index];
  if (!section) return Math.max(0, targetPpq);
  if (edge === 'start') {
    const lower = index > 0 ? sections[index - 1].endPpq : 0;
    const upper = section.endPpq - minLengthPpq;
    return clamp(targetPpq, lower, upper);
  }
  const lower = section.startPpq + minLengthPpq;
  const upper =
    index + 1 < sections.length ? sections[index + 1].startPpq : Number.POSITIVE_INFINITY;
  return clamp(targetPpq, lower, upper);
}
