import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import NumericReadout from '@/components/mixer/NumericReadout.vue';
import { enterKey } from './ime-test-helpers';

describe('NumericReadout Enter with an IME', () => {
  async function editing() {
    const wrapper = mount(NumericReadout, {
      props: { value: -4.3, min: -96, max: 12, display: '-4.3', unit: 'dB', ariaLabel: 'Gain' },
    });
    await wrapper.get('button').trigger('click');
    const input = wrapper.get<HTMLInputElement>('input[type="number"]');
    await input.setValue('-6');
    return { wrapper, input };
  }

  it('keeps editing when Enter confirms a composition', async () => {
    const { wrapper, input } = await editing();
    input.element.dispatchEvent(enterKey(true));
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('change')).toBeUndefined();
    expect(wrapper.find('input').exists()).toBe(true);
  });

  it('commits on a plain Enter', async () => {
    const { wrapper, input } = await editing();
    input.element.dispatchEvent(enterKey(false));
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('change')).toEqual([[-6]]);
  });
});
