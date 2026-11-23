import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceRack from '@/components/devices/DeviceRack.vue';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { openSelect, selectValueText } from './helpers/select-menu';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

enableAutoUnmount(afterEach);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('DeviceRack instrument picker outside-press dismissal', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('stays open while a choice is made in a SelectMenu list teleported to the body', async () => {
    const wrapper = mount(DeviceRack, { attachTo: document.body });
    await wrapper.find('.instrument-button').trigger('click');
    await wrapper
      .findAll('.picker-tab')
      .find((tab) => tab.text() === 'GM')
      ?.trigger('click');
    await openSelect(wrapper, '.gm-field .select-menu');

    const option = Array.from(
      document.querySelectorAll<HTMLElement>('.select-list .select-option'),
    ).find((item) => item.textContent?.includes('025 · Nylon Guitar'));
    expect(option).toBeDefined();
    // A real press fires pointerdown before the click that picks the option.
    option?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flushPromises();
    expect(wrapper.find('.instrument-picker').exists()).toBe(true);

    option?.click();
    await flushPromises();
    expect(selectValueText(wrapper, '.gm-field .select-menu')).toBe('025 · Nylon Guitar');

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flushPromises();
    expect(wrapper.find('.instrument-picker').exists()).toBe(false);
  });
});
