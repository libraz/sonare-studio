import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SearchField from '@/components/shell/SearchField.vue';

describe('SearchField', () => {
  it('emits typed text through v-model and shows the clear affordance', async () => {
    const wrapper = mount(SearchField, {
      props: {
        modelValue: '',
        placeholder: 'Search presets',
        ariaLabel: 'Search presets',
        clearLabel: 'Clear preset search',
        'onUpdate:modelValue': (value: string) => wrapper.setProps({ modelValue: value }),
      },
    });

    const input = wrapper.get('input[type="search"]');
    expect(input.attributes('placeholder')).toBe('Search presets');
    expect(input.attributes('aria-label')).toBe('Search presets');

    await input.setValue('lead');

    expect(wrapper.emitted('update:modelValue')).toStrictEqual([['lead']]);
    const clear = wrapper.get('button[aria-label="Clear preset search"]');
    await clear.trigger('click');

    expect(wrapper.emitted('update:modelValue')).toStrictEqual([['lead'], ['']]);
    expect(wrapper.find('.search-clear').exists()).toBe(false);
  });

  it('disables the input and hides clear while disabled', async () => {
    const wrapper = mount(SearchField, {
      props: {
        modelValue: 'drum',
        ariaLabel: 'Filter assets by name',
        disabled: true,
      },
    });

    expect(wrapper.get('input').attributes('disabled')).toBeDefined();
    expect(wrapper.classes()).toContain('is-disabled');
    expect(wrapper.find('.search-clear').exists()).toBe(false);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });
});
