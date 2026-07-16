import {
  type NormalizedTempoMap,
  ppqRangeSeconds,
  ppqToSeconds,
  secondsToPpq,
} from '@/project/tempo-map';

/** Absolute timeline position corresponding to content-time zero. */
export function audioContentOriginPpq(clipStartPpq: number, sourceOffsetPpq: number): number {
  return clipStartPpq - sourceOffsetPpq;
}

/** Converts a content-relative PPQ position to seconds at its timeline anchor. */
export function audioContentPpqToSeconds(
  tempoMap: NormalizedTempoMap,
  contentOriginPpq: number,
  contentPpq: number,
): number {
  return ppqRangeSeconds(tempoMap, contentOriginPpq, contentOriginPpq + contentPpq);
}

/** Inverse of {@link audioContentPpqToSeconds} for the same content origin. */
export function audioContentSecondsToPpq(
  tempoMap: NormalizedTempoMap,
  contentOriginPpq: number,
  contentSeconds: number,
): number {
  return (
    secondsToPpq(tempoMap, ppqToSeconds(tempoMap, contentOriginPpq) + contentSeconds) -
    contentOriginPpq
  );
}

/**
 * Recovers a clip's content origin from a seconds-valued playStart. The
 * playhead itself is anchored at clipStartPpq, so this remains the exact
 * inverse even when a trim crosses tempo changes or a tempo ramp.
 */
export function audioContentOriginFromPlayStartSeconds(
  tempoMap: NormalizedTempoMap,
  clipStartPpq: number,
  playStartSeconds: number,
): number {
  return secondsToPpq(
    tempoMap,
    ppqToSeconds(tempoMap, clipStartPpq) - Math.max(0, playStartSeconds),
  );
}

/** Converts a seconds-valued clip fade to PPQ at the correct clip edge. */
export function audioFadeSecondsToPpq(
  tempoMap: NormalizedTempoMap,
  clipStartPpq: number,
  clipLengthPpq: number,
  fadeSeconds: number,
  edge: 'in' | 'out',
): number {
  const seconds = Math.max(0, fadeSeconds);
  if (edge === 'in') {
    return Math.max(
      0,
      secondsToPpq(tempoMap, ppqToSeconds(tempoMap, clipStartPpq) + seconds) - clipStartPpq,
    );
  }
  const clipEndPpq = clipStartPpq + clipLengthPpq;
  return Math.max(
    0,
    clipEndPpq - secondsToPpq(tempoMap, ppqToSeconds(tempoMap, clipEndPpq) - seconds),
  );
}
