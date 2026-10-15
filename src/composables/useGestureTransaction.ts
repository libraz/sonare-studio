/**
 * One undo transaction per pointer gesture. A drag emits many samples; the
 * transaction snapshots the state once at `begin`, lets the caller mark the
 * gesture dirty as samples change something, and commits a single entry at
 * `end`. A gesture that never changed anything commits nothing, and `move`
 * reports when the pointer has travelled far enough to count as a drag.
 */

import { DRAG_THRESHOLD_PX } from '@/ui/canvas/drag-threshold';

/** Options for {@link useGestureTransaction}. */
export interface GestureTransactionOptions<S> {
  /** Records the pre-gesture state; called once with the snapshot of a dirty gesture. */
  commit(before: S): void;
  /** Pointer travel in px before {@link GestureTransaction.move} reports a drag. Default 3. */
  thresholdPx?: number;
}

/** Handle returned by {@link useGestureTransaction}. */
export interface GestureTransaction<S> {
  /** True between `begin` and `end`/`cancel`. */
  readonly active: boolean;
  /**
   * Opens a gesture, ending any gesture still open.
   *
   * @param before - Pre-gesture state to hand to `commit`.
   * @param x - Pointer x at press.
   * @param y - Pointer y at press.
   */
  begin(before: S, x?: number, y?: number): void;
  /** Reports whether the pointer has left the press point by the threshold (sticky once true). */
  move(x: number, y: number): boolean;
  /** Marks the open gesture as having changed state; ignored when none is open. */
  markDirty(): void;
  /** Closes the gesture, committing one entry when it was marked dirty. */
  end(): void;
  /** Discards the gesture without committing. */
  cancel(): void;
}

/**
 * Creates a gesture transaction.
 *
 * @param options - Commit callback and drag threshold.
 */
export function useGestureTransaction<S>(
  options: GestureTransactionOptions<S>,
): GestureTransaction<S> {
  const threshold = options.thresholdPx ?? DRAG_THRESHOLD_PX;
  let open = false;
  let before: S | undefined;
  let dirty = false;
  let dragged = false;
  let originX = 0;
  let originY = 0;

  function reset(): void {
    open = false;
    before = undefined;
    dirty = false;
    dragged = false;
  }

  function end(): void {
    if (!open) return;
    const snapshot = before as S;
    const changed = dirty;
    reset();
    if (changed) options.commit(snapshot);
  }

  return {
    get active() {
      return open;
    },
    begin(snapshot, x = 0, y = 0) {
      end();
      open = true;
      before = snapshot;
      originX = x;
      originY = y;
    },
    move(x, y) {
      if (!open) return false;
      if (!dragged && Math.hypot(x - originX, y - originY) >= threshold) dragged = true;
      return dragged;
    },
    markDirty() {
      if (open) dirty = true;
    },
    end,
    cancel: reset,
  };
}
