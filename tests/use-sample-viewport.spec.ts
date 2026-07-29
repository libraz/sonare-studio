import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import {
  MAX_VISIBLE_PEAK_CACHE_ENTRIES,
  useSampleViewport,
  VisiblePeaksCache,
} from '@/ui/sample-editor/use-sample-viewport';
import type { ChannelPeaks } from '@/ui/waveform/peaks';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useSampleViewport', () => {
  it('caches repeated visible-window peak scans and evicts the oldest window', () => {
    const cache = new VisiblePeaksCache();
    const make = vi.fn((): ChannelPeaks[] => [
      { min: new Float32Array([0]), max: new Float32Array([0]) },
    ]);
    const first = cache.getOrCompute('same-window', make);
    expect(cache.getOrCompute('same-window', make)).toBe(first);
    expect(make).toHaveBeenCalledOnce();

    for (let index = 0; index < MAX_VISIBLE_PEAK_CACHE_ENTRIES; index += 1) {
      cache.getOrCompute(`window-${index}`, make);
    }
    cache.getOrCompute('same-window', make);
    expect(make).toHaveBeenCalledTimes(MAX_VISIBLE_PEAK_CACHE_ENTRIES + 2);
  });

  it('cancels a queued draw frame on unmount', async () => {
    const requestAnimationFrame = vi.fn(() => 42);
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);

    const selection = ref<null | { startFrame: number; endFrame: number }>(null);
    const Host = defineComponent({
      setup() {
        const viewport = useSampleViewport({
          asset: ref(null),
          selection,
          onsetFrames: ref([]),
          selRange: () => null,
        });
        return () =>
          h('div', { ref: viewport.wrapRef }, [h('canvas', { ref: viewport.canvasRef })]);
      },
    });

    const wrapper = mount(Host);
    selection.value = { startFrame: 0, endFrame: 128 };
    await wrapper.vm.$nextTick();

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    wrapper.unmount();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
  });
});
