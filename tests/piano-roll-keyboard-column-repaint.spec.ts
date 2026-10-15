import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import KeyboardColumn from '@/components/piano-roll/KeyboardColumn.vue';
import type { Painter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
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
  const schedule = vi.fn();
  const painter: Painter = { schedule, dispose: vi.fn() };
  const range = new TimelineRange({ widthPx: 100, heightPx: 600, pxPerPpq: 50, rowHeight: 10 });
  wrapper = mount(KeyboardColumn, { props: { range, revision: 0, painter } });
  observe([{ contentRect: { width: 72, height: 600 } }]);
  // Run the pending paint like the frame batcher would.
  const paint = () => schedule.mock.calls.at(-1)?.[1]();
  paint();
  schedule.mockClear();
  return { range, schedule, paint };
}

describe('KeyboardColumn repaint', () => {
  it('skips a revision bump that did not move the keyboard', async () => {
    const { schedule } = setup();
    await wrapper?.setProps({ revision: 1 });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('repaints when the vertical scroll or row height changed', async () => {
    const { range, schedule, paint } = setup();
    range.setScrollY(range.scrollY + 40);
    await wrapper?.setProps({ revision: 1 });
    expect(schedule).toHaveBeenCalledTimes(1);
    paint();
    range.setRowHeight(12);
    await wrapper?.setProps({ revision: 2 });
    expect(schedule).toHaveBeenCalledTimes(2);
  });
});
