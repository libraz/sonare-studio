/** Writes the tempo and meter map: the Transport element and its tempo/time-signature automation. */

import type { ProjectDocument } from '@/project/serialization';
import { DEFAULT_TEMPO_BPM } from '@/project/tempo-map';
import { DEFAULT_TIME_SIGNATURE } from '@/project/time-signature';
import type { TempoSegment, TimeSignatureSegment } from '@/project/types';
import type { XmlElement } from './xml';

/** Id of the Transport tempo parameter (tempo automation targets it). */
const TEMPO_PARAMETER_ID = 'tempo';

/** Id of the Transport time-signature parameter. */
const TIME_SIGNATURE_PARAMETER_ID = 'time-signature';

/** Builds the Transport element (first tempo segment + first time signature). */
export function transportElement(doc: ProjectDocument): XmlElement {
  const bpm = doc.tempoSegments[0]?.bpm ?? DEFAULT_TEMPO_BPM;
  const signature = doc.timeSignatures[0] ?? DEFAULT_TIME_SIGNATURE;
  return {
    name: 'Transport',
    children: [
      {
        name: 'Tempo',
        attributes: { id: TEMPO_PARAMETER_ID, unit: 'bpm', min: 20, max: 999, value: bpm },
      },
      {
        name: 'TimeSignature',
        attributes: {
          id: TIME_SIGNATURE_PARAMETER_ID,
          numerator: signature.numerator,
          denominator: signature.denominator,
        },
      },
    ],
  };
}

/**
 * Builds the tempo automation points: one point per segment start, plus a
 * ramp-end point (linear interpolation) for segments carrying an end tempo.
 * Expects a map from `translateTempoMapForExport`, where only segments
 * followed by another carry an end tempo.
 */
export function tempoAutomationElement(segments: ReadonlyArray<TempoSegment>): XmlElement {
  const points: XmlElement[] = [{ name: 'Target', attributes: { parameter: TEMPO_PARAMETER_ID } }];
  const pushPoint = (time: number, value: number, interpolation: string): void => {
    const last = points[points.length - 1];
    // Collapse an identical adjacent point so round-trips stay idempotent
    // (points that merely share a time but differ in tempo are preserved).
    if (
      last.name === 'RealPoint' &&
      last.attributes?.time === time &&
      last.attributes?.value === value &&
      last.attributes?.interpolation === interpolation
    ) {
      return;
    }
    points.push({ name: 'RealPoint', attributes: { time, value, interpolation } });
  };
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const next = segments[i + 1];
    const ramp = next !== undefined && segment.endBpm !== undefined;
    pushPoint(segment.startPpq, segment.bpm, ramp ? 'linear' : 'hold');
    if (ramp && next.startPpq > segment.startPpq) {
      pushPoint(next.startPpq, segment.endBpm as number, 'hold');
    }
  }
  return {
    name: 'TempoAutomation',
    attributes: { id: 'tempo-automation', unit: 'bpm' },
    children: points,
  };
}

/** Builds the time-signature automation points (one per document segment). */
export function timeSignatureAutomationElement(
  timeSignatures: ReadonlyArray<TimeSignatureSegment>,
): XmlElement {
  return {
    name: 'TimeSignatureAutomation',
    attributes: { id: 'time-signature-automation' },
    children: [
      { name: 'Target', attributes: { parameter: TIME_SIGNATURE_PARAMETER_ID } },
      ...timeSignatures.map(
        (segment): XmlElement => ({
          name: 'TimeSignaturePoint',
          attributes: {
            time: segment.startPpq,
            numerator: segment.numerator,
            denominator: segment.denominator,
          },
        }),
      ),
    ],
  };
}
