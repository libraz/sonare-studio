import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { useSampleViewport } from '@/ui/sample-editor/use-sample-viewport';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useSampleViewport', () => {
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
