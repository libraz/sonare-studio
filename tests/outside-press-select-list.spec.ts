import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import StripOptionsPopover from '@/components/mixer/StripOptionsPopover.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useOutsidePointerDown } from '@/composables/useOutsidePointerDown';
import { useOutsidePopovers } from '@/composables/useOutsidePopovers';
import { currentStrip } from '@/project/command/mixer-internal';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { openSelect } from './helpers/select-menu';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

enableAutoUnmount(afterEach);

afterEach(() => {
  document.body.replaceChildren();
});

const press = (target: EventTarget) =>
  target.dispatchEvent(new Event('pointerdown', { bubbles: true }));

/** Opens a standalone SelectMenu and returns an option in its teleported list. */
async function openSelectOption(): Promise<HTMLElement> {
  const wrapper = mount(SelectMenu, {
    attachTo: document.body,
    props: {
      modelValue: 'a',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      ariaLabel: 'choice',
    },
  });
  await wrapper.get('.select-trigger').trigger('click');
  await flushPromises();
  const option = document.querySelector<HTMLElement>('.select-list .select-option');
  if (!option) throw new Error('the SelectMenu list did not open');
  return option;
}

/** An element that carries the listbox role without being a SelectMenu list. */
function plainListbox(): HTMLElement {
  const element = document.createElement('div');
  element.setAttribute('role', 'listbox');
  document.body.append(element);
  return element;
}

describe('outside-press dismissal and teleported SelectMenu lists', () => {
  it('useOutsidePointerDown ignores a press inside a SelectMenu list only', async () => {
    const option = await openSelectOption();
    const root = document.createElement('div');
    document.body.append(root);
    const onOutside = vi.fn();
    const scope = effectScope();
    scope.run(() => useOutsidePointerDown(ref(true), (target) => root.contains(target), onOutside));

    press(option);
    expect(onOutside).not.toHaveBeenCalled();
    press(plainListbox());
    expect(onOutside).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it('useOutsidePopovers ignores a press inside a SelectMenu list only', async () => {
    const option = await openSelectOption();
    const close = vi.fn();
    const { onWindowPointerDown } = useOutsidePopovers([
      { open: ref(true), root: ref(document.createElement('div')), close },
    ]);
    window.addEventListener('pointerdown', onWindowPointerDown, true);
    try {
      press(option);
      expect(close).not.toHaveBeenCalled();
      press(plainListbox());
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('pointerdown', onWindowPointerDown, true);
    }
  });

  describe('the strip options popover', () => {
    beforeEach(async () => {
      setActivePinia(createPinia());
      const store = useProjectStore();
      store.dispose();
      clearHistory();
      await store.init();
    });

    it('stays open and applies a pan law picked from its SelectMenu', async () => {
      const store = useProjectStore();
      const trackId = store.tracks[0].id;
      const wrapper = mount(StripOptionsPopover, {
        attachTo: document.body,
        props: { target: trackId, name: 'Track 1' },
      });
      await wrapper.find('.strip-options-btn').trigger('click');
      await openSelect(wrapper, '.strip-options-popover .strip-options-field');
      const option = Array.from(
        document.querySelectorAll<HTMLElement>('.select-list .select-option'),
      ).find((item) => item.textContent?.includes('-6 dB'));
      if (!option) throw new Error('no -6 dB pan law option');

      // A real press fires pointerdown before the click that picks the option.
      press(option);
      await flushPromises();
      expect(wrapper.find('.strip-options-popover').exists()).toBe(true);
      option.click();
      await flushPromises();
      expect(currentStrip(store, trackId).panLaw).toBe('const6Db');
    });
  });
});
