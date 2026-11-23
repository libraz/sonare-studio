import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import CommandPalette from '@/components/shell/CommandPalette.vue';
import { enterKey } from './ime-test-helpers';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('CommandPalette with an IME', () => {
  async function open() {
    const run = vi.fn();
    const wrapper = mount(CommandPalette, {
      props: { open: true, commands: [{ id: 'save', label: 'Save project', run }] },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();
    const input = document.body.querySelector<HTMLInputElement>('[role="combobox"]')!;
    return { wrapper, input, run };
  }

  it('does not run the active command when Enter confirms a composition', async () => {
    const { wrapper, input, run } = await open();
    input.dispatchEvent(enterKey(true));
    expect(run).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('runs the active command on a plain Enter', async () => {
    const { wrapper, input, run } = await open();
    input.dispatchEvent(enterKey(false));
    expect(run).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
