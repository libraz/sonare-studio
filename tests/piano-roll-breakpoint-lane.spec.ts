import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BreakpointLane from '@/components/piano-roll/BreakpointLane.vue';
import type { Painter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BreakpointLane', () => {
  it('uses the same double-click delete and right-click curve gestures as arrangement automation', () => {
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
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      arc: vi.fn(),
      beginPath: vi.fn(),
      fill: vi.fn(),
      fillRect: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      setTransform: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const commit = vi.fn();
    const painter: Painter = { schedule: vi.fn(), dispose: vi.fn() };
    wrapper = mount(BreakpointLane, {
      attachTo: document.body,
      props: {
        range: new TimelineRange({ widthPx: 100, heightPx: 100, pxPerPpq: 10 }),
        revision: 0,
        painter,
        clipId: 1,
        clipLengthPpq: 8,
        points: [{ ppq: 4, value: 64 }],
        commit,
      },
    });
    observe([{ contentRect: { width: 100, height: 100 } }]);
    const lane = wrapper.find('.breakpoint-lane');
    Object.assign(lane.element, { getBoundingClientRect: () => ({ left: 0, top: 0 }) });

    lane.element.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 }),
    );
    expect(commit).toHaveBeenLastCalledWith([{ ppq: 4, value: 64, curve: 'linear' }]);

    lane.element.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, clientX: 40, clientY: 50 }),
    );
    expect(commit).toHaveBeenLastCalledWith([]);
  });
});
