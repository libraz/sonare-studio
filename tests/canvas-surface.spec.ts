import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import {
  type CanvasSurface,
  createLayerId,
  useCanvasSurface,
} from '@/ui/canvas/use-canvas-surface';

type ResizeEntries = Array<{ contentRect: { width: number; height: number } }>;

function stubResizeObserver() {
  const state = {
    callback: null as ((entries: ResizeEntries) => void) | null,
    observed: [] as Element[],
    disconnected: 0,
  };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: (entries: ResizeEntries) => void) {
        state.callback = callback;
      }
      observe(el: Element) {
        state.observed.push(el);
      }
      disconnect() {
        state.disconnected++;
      }
    },
  );
  return state;
}

function stubDevicePixelRatio(ratio: number) {
  const listeners: Array<() => void> = [];
  vi.stubGlobal('devicePixelRatio', ratio);
  vi.stubGlobal('matchMedia', () => ({
    addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
    removeEventListener: (_type: string, listener: () => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  }));
  return {
    change(next: number) {
      vi.stubGlobal('devicePixelRatio', next);
      for (const listener of listeners.splice(0)) listener();
    },
    listenerCount: () => listeners.length,
  };
}

function mountSurface(options: {
  canvasCount: number;
  onResize?: (w: number, h: number) => void;
  redraw: () => void;
}) {
  let surface!: CanvasSurface;
  const canvases: HTMLCanvasElement[] = [];
  const Host = defineComponent({
    setup() {
      const container = ref<HTMLElement | null>(null);
      const canvasRefs = Array.from({ length: options.canvasCount }, () =>
        ref<HTMLCanvasElement | null>(null),
      );
      surface = useCanvasSurface({
        container,
        canvases: () => canvasRefs.map((canvas) => canvas.value),
        onResize: options.onResize,
        redraw: options.redraw,
      });
      return () =>
        h(
          'div',
          { ref: container },
          canvasRefs.map((canvas) => h('canvas', { ref: canvas })),
        );
    },
  });
  const wrapper = mount(Host);
  canvases.push(...(wrapper.findAll('canvas').map((c) => c.element) as HTMLCanvasElement[]));
  return { wrapper, canvases, surface: () => surface };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useCanvasSurface', () => {
  it('sizes every canvas backing store to the container at the device pixel ratio', () => {
    const observer = stubResizeObserver();
    stubDevicePixelRatio(2);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const redraw = vi.fn();
    const onResize = vi.fn();
    const { wrapper, canvases, surface } = mountSurface({ canvasCount: 2, onResize, redraw });

    expect(observer.observed).toEqual([wrapper.element]);
    observer.callback?.([{ contentRect: { width: 300, height: 40 } }]);

    for (const canvas of canvases) {
      expect(canvas.width).toBe(600);
      expect(canvas.height).toBe(80);
    }
    expect(surface().widthPx).toBe(300);
    expect(surface().heightPx).toBe(40);
    expect(onResize).toHaveBeenCalledWith(300, 40);
    expect(redraw).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('ignores an empty content box so a hidden editor keeps its last size', () => {
    const observer = stubResizeObserver();
    stubDevicePixelRatio(1);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const redraw = vi.fn();
    const onResize = vi.fn();
    const { wrapper, canvases, surface } = mountSurface({ canvasCount: 1, onResize, redraw });

    observer.callback?.([{ contentRect: { width: 200, height: 30 } }]);
    observer.callback?.([{ contentRect: { width: 0, height: 30 } }]);

    expect(canvases[0].width).toBe(200);
    expect(surface().widthPx).toBe(200);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(redraw).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('rebuilds the backing stores at the new ratio when the display scale changes', () => {
    const observer = stubResizeObserver();
    const dpr = stubDevicePixelRatio(1);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const redraw = vi.fn();
    const onResize = vi.fn();
    const { wrapper, canvases } = mountSurface({ canvasCount: 2, onResize, redraw });

    // A scale change before the first layout has nothing to rebuild.
    dpr.change(2);
    expect(redraw).not.toHaveBeenCalled();

    observer.callback?.([{ contentRect: { width: 100, height: 10 } }]);
    dpr.change(3);

    for (const canvas of canvases) expect(canvas.width).toBe(300);
    expect(redraw).toHaveBeenCalledTimes(2);
    // The container did not change size, so layout consumers are not told again.
    expect(onResize).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('stops observing size and display scale on unmount', () => {
    const observer = stubResizeObserver();
    const dpr = stubDevicePixelRatio(1);
    const { wrapper } = mountSurface({ canvasCount: 1, redraw: vi.fn() });

    expect(dpr.listenerCount()).toBe(1);
    wrapper.unmount();
    expect(observer.disconnected).toBe(1);
    expect(dpr.listenerCount()).toBe(0);
  });
});

describe('createLayerId', () => {
  it('returns distinct short suffixes for separate instances', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createLayerId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{1,6}$/);
  });
});
