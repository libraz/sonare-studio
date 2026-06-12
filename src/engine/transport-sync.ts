/**
 * Realtime transport synchronisation: mirrors the store's tempo segments,
 * time-signature segments and timeline markers onto a running engine,
 * transmitting only what changed.
 *
 * Engine contract (libsonare):
 * - setTempoSegments and setTimeSignatureSegments each replace the whole
 *   segment set in one call; segments are sent sorted by startPpq. The engine
 *   always needs at least one segment, so a default (120 BPM / 4/4) is sent
 *   when the store has none.
 * - setMarkers replaces the whole marker set. Entries carrying an `id` keep
 *   it (ids must be positive and unique within the list); the editor's marker
 *   ids are positive integers and are passed through, so they stay valid for
 *   the engine's seekMarker / setLoopFromMarkers.
 */

import type { EditorMarker, TempoSegment, TimeSignatureSegment } from '@/project/types';
import type { EngineHandle } from './engine';

/** Tempo sent when the project has no tempo segments. */
const DEFAULT_TEMPO_BPM = 120;

/** Time signature sent when the project has no time-signature segments. */
const DEFAULT_TIME_SIGNATURE = { numerator: 4, denominator: 4 };

/** Options for {@link createTransportSync}. */
export interface TransportSyncOptions {
  /** Tempo used when the project has no tempo segments (default 120). */
  fallbackBpm?: number;
}

/** Mirrors store transport state (tempo, meter, markers) onto a running engine. */
export interface TransportSync {
  /** Diffs and pushes tempo segments, time signatures and markers to the engine. */
  sync(
    tempoSegments: ReadonlyArray<TempoSegment>,
    timeSignatures: ReadonlyArray<TimeSignatureSegment>,
    markers: ReadonlyArray<EditorMarker>,
  ): void;
}

/**
 * Creates a transport sync bound to one engine handle. Create a fresh
 * instance per engine start: all sent-state memory restarts with the engine.
 * Engine errors propagate to the caller; a failed family is re-sent on the
 * next sync.
 *
 * @param handle Running engine handle from createEngine.
 * @param options Optional fallback tempo override.
 * @returns The sync facade.
 */
export function createTransportSync(
  handle: EngineHandle,
  options: TransportSyncOptions = {},
): TransportSync {
  const fallbackBpm = options.fallbackBpm ?? DEFAULT_TEMPO_BPM;
  let lastTempoKey: string | undefined;
  let lastTimeSignatureKey: string | undefined;
  let lastMarkersKey: string | undefined;

  const sync = (
    tempoSegments: ReadonlyArray<TempoSegment>,
    timeSignatures: ReadonlyArray<TimeSignatureSegment>,
    markers: ReadonlyArray<EditorMarker>,
  ): void => {
    const effectiveTempo =
      tempoSegments.length > 0
        ? [...tempoSegments]
            .sort((a, b) => a.startPpq - b.startPpq)
            .map((segment) =>
              segment.endBpm === undefined
                ? { startPpq: segment.startPpq, bpm: segment.bpm }
                : { startPpq: segment.startPpq, bpm: segment.bpm, endBpm: segment.endBpm },
            )
        : [{ startPpq: 0, bpm: fallbackBpm }];
    const tempoKey = JSON.stringify(effectiveTempo);
    if (tempoKey !== lastTempoKey) {
      handle.engine.setTempoSegments(effectiveTempo);
      lastTempoKey = tempoKey;
    }

    const effectiveTimeSignatures =
      timeSignatures.length > 0
        ? [...timeSignatures]
            .sort((a, b) => a.startPpq - b.startPpq)
            .map((segment) => ({
              startPpq: segment.startPpq,
              numerator: segment.numerator,
              denominator: segment.denominator,
            }))
        : [{ startPpq: 0, ...DEFAULT_TIME_SIGNATURE }];
    const timeSignatureKey = JSON.stringify(effectiveTimeSignatures);
    if (timeSignatureKey !== lastTimeSignatureKey) {
      handle.engine.setTimeSignatureSegments(effectiveTimeSignatures);
      lastTimeSignatureKey = timeSignatureKey;
    }

    const effectiveMarkers = [...markers]
      .sort((a, b) => a.ppq - b.ppq)
      .map((marker) => ({ id: marker.id, ppq: marker.ppq, name: marker.name }));
    const markersKey = JSON.stringify(effectiveMarkers);
    if (markersKey !== lastMarkersKey) {
      handle.engine.setMarkers(effectiveMarkers);
      lastMarkersKey = markersKey;
    }
  };

  return { sync };
}
