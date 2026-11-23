import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SectionLane from '@/components/arrangement/SectionLane.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { TimelineRange } from '@/ui/canvas/timeline-range';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('SectionLane default section name', () => {
  const settings = useAppSettings();
  const previous = settings.settings.language;

  beforeEach(async () => {
    settings.set('language', 'ja');
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });
  afterEach(() => settings.set('language', previous));

  it('names a section created in an empty gap in the active language', async () => {
    const wrapper = mount(SectionLane, {
      props: {
        range: new TimelineRange({ widthPx: 4000, heightPx: 24, pxPerPpq: 80 }),
        revision: 0,
      },
    });

    await wrapper.find('.section-lane').trigger('dblclick', { clientX: 10 });

    expect(useProjectStore().sections.map((section) => section.name)).toEqual(['セクション 1']);
  });
});
