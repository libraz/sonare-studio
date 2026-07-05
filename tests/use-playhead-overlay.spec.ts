import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { ARRANGEMENT_COLORS } from '@/components/arrangement/theme';
import { usePlayheadOverlay } from '@/ui/arrangement/use-playhead-overlay';
import type { Painter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('usePlayheadOverlay', () => {
  it('cancels the polling frame on unmount', () => {
    const requestAnimationFrame = vi.fn(() => 88);
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);
    const painter: Painter = {
      schedule: vi.fn(),
      flush: vi.fn(),
      dispose: vi.fn(),
    };

    const Host = defineComponent({
      setup() {
        const canvas = ref<HTMLCanvasElement | null>(null);
        usePlayheadOverlay({
          canvas,
          painter,
          layerId: 'test',
          range: () => new TimelineRange({ widthPx: 100, heightPx: 40 }),
          positionPpq: () => () => 0,
          colors: ARRANGEMENT_COLORS,
        });
        return () => h('canvas', { ref: canvas });
      },
    });

    const wrapper = mount(Host);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(88);
  });
});
