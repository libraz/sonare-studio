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

/** Mounts a 100x100 lane holding one breakpoint at x=40, y=50. */
function mountLane(commit: (points: unknown[]) => void): Element {
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
  const lane = wrapper.find('.breakpoint-lane').element;
  Object.assign(lane, {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: vi.fn(),
  });
  return lane;
}

function fire(lane: Element, type: string, x: number, y: number): void {
  lane.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
  );
}

describe('BreakpointLane', () => {
  it('uses the same double-click delete and right-click curve gestures as arrangement automation', () => {
    const commit = vi.fn();
    const lane = mountLane(commit);

    lane.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 }));
    expect(commit).toHaveBeenLastCalledWith([{ ppq: 4, value: 64, curve: 'linear' }]);

    lane.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 40, clientY: 50 }));
    expect(commit).toHaveBeenLastCalledWith([]);
  });

  it('leaves the point alone when a breakpoint is pressed and released without dragging', () => {
    const commit = vi.fn();
    const lane = mountLane(commit);

    fire(lane, 'pointerdown', 43, 54);
    fire(lane, 'pointermove', 44, 55);
    fire(lane, 'pointerup', 44, 55);

    expect(commit).not.toHaveBeenCalled();
  });

  it('commits one step when a breakpoint is dragged past the threshold', () => {
    const commit = vi.fn();
    const lane = mountLane(commit);

    fire(lane, 'pointerdown', 40, 50);
    for (const x of [45, 50, 60]) fire(lane, 'pointermove', x, 20);
    fire(lane, 'pointerup', 60, 20);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith([{ ppq: 6, value: 102 }]);
  });

  it('turns a double-click delete into a single commit that removes the original point', () => {
    const commit = vi.fn();
    const lane = mountLane(commit);

    fire(lane, 'pointerdown', 40, 50);
    fire(lane, 'pointerup', 40, 50);
    fire(lane, 'pointerdown', 40, 50);
    fire(lane, 'pointerup', 40, 50);
    lane.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 40, clientY: 50 }));

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith([]);
  });

  it('adds a point when empty space is clicked', () => {
    const commit = vi.fn();
    const lane = mountLane(commit);

    fire(lane, 'pointerdown', 10, 20);
    fire(lane, 'pointerup', 10, 20);

    expect(commit).toHaveBeenCalledTimes(1);
  });
});
