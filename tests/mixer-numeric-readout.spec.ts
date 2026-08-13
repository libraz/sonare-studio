import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import NumericReadout from '@/components/mixer/NumericReadout.vue';

describe('NumericReadout', () => {
  const props = {
    value: -4.3,
    min: -96,
    max: 12,
    display: '-4.3',
    unit: 'dB',
    ariaLabel: 'Strip gain',
  };

  it('turns a displayed value into an exact number input and commits on Enter', async () => {
    const wrapper = mount(NumericReadout, { props });
    expect(wrapper.text()).toBe('-4.3 dB');

    await wrapper.get('button').trigger('click');
    const input = wrapper.get('input[type="number"]');
    await input.setValue('-6');
    await input.trigger('keydown', { key: 'Enter' });

    expect(wrapper.emitted('change')).toEqual([[-6]]);
    expect(wrapper.find('button').exists()).toBe(true);
  });

  it('clamps a typed value to the supplied range and abandons Escape edits', async () => {
    const wrapper = mount(NumericReadout, { props });
    await wrapper.get('button').trigger('click');
    const input = wrapper.get('input[type="number"]');
    await input.setValue('99');
    await input.trigger('blur');
    expect(wrapper.emitted('change')).toEqual([[12]]);

    await wrapper.get('button').trigger('click');
    await wrapper.get('input[type="number"]').setValue('-8');
    await wrapper.get('input[type="number"]').trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('change')).toEqual([[12]]);
  });

  it('does not commit when disabled changes while editing', async () => {
    const blurWrapper = mount(NumericReadout, { props });
    await blurWrapper.get('button').trigger('click');
    await blurWrapper.setProps({ disabled: true });

    const blurInput = blurWrapper.get('input[type="number"]');
    expect(blurInput.attributes('disabled')).toBeDefined();
    await blurInput.setValue('-6');
    await blurInput.trigger('blur');
    expect(blurWrapper.emitted('change')).toBeUndefined();
    blurWrapper.unmount();

    const enterWrapper = mount(NumericReadout, { props });
    await enterWrapper.get('button').trigger('click');
    await enterWrapper.setProps({ disabled: true });
    await enterWrapper.get('input[type="number"]').setValue('-6');
    await enterWrapper.get('input[type="number"]').trigger('keydown', { key: 'Enter' });
    expect(enterWrapper.emitted('change')).toBeUndefined();
    enterWrapper.unmount();
  });
});
