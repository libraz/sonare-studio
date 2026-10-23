import { normalizeTempoMap, ppqToSeconds } from '@/project/tempo-map';
import type { ClipWarp, EditorClip, WarpAnchor } from '@/project/types';
import { isAudioClip } from '@/project/types';
import { sanitizeWarpAnchors, type WarpableClipFields, warpSegments } from '@/project/warp';

/**
 * Pure state mapping for the sample editor's clip warp (tempo-follow)
 * controls: which clip the controls edit, how partial edits merge into the
 * full warp state handed to the setClipWarp command, where a new anchor
 * lands by default, and the per-segment stretch ratio hints.
 */

/** The clip fields the warp controls read. */
export interface WarpControlsClip extends WarpableClipFields {
  /** Stable clip id (setClipWarp target). */
  id: number;
  /** Clip content kind; absent = 'midi'. */
  kind?: EditorClip['kind'];
  /** Audio asset id the clip plays. */
  assetId?: string;
  /** Cycle-recording takes; clips with takes cannot be warped. */
  takes?: EditorClip['takes'];
}

/** True when a clip can carry warp state: an audio clip without takes. */
export function isWarpableClip(clip: Pick<WarpControlsClip, 'kind' | 'takes'>): boolean {
  return isAudioClip(clip) && !clip.takes?.length;
}

/**
 * Resolves the clip whose warp state the editor controls: the active clip
 * when it is a warpable audio clip referencing the asset, else the first
 * warpable clip referencing it.
 *
 * @param clips Clip mirror in display order.
 * @param activeClipId Id of the active clip (-1 when none).
 * @param assetId Asset the editor shows.
 * @returns The matching clip, or null (hides the warp controls).
 */
export function findWarpClip<T extends WarpControlsClip>(
  clips: ReadonlyArray<T>,
  activeClipId: number,
  assetId: string,
): T | null {
  const matches = (clip: T): boolean => isWarpableClip(clip) && clip.assetId === assetId;
  const active = clips.find((clip) => clip.id === activeClipId);
  if (active && matches(active)) return active;
  return clips.find(matches) ?? null;
}

/**
 * Merges a partial warp edit into the clip's full warp state. Absent fields
 * keep their current values; a clip with no warp yet starts disabled at the
 * fallback tempo with no anchors.
 *
 * @param current The clip's current warp state, if any.
 * @param overrides Fields the edit changes.
 * @param fallbackBpm Source tempo used when the clip has none (project tempo).
 * @returns The full next state for setClipWarp (which sanitizes anchors).
 */
export function mergedWarp(
  current: ClipWarp | undefined,
  overrides: Partial<ClipWarp>,
  fallbackBpm: number,
): ClipWarp {
  return {
    enabled: current?.enabled ?? false,
    sourceBpm: current?.sourceBpm ?? fallbackBpm,
    anchors: current?.anchors ?? [],
    ...current,
    ...overrides,
  };
}

/**
 * Picks a default position for a new warp anchor: the beat midpoint of the
 * widest gap between existing anchors (clip edges included), with the source
 * time interpolated proportionally inside that gap so the new anchor keeps
 * source times strictly increasing.
 *
 * @param anchors Current anchors (clip-relative beats / source seconds).
 * @param lengthPpq Clip window length in PPQ (> 0).
 * @param sourceBpm Source tempo in BPM (> 0); maps the clip end to seconds.
 * @returns The new anchor, or null when no gap can hold one.
 */
export function defaultWarpAnchor(
  anchors: ReadonlyArray<WarpAnchor>,
  lengthPpq: number,
  sourceBpm: number,
): WarpAnchor | null {
  if (!(lengthPpq > 0) || !(sourceBpm > 0)) return null;
  const points: WarpAnchor[] = [
    { ppq: 0, sourceSeconds: 0 },
    ...sanitizeWarpAnchors(anchors, lengthPpq),
    { ppq: lengthPpq, sourceSeconds: (lengthPpq * 60) / sourceBpm },
  ];
  let best: WarpAnchor | null = null;
  let bestGap = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const gap = points[i + 1].ppq - points[i].ppq;
    const sourceGap = points[i + 1].sourceSeconds - points[i].sourceSeconds;
    if (gap <= bestGap || sourceGap <= 0) continue;
    bestGap = gap;
    best = {
      ppq: points[i].ppq + gap / 2,
      sourceSeconds: points[i].sourceSeconds + sourceGap / 2,
    };
  }
  return best;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Converts detected beat/downbeat source times into a clip warp map. The first
 * beat becomes the clip start and beat k lands on PPQ k; irregular source
 * spacing is captured as anchors while the median beat interval becomes
 * sourceBpm and sets the source end. Start and end are in the beat times' own
 * time base, anchors relative to the start.
 */
export function autoWarpFromBeatTimes(
  beatTimes: ReadonlyArray<number>,
  downbeatTimes: ReadonlyArray<number> = [],
  lengthPpq: number,
):
  | (Pick<ClipWarp, 'sourceBpm' | 'anchors'> & {
      sourceStartSeconds: number;
      sourceEndSeconds: number;
    })
  | null {
  const beats = [...new Set(beatTimes.filter((time) => Number.isFinite(time) && time >= 0))].sort(
    (a, b) => a - b,
  );
  if (beats.length < 2 || !(lengthPpq > 0)) return null;
  const intervals = beats
    .slice(1)
    .map((time, index) => time - beats[index])
    .filter((interval) => interval > 0);
  const medianInterval = median(intervals);
  if (medianInterval === null || !(medianInterval > 0)) return null;
  const sourceBpm = 60 / medianInterval;
  const firstBeat = beats[0];
  const toAnchor = (time: number) => ({
    ppq: Math.round((time - firstBeat) / medianInterval),
    sourceSeconds: time - firstBeat,
  });
  const anchors = beats.map(toAnchor).filter((anchor) => anchor.ppq > 0 && anchor.ppq < lengthPpq);
  const downbeatAnchors = downbeatTimes
    .filter((time) => Number.isFinite(time) && time >= 0)
    .map(toAnchor)
    .filter((anchor) => anchor.ppq > 0 && anchor.ppq < lengthPpq);
  return {
    sourceBpm,
    anchors: sanitizeWarpAnchors([...anchors, ...downbeatAnchors], lengthPpq),
    sourceStartSeconds: firstBeat,
    sourceEndSeconds: firstBeat + lengthPpq * medianInterval,
  };
}

/**
 * Computes the stretch ratio of each warp segment at the given project
 * tempo: source seconds over played seconds, so 1 plays at the recorded
 * rate, above 1 speeds the segment up and below 1 slows it down.
 *
 * @param clip Clip window and warp state.
 * @param projectBpm Project tempo in BPM (> 0), used as the fallback map.
 * @param tempoSegments Optional project tempo map for variable-tempo projects.
 * @returns One ratio per segment; empty when the clip does not warp.
 */
export function segmentStretchRatios(
  clip: WarpableClipFields,
  projectBpm: number,
  tempoSegments: Parameters<typeof normalizeTempoMap>[0] = [],
): number[] {
  if (!(projectBpm > 0)) return [];
  const tempoMap = normalizeTempoMap(tempoSegments, projectBpm);
  const clipStartPpq = clip.startPpq ?? 0;
  return warpSegments(clip).map(
    (segment) =>
      segment.sourceLengthSeconds /
      (ppqToSeconds(tempoMap, clipStartPpq + segment.ppq + segment.lengthPpq) -
        ppqToSeconds(tempoMap, clipStartPpq + segment.ppq)),
  );
}
