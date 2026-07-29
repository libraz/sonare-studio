import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PianoRollMinimap from '@/components/piano-roll/PianoRollMinimap.vue';
import type { EditorNote } from '@/project/types';
import type { Painter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PianoRollMinimap', () => {
  it('rebuilds its backing store when display DPR changes without a resize', () => {
    let observe!: (entries: Array<{ contentRect: { width: number; height: number } }>) => void;
    let onDprChange!: () => void;
    let dpr = 2;
    Object.defineProperty(globalThis, 'devicePixelRatio', {
      configurable: true,
      get: () => dpr,
    });
    vi.stubGlobal('matchMedia', () => ({
      addEventListener: (_type: string, listener: () => void) => {
        onDprChange = listener;
      },
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: typeof observe) {
          observe = callback;
        }

        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const painter: Painter = { schedule: vi.fn(), dispose: vi.fn() };
    wrapper = mount(PianoRollMinimap, {
      props: {
        range: new TimelineRange({ widthPx: 100, heightPx: 48 }),
        revision: 0,
        painter,
        notes: [],
        clipLengthPpq: 4,
      },
    });
    observe([{ contentRect: { width: 120, height: 24 } }]);
    const canvas = wrapper.find('canvas').element;
    expect(canvas.width).toBe(240);

    dpr = 1;
    onDprChange();

    expect(canvas.width).toBe(120);
    expect(vi.mocked(painter.schedule)).toHaveBeenCalledTimes(2);
  });

  it('draws a dense note list with linear property reads', async () => {
    let observe!: (entries: Array<{ contentRect: { width: number; height: number } }>) => void;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: typeof observe) {
          observe = callback;
        }

        observe() {}
        disconnect() {}
      },
    );
    const context = {
      fillStyle: '',
      strokeStyle: '',
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      setTransform: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    const scheduled = new Map<string, () => void>();
    const painter: Painter = {
      schedule: (layer, draw) => scheduled.set(layer, draw),
      dispose: vi.fn(),
    };
    let propertyReads = 0;
    const notes = Array.from({ length: 10_000 }, (_, id) => {
      const note = { id, velocity: 96, channel: 0 } as EditorNote;
      Object.defineProperties(note, {
        pitch: {
          enumerable: true,
          get: () => {
            propertyReads += 1;
            return 48 + (id % 24);
          },
        },
        startPpq: {
          enumerable: true,
          get: () => {
            propertyReads += 1;
            return id * 0.25;
          },
        },
        durationPpq: {
          enumerable: true,
          get: () => {
            propertyReads += 1;
            return 0.2;
          },
        },
      });
      return note;
    });

    wrapper = mount(PianoRollMinimap, {
      props: {
        range: new TimelineRange({ widthPx: 800, heightPx: 600, pxPerPpq: 100, rowHeight: 10 }),
        revision: 0,
        painter,
        notes,
        clipLengthPpq: 4,
      },
    });
    observe([{ contentRect: { width: 240, height: 48 } }]);
    for (const draw of scheduled.values()) draw();

    // One scan finds the content extent, then one draw pass renders notes.
    // Per-note extent scans would make this roughly 4 * N² property reads.
    expect(propertyReads).toBeLessThan(notes.length * 10);
    expect(context.fillRect).toHaveBeenCalledTimes(notes.length + 2);
  });

  it('keeps its content scale fixed while dragging and captures the pointer', async () => {
    let observe!: (entries: Array<{ contentRect: { width: number; height: number } }>) => void;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: typeof observe) {
          observe = callback;
        }

        observe() {}
        disconnect() {}
      },
    );
    const range = new TimelineRange({
      widthPx: 100,
      heightPx: 48,
      pxPerPpq: 1,
      startPpq: 96,
    });
    wrapper = mount(PianoRollMinimap, {
      attachTo: document.body,
      props: {
        range,
        revision: 0,
        painter: { schedule: vi.fn(), dispose: vi.fn() },
        notes: [],
        clipLengthPpq: 4,
      },
    });
    observe([{ contentRect: { width: 100, height: 24 } }]);
    const minimap = wrapper.find('.piano-roll-minimap');
    const capture = vi.fn();
    Object.assign(minimap.element, {
      getBoundingClientRect: () => ({ left: 0 }),
      setPointerCapture: capture,
    });

    const pointerDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperties(pointerDown, {
      button: { value: 0 },
      clientX: { value: 100 },
      pointerId: { value: 7 },
    });
    minimap.element.dispatchEvent(pointerDown);

    expect(capture).toHaveBeenCalledWith(7);
    // The visible range ends at PPQ 196, but the clip itself ends at PPQ 4.
    // A dragged minimap must retain that content scale rather than rescaling.
    expect(wrapper.emitted('scrollTo')).toEqual([[4]]);
  });
});
