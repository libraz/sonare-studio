/**
 * Freeze and bounce-in-place for the arrangement track headers: the in-flight
 * render state behind the busy toggles, and the range a bounce covers.
 */

import { type Ref, ref } from 'vue';
import { describeError } from '@/lib/errors';
import { bounceTrackRange, freezeTrack, unfreezeTrack } from '@/project/freeze';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import { firstBlock } from '@/ui/disabled-reason';
import { useI18n } from '@/ui/i18n';

/** Configuration for {@link useTrackFreezeBounce}. */
export interface UseTrackFreezeBounceOptions {
  /** Transport loop props of the header list, the bounce range source. */
  props: {
    readonly loopEnabled?: boolean;
    readonly loopStartPpq?: number;
    readonly loopEndPpq?: number;
  };
  /** The header list's error banner, set when a render fails. */
  error: Ref<string>;
}

/** Freeze/bounce state and actions returned by {@link useTrackFreezeBounce}. */
export interface TrackFreezeBounce {
  /** True while the track's freeze render is pending. */
  isFreezing(track: EditorTrack): boolean;
  /** True while the track's bounce render is pending. */
  isBouncing(track: EditorTrack): boolean;
  /** Freezes an unfrozen track (async bake) or unfreezes a frozen one. */
  onToggleFreeze(track: EditorTrack): Promise<void>;
  /** True when the track has at least one clip to bounce. */
  trackHasClips(track: EditorTrack): boolean;
  /** Bounces the track in place over the loop region or its clip span. */
  onBounce(track: EditorTrack): Promise<void>;
  /** Why the freeze toggle is unavailable, or null. */
  freezeBlocked(track: EditorTrack): string | null;
  /** Why the bounce button is unavailable, or null. */
  bounceBlocked(track: EditorTrack): string | null;
}

/**
 * Creates the freeze and bounce-in-place actions for one track header list.
 *
 * @param options - The loop props a bounce reads its range from and the error banner.
 * @returns Busy state, actions and their disabled reasons.
 */
export function useTrackFreezeBounce(options: UseTrackFreezeBounceOptions): TrackFreezeBounce {
  const { props, error } = options;
  const store = useProjectStore();
  const { t } = useI18n();

  // --- Freeze & bounce-in-place ------------------------------------------------

  /** Ids of tracks with an in-flight freeze render. */
  const freezingIds = ref(new Set<number>());
  /** Ids of tracks with an in-flight bounce render. */
  const bouncingIds = ref(new Set<number>());

  /** True while the track's freeze render is pending. */
  function isFreezing(track: EditorTrack): boolean {
    return freezingIds.value.has(track.id);
  }

  /** True while the track's bounce render is pending. */
  function isBouncing(track: EditorTrack): boolean {
    return bouncingIds.value.has(track.id);
  }

  /** Freezes an unfrozen track (async bake) or unfreezes a frozen one. */
  async function onToggleFreeze(track: EditorTrack): Promise<void> {
    if (freezingIds.value.has(track.id)) return;
    if (track.frozen) {
      unfreezeTrack(track.id);
      return;
    }
    freezingIds.value.add(track.id);
    try {
      await freezeTrack(track.id);
      error.value = '';
    } catch (err) {
      error.value = describeError(err, t.value.notices.errors);
    } finally {
      freezingIds.value.delete(track.id);
    }
  }

  /** True when the track has at least one clip to bounce. */
  function trackHasClips(track: EditorTrack): boolean {
    return store.clips.some((clip) => clip.trackId === track.id);
  }

  function freezeBlocked(track: EditorTrack): string | null {
    return firstBlock([isFreezing(track), t.value.reasons.busy]);
  }

  function bounceBlocked(track: EditorTrack): string | null {
    return firstBlock([isBouncing(track), t.value.reasons.busy]);
  }

  /**
   * PPQ range a bounce covers: the transport loop region when enabled and
   * valid, otherwise the track's full clip span (null when the track has no
   * clips).
   */
  function bounceRangeFor(track: EditorTrack): { startPpq: number; endPpq: number } | null {
    const loopStart = props.loopStartPpq ?? 0;
    const loopEnd = props.loopEndPpq ?? 0;
    if (props.loopEnabled && loopStart >= 0 && loopEnd > loopStart) {
      return { startPpq: loopStart, endPpq: loopEnd };
    }
    const clips = store.clips.filter((clip) => clip.trackId === track.id);
    if (clips.length === 0) return null;
    const startPpq = Math.min(...clips.map((clip) => clip.startPpq));
    const endPpq = Math.max(...clips.map((clip) => clip.startPpq + clip.lengthPpq));
    return endPpq > startPpq ? { startPpq, endPpq } : null;
  }

  /** Bounces the track in place over the range from {@link bounceRangeFor}. */
  async function onBounce(track: EditorTrack): Promise<void> {
    if (bouncingIds.value.has(track.id)) return;
    const range = bounceRangeFor(track);
    if (range === null) return;
    bouncingIds.value.add(track.id);
    try {
      await bounceTrackRange(track.id, range.startPpq, range.endPpq);
      error.value = '';
    } catch (err) {
      error.value = describeError(err, t.value.notices.errors);
    } finally {
      bouncingIds.value.delete(track.id);
    }
  }

  return {
    isFreezing,
    isBouncing,
    onToggleFreeze,
    trackHasClips,
    onBounce,
    freezeBlocked,
    bounceBlocked,
  };
}
