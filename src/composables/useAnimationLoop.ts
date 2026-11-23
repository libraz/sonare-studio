import { onBeforeUnmount } from 'vue';

/** Longest frame step handed to a frame callback; a stalled tab resumes without a jump. */
export const MAX_FRAME_DT_SECONDS = 0.1;

/** Handle returned by {@link useAnimationLoop}. */
export interface AnimationLoop {
  /** Schedules the loop unless it is disabled or already running. */
  start(): void;
  /** Cancels the loop; the next start reports a zero step on its first frame. */
  stop(): void;
}

/**
 * A requestAnimationFrame loop owned by the calling component and cancelled on
 * unmount. `frame` receives the frame timestamp and the seconds since the
 * previous frame (0 on the first, capped at {@link MAX_FRAME_DT_SECONDS}).
 * When `enabled` turns false the loop parks itself until the next `start`.
 *
 * @param frame - Draws one frame; runs after the next frame was requested.
 * @param enabled - Whether the loop may run; defaults to always.
 */
export function useAnimationLoop(
  frame: (ts: number, dt: number) => void,
  enabled: () => boolean = () => true,
): AnimationLoop {
  let raf = 0;
  let lastTs = 0;

  function loop(ts: number): void {
    if (!enabled()) {
      raf = 0;
      return;
    }
    raf = requestAnimationFrame(loop);
    const dt = lastTs > 0 ? Math.min((ts - lastTs) / 1000, MAX_FRAME_DT_SECONDS) : 0;
    lastTs = ts;
    frame(ts, dt);
  }

  function start(): void {
    if (!enabled() || raf !== 0) return;
    raf = requestAnimationFrame(loop);
  }

  function stop(): void {
    if (raf !== 0) cancelAnimationFrame(raf);
    raf = 0;
    lastTs = 0;
  }

  onBeforeUnmount(stop);

  return { start, stop };
}
