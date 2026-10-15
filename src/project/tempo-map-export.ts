/**
 * Tempo and meter map translation shared by the file exporters (SMF,
 * DAWproject). Both write the map exactly as realtime playback performs it:
 * sorted, with the final segment held (it never ramps) and, for a partial
 * export, rebased so the exported window starts at ppq 0.
 */

import { normalizeTempoMap, tempoAtPpq } from './tempo-map';
import type { TempoSegment, TimeSignatureSegment } from './types';

/** Tempo and meter maps ready to be written by an exporter. */
export interface ExportTempoMap {
  /** Sorted tempo segments; only segments followed by another may carry an end tempo. */
  tempoSegments: TempoSegment[];
  /** Sorted time-signature segments. */
  timeSignatures: TimeSignatureSegment[];
}

/**
 * Translates the project tempo and meter maps for export.
 *
 * With a non-zero `offsetPpq` the segment active at the offset is moved to
 * ppq 0 (a ramp in progress starts at its interpolated tempo) and later
 * segments are shifted back by the offset; earlier ones are dropped.
 *
 * @param tempoSegments Project tempo segments in any order.
 * @param timeSignatures Project time-signature segments in any order.
 * @param offsetPpq Arrangement position the exported window starts at.
 * @returns Translated copies; the inputs are not modified.
 */
export function translateTempoMapForExport(
  tempoSegments: ReadonlyArray<TempoSegment>,
  timeSignatures: ReadonlyArray<TimeSignatureSegment>,
  offsetPpq = 0,
): ExportTempoMap {
  const sorted = [...tempoSegments].sort((a, b) => a.startPpq - b.startPpq);
  const sortedSignatures = [...timeSignatures].sort((a, b) => a.startPpq - b.startPpq);
  const tempoMap = normalizeTempoMap(sorted);

  const tempo: TempoSegment[] = [];
  let activeIndex = -1;
  sorted.forEach((segment, index) => {
    if (segment.startPpq <= offsetPpq) activeIndex = index;
  });
  const firstIndex = Math.max(activeIndex, 0);
  for (let i = firstIndex; i < sorted.length; i += 1) {
    const segment = sorted[i];
    const next = sorted[i + 1];
    const isActive = i === firstIndex && segment.startPpq <= offsetPpq;
    const out: TempoSegment = {
      startPpq: isActive ? 0 : segment.startPpq - offsetPpq,
      bpm: isActive ? tempoAtPpq(tempoMap, offsetPpq) : segment.bpm,
    };
    const ramps =
      next !== undefined &&
      segment.endBpm !== undefined &&
      segment.endBpm > 0 &&
      segment.endBpm !== segment.bpm;
    if (ramps) out.endBpm = segment.endBpm;
    tempo.push(out);
  }
  if (tempo.length === 0 || (activeIndex < 0 && offsetPpq > 0)) {
    tempo.unshift({ startPpq: 0, bpm: tempoAtPpq(tempoMap, offsetPpq) });
  }

  const meter: TimeSignatureSegment[] = [];
  let activeSignature = -1;
  sortedSignatures.forEach((signature, index) => {
    if (signature.startPpq <= offsetPpq) activeSignature = index;
  });
  for (let i = Math.max(activeSignature, 0); i < sortedSignatures.length; i += 1) {
    const signature = sortedSignatures[i];
    const shifted = signature.startPpq <= offsetPpq ? 0 : signature.startPpq - offsetPpq;
    meter.push({
      ...signature,
      ...(signature.grouping ? { grouping: [...signature.grouping] } : {}),
      startPpq: shifted,
    });
  }
  return { tempoSegments: tempo, timeSignatures: meter };
}
