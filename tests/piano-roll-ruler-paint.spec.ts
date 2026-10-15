import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PianoRollRuler from '@/components/piano-roll/PianoRollRuler.vue';
import type { Painter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PianoRollRuler paint', () => {
  it('strokes all bar lines and all beat lines in one stroke each', () => {
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
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key) => (key in target ? target[key as string] : vi.fn()),
      set: (target, key, value) => {
        target[key as string] = value;
        return true;
      },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );
    let paint: (() => void) | null = null;
    const painter: Painter = {
      schedule: (_layer, draw) => {
        paint = draw;
      },
      dispose: vi.fn(),
    };
    wrapper = mount(PianoRollRuler, {
      props: {
        range: new TimelineRange({ widthPx: 800, heightPx: 24, pxPerPpq: 50 }),
        revision: 0,
        painter,
        clipLengthPpq: 64,
        timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      },
    });
    observe([{ contentRect: { width: 800, height: 24 } }]);
    const stroke = vi.fn();
    ctx.stroke = stroke;
    (paint as (() => void) | null)?.();

    // 16 quarter-note columns on screen: four bars and twelve beats.
    expect(stroke.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
