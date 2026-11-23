import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { ref } from 'vue';
import LayoutsTab from '@/components/settings/LayoutsTab.vue';
import { LAYOUTS_STORAGE_KEY } from '@/composables/useLayouts';
import type { DockTabId, LayoutBindings } from '@/ui/settings/layouts';
import { enterKey } from './ime-test-helpers';

const bindings: LayoutBindings = {
  arrangeHeightPx: ref(260),
  dockTab: ref<DockTabId>('roll'),
  deviceRackOpen: ref(true),
  scoreOpen: ref(false),
  dockCollapsed: ref(false),
};

describe('LayoutsTab save with an IME', () => {
  beforeEach(() => localStorage.removeItem(LAYOUTS_STORAGE_KEY));

  async function typed() {
    const wrapper = mount(LayoutsTab, { props: { layoutBindings: bindings } });
    const input = wrapper.find<HTMLInputElement>('.layout-save input');
    await input.setValue('ふぉーむ');
    return { wrapper, input };
  }

  it('does not save when Enter confirms a composition', async () => {
    const { wrapper, input } = await typed();
    input.element.dispatchEvent(enterKey(true));
    await wrapper.vm.$nextTick();
    expect(input.element.value).toBe('ふぉーむ');
  });

  it('saves and clears the field on a plain Enter', async () => {
    const { wrapper, input } = await typed();
    input.element.dispatchEvent(enterKey(false));
    await wrapper.vm.$nextTick();
    expect(input.element.value).toBe('');
  });
});
