/**
 * Playhead-follow scrolling shared by the arrangement and the piano roll.
 *
 * While playing with follow enabled, the playhead is pinned at a fixed local
 * column and the timeline scrolls under it. Each scroll bumps the editor's
 * revision, which repaints the whole base layer, so the scroll is throttled to
 * ~30 Hz, smoothed, and skips sub-pixel moves; the overlay playhead still
 * tracks every frame on its own cheap layer. While stopped, a seek that lands
 * outside the viewport scrolls the sought position back into view.
 */

import { onBeforeUnmount, onMounted, watch } from 'vue';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import {
  anchoredPlayheadFollowStart,
  PLAYHEAD_FOLLOW_ANCHOR_X,
  revealPlayheadStart,
} from './playhead-follow';

/** Per-frame horizontal follow interpolation. */
const PLAYHEAD_FOLLOW_SMOOTHING = 0.42;
/** Small PPQ threshold below which snapping avoids endless tiny repaints. */
const PLAYHEAD_FOLLOW_EPSILON_PPQ = 0.0005;
/** Follow scrolling redraws the full base layer, so cap it below display refresh. */
const PLAYHEAD_FOLLOW_INTERVAL_MS = 33;
/** Ignore sub-pixel follow movement; the overlay playhead still updates every frame. */
const PLAYHEAD_FOLLOW_MIN_PX = 1;

/** Inputs the playhead follow reads. */
export interface PlayheadFollowOptions {
  /** Timeline viewport that is scrolled. */
  range: TimelineRange;
  /** Invalidates the editor's views after a range mutation. */
  bump: () => void;
  /** Whether the transport is playing. */
  isPlaying: () => boolean;
  /** Whether the user enabled scroll-follow. */
  followEnabled: () => boolean;
  /** Playhead position in the editor's PPQ frame, or undefined when there is none. */
  positionPpq: () => number | undefined;
  /** Width of the fixed column left of the timeline (track header, keyboard). */
  leadingColumnWidthPx: number;
}

/** Handle exposing the follow controls the editor still needs. */
export interface PlayheadFollow {
  /** Local column the overlay pins the playhead to while following, else null. */
  followAnchorLocalX(): number | null;
  /** Restarts the follow loop when following is active, else stops it. */
  restart(): void;
}

/**
 * Wires playhead-follow scrolling to a timeline range. Must run in component
 * setup: it registers watchers and mount/unmount hooks.
 *
 * @param options - Range, state getters and layout offset.
 * @returns Anchor and restart controls.
 */
export function usePlayheadFollow(options: PlayheadFollowOptions): PlayheadFollow {
  const { range, bump } = options;
  const anchorLocalX = Math.max(0, PLAYHEAD_FOLLOW_ANCHOR_X - options.leadingColumnWidthPx);
  let followRaf: number | null = null;
  let lastFollowFrameMs = 0;

  const following = (): boolean => options.isPlaying() && options.followEnabled();

  function stop(): void {
    if (followRaf !== null) cancelAnimationFrame(followRaf);
    followRaf = null;
  }

  function tick(now = performance.now()): void {
    followRaf = null;
    if (!following()) return;
    if (now - lastFollowFrameMs < PLAYHEAD_FOLLOW_INTERVAL_MS) {
      followRaf = requestAnimationFrame(tick);
      return;
    }
    lastFollowFrameMs = now;
    const ppq = options.positionPpq();
    if (ppq !== undefined) {
      const nextStart = anchoredPlayheadFollowStart(range, ppq, anchorLocalX);
      if (nextStart !== null) {
        const delta = nextStart - range.startPpq;
        if (Math.abs(delta * range.pxPerPpq) >= PLAYHEAD_FOLLOW_MIN_PX) {
          const smoothed =
            Math.abs(delta) <= PLAYHEAD_FOLLOW_EPSILON_PPQ
              ? nextStart
              : range.startPpq + delta * PLAYHEAD_FOLLOW_SMOOTHING;
          range.setStartPpq(smoothed);
          bump();
        }
      }
    }
    followRaf = requestAnimationFrame(tick);
  }

  function start(): void {
    if (followRaf !== null || typeof requestAnimationFrame !== 'function') return;
    lastFollowFrameMs = 0;
    followRaf = requestAnimationFrame(tick);
  }

  watch(
    () => [options.isPlaying(), options.followEnabled()],
    ([playing, follow]) => {
      if (playing && follow) start();
      else stop();
    },
  );

  // A seek while stopped nudges nothing else horizontally, so scroll the sought
  // position back into view when it lands outside the viewport. During playback
  // the follow loop owns scrolling, so skip it there.
  watch(
    () => options.positionPpq(),
    (ppq) => {
      if (options.isPlaying() || ppq === undefined) return;
      const nextStart = revealPlayheadStart(range, ppq, anchorLocalX);
      if (nextStart !== null) {
        range.setStartPpq(nextStart);
        bump();
      }
    },
  );

  onMounted(() => {
    if (following()) start();
  });
  onBeforeUnmount(stop);

  return {
    followAnchorLocalX: () => (following() ? anchorLocalX : null),
    restart: () => {
      stop();
      if (following()) start();
    },
  };
}
