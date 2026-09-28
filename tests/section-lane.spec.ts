import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SectionLane from '@/components/arrangement/SectionLane.vue';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { TimelineRange } from '@/ui/canvas/timeline-range';
import { useContextMenuState } from '@/ui/menu/context-menu';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('SectionLane', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.sections = [{ id: 1, name: 'Intro', color: '#60a5fa', startPpq: 0, endPpq: 4 }];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('cancels a pending rename focus frame on unmount', async () => {
    const requestAnimationFrame = vi.fn(() => 33);
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);
    const wrapper = mount(SectionLane, {
      props: {
        range: new TimelineRange({ widthPx: 400, heightPx: 24, pxPerPpq: 80 }),
        revision: 0,
      },
    });

    await wrapper.find('.section-band').trigger('dblclick');
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(33);
  });

  it('offers a section duplication action from the context menu', async () => {
    const wrapper = mount(SectionLane, {
      props: {
        range: new TimelineRange({ widthPx: 400, heightPx: 24, pxPerPpq: 80 }),
        revision: 0,
      },
    });

    await wrapper.find('.section-band').trigger('contextmenu', { clientX: 12, clientY: 20 });

    expect(useContextMenuState().items).toMatchObject([
      { id: 'regenerate-section-drums' },
      { id: 'duplicate-section' },
    ]);
  });
});
