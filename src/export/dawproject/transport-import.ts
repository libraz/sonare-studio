/** Reads the tempo and meter map from the Transport and its tempo/time-signature automation. */

import type { DocumentTempoSegment, DocumentTimeSignature } from '@/project/serialization';
import { DEFAULT_TIME_SIGNATURE } from '@/project/time-signature';
import { numberAttr } from './xml-read';

const DEFAULT_TEMPO = 120;

export function readTempo(project: Document): DocumentTempoSegment[] {
  const transportTempo =
    numberAttr(project.querySelector('Transport > Tempo'), 'value') ?? DEFAULT_TEMPO;
  const points = Array.from(project.querySelectorAll('Arrangement > TempoAutomation > RealPoint'))
    .map((point) => ({
      time: numberAttr(point, 'time'),
      value: numberAttr(point, 'value'),
      interpolation: point.getAttribute('interpolation') ?? 'hold',
    }))
    .filter((point): point is { time: number; value: number; interpolation: string } => {
      return point.time !== null && point.value !== null && point.value > 0;
    })
    .sort((a, b) => a.time - b.time);
  if (points.length === 0) return [{ startPpq: 0, bpm: transportTempo }];

  const grouped = new Map<number, (typeof points)[number][]>();
  for (const point of points) {
    const group = grouped.get(point.time);
    if (group) group.push(point);
    else grouped.set(point.time, [point]);
  }

  // `points` is sorted, so the first point after a group is the next distinct time.
  let nextIndex = 0;
  return [...grouped.entries()].map(([time, group]) => {
    const point = group[group.length - 1];
    nextIndex += group.length;
    const segment: DocumentTempoSegment = { startPpq: time, bpm: point.value };
    if (point.interpolation === 'linear') {
      const end = points[nextIndex];
      if (end) segment.endBpm = end.value;
    }
    return segment;
  });
}

export function readTimeSignatures(project: Document): DocumentTimeSignature[] {
  const points = Array.from(
    project.querySelectorAll('Arrangement > TimeSignatureAutomation > TimeSignaturePoint'),
  )
    .map((point) => ({
      startPpq: numberAttr(point, 'time'),
      numerator: numberAttr(point, 'numerator'),
      denominator: numberAttr(point, 'denominator'),
    }))
    .filter(
      (point): point is DocumentTimeSignature =>
        point.startPpq !== null &&
        point.numerator !== null &&
        point.denominator !== null &&
        point.numerator > 0 &&
        point.denominator > 0,
    );
  if (points.length > 0) return points;

  const transport = project.querySelector('Transport > TimeSignature');
  return [
    {
      startPpq: 0,
      numerator: numberAttr(transport, 'numerator') ?? DEFAULT_TIME_SIGNATURE.numerator,
      denominator: numberAttr(transport, 'denominator') ?? DEFAULT_TIME_SIGNATURE.denominator,
    },
  ];
}
