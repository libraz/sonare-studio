import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import DialogHost from '@/components/shell/DialogHost.vue';
import { dialogQueue, promptDialog } from '@/composables/useDialogs';
import { enterKey } from './ime-test-helpers';

afterEach(() => {
  dialogQueue.splice(0, dialogQueue.length);
  document.body.innerHTML = '';
});

describe('DialogHost prompt with an IME', () => {
  async function openPrompt() {
    const wrapper = mount(DialogHost, { attachTo: document.body });
    const result = promptDialog({ message: 'Name?', defaultValue: 'x' });
    await nextTick();
    await nextTick();
    const input = document.body.querySelector<HTMLInputElement>('input')!;
    return { wrapper, input, result };
  }

  it('keeps the prompt open when Enter confirms a composition', async () => {
    const { wrapper, input } = await openPrompt();
    input.dispatchEvent(enterKey(true));
    await nextTick();
    expect(dialogQueue).toHaveLength(1);
    wrapper.unmount();
  });

  it('confirms on a plain Enter', async () => {
    const { wrapper, input, result } = await openPrompt();
    input.dispatchEvent(enterKey(false));
    await expect(result).resolves.toBe('x');
    wrapper.unmount();
  });
});
