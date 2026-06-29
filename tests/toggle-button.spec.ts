import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ToggleButton from '@/components/shell/ToggleButton.vue';

describe('ToggleButton', () => {
  it('renders pressed state from v-model and emits the flipped value on click', async () => {
    const wrapper = mount(ToggleButton, {
      props: {
        modelValue: false,
        label: 'Snap',
        title: 'Toggle snapping',
        'onUpdate:modelValue': (value: boolean) => wrapper.setProps({ modelValue: value }),
      },
    });

    const button = wrapper.get('button');
    expect(button.text()).toBe('Snap');
    expect(button.attributes('aria-pressed')).toBe('false');
    expect(button.attributes('title')).toBe('Toggle snapping');

    await button.trigger('click');

    expect(wrapper.emitted('update:modelValue')).toStrictEqual([[true]]);
    expect(button.attributes('aria-pressed')).toBe('true');
    expect(button.classes()).toContain('is-on');
  });

  it('does not emit while disabled', async () => {
    const wrapper = mount(ToggleButton, {
      props: {
        modelValue: true,
        label: 'Music typing',
        disabled: true,
      },
    });

    const button = wrapper.get('button');
    await button.trigger('click');

    expect(button.attributes('disabled')).toBeDefined();
    expect(button.attributes('aria-pressed')).toBe('true');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('uses slotted text as the visible label when no label prop is supplied', () => {
    const wrapper = mount(ToggleButton, {
      props: { modelValue: false },
      slots: { default: 'Step input' },
    });

    expect(wrapper.get('button').text()).toBe('Step input');
    expect(wrapper.get('button').attributes('aria-label')).toBeUndefined();
  });

  it('can show short state text while keeping a longer accessible label', () => {
    const wrapper = mount(ToggleButton, {
      props: {
        modelValue: true,
        label: 'On',
        ariaLabel: 'Snap to grid by default',
      },
    });

    const button = wrapper.get('button');
    expect(button.text()).toBe('On');
    expect(button.attributes('aria-label')).toBe('Snap to grid by default');
  });
});
