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

  it('moves the line freely below the anchor and caps it once reached', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const fillRect = vi.fn();
    const ctx = {
      clearRect: vi.fn(),
      fillRect,
      setTransform: vi.fn(),
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);

    const painter: Painter = { schedule: vi.fn(), flush: vi.fn(), dispose: vi.fn() };
    const range = new TimelineRange({ widthPx: 1000, heightPx: 40, pxPerPpq: 100 });
    const position = ref(0);
    let overlay!: ReturnType<typeof usePlayheadOverlay>;

    const Host = defineComponent({
      setup() {
        const canvas = ref<HTMLCanvasElement | null>(null);
        overlay = usePlayheadOverlay({
          canvas,
          painter,
          layerId: 'test',
          range: () => range,
          positionPpq: () => () => position.value,
          anchoredLocalX: () => 250,
          colors: ARRANGEMENT_COLORS,
        });
        return () => h('canvas', { ref: canvas });
      },
    });
    const wrapper = mount(Host);

    // Left of the anchor: the line tracks the real playhead column.
    position.value = 2;
    overlay.drawOverlay();
    expect(fillRect).toHaveBeenLastCalledWith(200, 0, 1.5, 40);

    // Past the anchor: the line is capped at the anchor column.
    position.value = 8;
    overlay.drawOverlay();
    expect(fillRect).toHaveBeenLastCalledWith(250, 0, 1.5, 40);

    wrapper.unmount();
  });
});
