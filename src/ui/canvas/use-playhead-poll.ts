import { onBeforeUnmount, onMounted } from 'vue';

/** Handle returned by {@link usePlayheadPoll}. */
export interface PlayheadPoll {
  /** Forgets the last column so the next frame reports a move even when it did not change. */
  invalidate(): void;
}

/**
 * Polls the playhead column once per animation frame while mounted and calls
 * `onMove` only when it changed, so playback repaints an overlay instead of the
 * whole canvas.
 *
 * @param column - The playhead's local x in px, or undefined while there is none.
 * @param onMove - Schedules the overlay repaint.
 */
export function usePlayheadPoll(
  column: () => number | undefined,
  onMove: () => void,
): PlayheadPoll {
  let raf: number | null = null;
  let lastX = Number.NaN;

  function tick(): void {
    const x = column();
    if (x !== undefined && x !== lastX) {
      lastX = x;
      onMove();
    }
    raf = requestAnimationFrame(tick);
  }

  onMounted(() => {
    raf = requestAnimationFrame(tick);
  });

  onBeforeUnmount(() => {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  });

  return {
    invalidate(): void {
      lastX = Number.NaN;
    },
  };
}
