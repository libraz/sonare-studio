import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { useProjectStore } from '@/project/store';
import { usePianoRollViewport } from '@/ui/piano-roll/use-piano-roll-viewport';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePianoRollViewport', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('initializes once, centers after layout, follows clip changes, and disposes its painter', async () => {
    const store = useProjectStore();
    const initialize = vi.spyOn(store, 'init').mockResolvedValue();
    const onClipChange = vi.fn();
    let viewport!: ReturnType<typeof usePianoRollViewport>;
    const Host = defineComponent({
      setup() {
        viewport = usePianoRollViewport({ onClipChange });
        return () => h('div');
      },
    });
    const wrapper = mount(Host);
    await nextTick();
    await Promise.resolve();

    expect(initialize).toHaveBeenCalledTimes(1);
    viewport.range.resize(200, 100);
    viewport.onGridResize();
    expect(viewport.revision.value).toBe(1);
    expect(viewport.range.scrollY).toBeGreaterThan(0);

    store.clipId += 1;
    await nextTick();
    expect(onClipChange).toHaveBeenCalledTimes(1);

    const dispose = vi.spyOn(viewport.painter, 'dispose');
    wrapper.unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('surfaces initialization errors without throwing from the mounted component', async () => {
    const store = useProjectStore();
    vi.spyOn(store, 'init').mockRejectedValue(new Error('native boot failed'));
    let viewport!: ReturnType<typeof usePianoRollViewport>;
    const wrapper = mount(
      defineComponent({
        setup() {
          viewport = usePianoRollViewport();
          return () => h('div');
        },
      }),
    );
    await nextTick();
    await Promise.resolve();

    expect(viewport.error.value).toBe('native boot failed');
    wrapper.unmount();
  });
});
