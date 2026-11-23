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

describe('BreakpointLane read-only', () => {
  it('abandons a running drag when the lane becomes read-only', async () => {
    const commit = vi.fn();
    const lane = mountLane(commit);

    fire(lane, 'pointerdown', 40, 50);
    fire(lane, 'pointermove', 50, 20);
    await wrapper?.setProps({ readOnly: true });
    fire(lane, 'pointermove', 60, 20);
    fire(lane, 'pointerup', 60, 20);

    expect(commit).not.toHaveBeenCalled();
  });
});
