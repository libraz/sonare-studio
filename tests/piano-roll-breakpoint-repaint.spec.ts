import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BreakpointLane from '@/components/piano-roll/BreakpointLane.vue';
import type { Painter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

describe('BreakpointLane repaint triggers', () => {
  it.each([
    ['color', { color: '#ff0000' }],
    ['centerValue', { centerValue: 64 }],
    ['readoutLabel', { readoutLabel: 'Bend' }],
  ])('schedules a repaint when %s changes', async (_name, change) => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const schedule = vi.fn();
    const painter: Painter = { schedule, dispose: vi.fn() };
    wrapper = mount(BreakpointLane, {
      props: {
        range: new TimelineRange({ widthPx: 100, heightPx: 100, pxPerPpq: 10 }),
        revision: 0,
        painter,
        clipId: 1,
        clipLengthPpq: 8,
        points: [{ ppq: 4, value: 64 }],
        commit: vi.fn(),
      },
    });
    schedule.mockClear();
    await wrapper.setProps(change);
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});
