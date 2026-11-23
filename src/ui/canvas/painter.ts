/**
 * Minimal requestAnimationFrame batcher for layered canvas redraws.
 *
 * Callers mark layers dirty via `schedule`; one animation frame later every
 * dirty layer's draw callback runs exactly once. Contains no canvas-specific
 * logic — it only batches and invokes callbacks.
 */

/** Redraw callback for one layer. */
export type DrawFn = () => void;

/** Batches per-layer draw callbacks into single animation frames. */
export interface Painter {
  /**
   * Marks a layer dirty and stores its draw callback. Scheduling the same
   * layer again before the flush replaces the callback; the layer is still
   * drawn only once per frame.
   *
   * @param layer - Layer name (one draw per name per frame).
   * @param draw - Callback invoked at the next flush.
   */
  schedule(layer: string, draw: DrawFn): void;
  /** Cancels any pending frame and ignores all further scheduling. */
  dispose(): void;
}

/** Options for {@link createPainter}; frame hooks are injectable for testing. */
export interface PainterOptions {
  /** Frame scheduler. Default `globalThis.requestAnimationFrame`. */
  requestFrame?: (callback: FrameRequestCallback) => number;
  /** Frame canceller. Default `globalThis.cancelAnimationFrame`. */
  cancelFrame?: (handle: number) => void;
}

/**
 * Creates a painter that coalesces draw scheduling into one rAF per frame.
 *
 * Draw callbacks run in the order their layers were first scheduled. A draw
 * callback may call `schedule` again; such requests land in the next frame.
 * A throwing callback does not stop the others; the frame rethrows afterwards.
 *
 * @param options - Optional frame scheduling hooks.
 * @returns A painter instance.
 */
export function createPainter(options: PainterOptions = {}): Painter {
  const requestFrame =
    options.requestFrame ?? ((callback: FrameRequestCallback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));

  let dirty = new Map<string, DrawFn>();
  let frameHandle: number | null = null;
  let disposed = false;

  const flush = (): void => {
    frameHandle = null;
    const layers = dirty;
    dirty = new Map();
    // One failing layer must not drop the others: draw them all, then surface the failure.
    const errors: unknown[] = [];
    for (const draw of layers.values()) {
      try {
        draw();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Several canvas layers failed to draw');
  };

  return {
    schedule(layer: string, draw: DrawFn): void {
      if (disposed) return;
      dirty.set(layer, draw);
      if (frameHandle === null) {
        frameHandle = requestFrame(flush);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
      dirty.clear();
    },
  };
}
