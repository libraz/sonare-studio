import type { useProjectStore } from '../store';
import { clipKind } from '../types';

/**
 * Revision of what an audio clip analysis renders: the clip's audible window
 * fields and the tempo map. A result computed under one revision is stale once
 * the revision changes; null when the clip is gone or no longer audio.
 */
export function audioAnalysisSourceRevision(
  store: ReturnType<typeof useProjectStore>,
  clipId: number,
): string | null {
  const clip = store.clips.find((entry) => entry.id === clipId);
  if (!clip || clipKind(clip) !== 'audio') return null;
  return JSON.stringify({
    clip: {
      id: clip.id,
      trackId: clip.trackId,
      assetId: clip.assetId,
      startPpq: clip.startPpq,
      lengthPpq: clip.lengthPpq,
      sourceOffsetPpq: clip.sourceOffsetPpq,
      loopEnabled: clip.loopEnabled,
      loopLengthPpq: clip.loopLengthPpq,
      takes: clip.takes,
      compSegments: clip.compSegments,
      warp: clip.warp,
    },
    tempoBpm: store.tempoBpm,
    tempoSegments: store.tempoSegments,
  });
}
