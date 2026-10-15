import { onBeforeUnmount, onMounted, type Ref } from 'vue';
import { setupCanvas } from '@/components/piano-roll/theme';
import { observeDevicePixelRatio } from './device-pixel-ratio';

/** Short random suffix that keeps painter layer names unique per component instance. */
export function createLayerId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Options for {@link useCanvasSurface}. */
export interface CanvasSurfaceOptions {
  /** Element whose content box sets the CSS size of every canvas. */
  container: Readonly<Ref<HTMLElement | null>>;
  /** Canvases backed at the container size; refs not yet mounted may be null. */
  canvases: () => ReadonlyArray<HTMLCanvasElement | null | undefined>;
  /** Runs after a non-empty container resize has resized the canvases, before the redraw. */
  onResize?: (widthPx: number, heightPx: number) => void;
  /** Schedules a repaint once the backing stores were rebuilt. */
  redraw: () => void;
}

/** Live CSS size of a canvas surface. */
export interface CanvasSurface {
  /** Last non-empty container width in CSS px; 0 before the first layout. */
  readonly widthPx: number;
  /** Last non-empty container height in CSS px; 0 before the first layout. */
  readonly heightPx: number;
}

/**
 * Keeps a component's canvases sized to their container: the backing stores
 * follow container resizes and display-scale changes, and an empty content
 * box (a hidden editor) keeps the last size instead of collapsing it.
 */
export function useCanvasSurface(options: CanvasSurfaceOptions): CanvasSurface {
  let widthPx = 0;
  let heightPx = 0;
  let resizeObserver: ResizeObserver | null = null;
  let stopDprObserver: (() => void) | null = null;

  const sizeCanvases = (): void => {
    for (const canvas of options.canvases()) {
      if (canvas) setupCanvas(canvas, widthPx, heightPx);
    }
  };

  const onDevicePixelRatioChange = (): void => {
    if (widthPx <= 0 || heightPx <= 0) return;
    sizeCanvases();
    options.redraw();
  };

  onMounted(() => {
    const el = options.container.value;
    if (!el) return;
    resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[entries.length - 1].contentRect;
      if (width <= 0 || height <= 0) return;
      widthPx = width;
      heightPx = height;
      sizeCanvases();
      options.onResize?.(width, height);
      options.redraw();
    });
    resizeObserver.observe(el);
    stopDprObserver = observeDevicePixelRatio(onDevicePixelRatioChange);
  });

  onBeforeUnmount(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    stopDprObserver?.();
    stopDprObserver = null;
  });

  return {
    get widthPx() {
      return widthPx;
    },
    get heightPx() {
      return heightPx;
    },
  };
}
