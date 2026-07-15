import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AccessibleObjectNavigator from '@/components/accessibility/AccessibleObjectNavigator.vue';

function mountNavigator() {
  return mount(AccessibleObjectNavigator, {
    props: {
      label: 'Object navigator',
      emptyLabel: 'No objects',
      instructions: 'Use arrows',
      editLabel: 'Properties',
      contextLabel: 'Actions',
      items: [
        { id: 'one', label: 'Object one', selected: true },
        {
          id: 'two',
          label: 'Object two',
          selected: false,
          controls: [{ id: 'value', label: 'Value', min: 0, max: 10, step: 1, value: 4 }],
        },
      ],
    },
  });
}

describe('AccessibleObjectNavigator', () => {
  it('uses aria-activedescendant and activates the explored object', async () => {
    const wrapper = mountNavigator();
    const listbox = wrapper.get('[role="listbox"]');
    expect(listbox.attributes('aria-activedescendant')).toContain('one');
    expect(wrapper.findAll('[role="option"]')).toHaveLength(2);
    expect(wrapper.findAll('[role="option"]')[0].attributes('aria-selected')).toBe('true');

    await listbox.trigger('keydown', { key: 'ArrowDown' });
    expect(listbox.attributes('aria-activedescendant')).toContain('two');
    await listbox.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('activate')).toEqual([['two']]);
  });

  it('routes keyboard adjustments, context actions, and native slider values', async () => {
    const wrapper = mountNavigator();
    const listbox = wrapper.get('[role="listbox"]');
    await listbox.trigger('keydown', { key: 'ArrowDown' });
    await listbox.trigger('keydown', { key: 'ArrowRight', ctrlKey: true });
    expect(wrapper.emitted('adjust')?.[0]).toEqual([
      { id: 'two', direction: 'right', resize: false, coarse: false },
    ]);

    await listbox.trigger('keydown', { key: 'F10', shiftKey: true });
    expect(wrapper.emitted('context')).toEqual([['two']]);

    const slider = wrapper.get('input[type="range"]');
    expect(slider.attributes('min')).toBe('0');
    expect(slider.attributes('max')).toBe('10');
    await slider.setValue('7');
    expect(wrapper.emitted('set-value')).toEqual([[{ id: 'two', controlId: 'value', value: 7 }]]);
  });
});
