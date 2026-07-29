import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';
import { nextRadioIndex, vRadioGroup } from '@/ui/accessibility/radiogroup';

/**
 * Keyboard contract of the segmented controls: a `role="radiogroup"` is a single
 * tab stop whose options are reached with the arrow keys, not by tabbing through
 * every segment.
 */

/** Minimal three-option segmented control wired the way the app wires them. */
const Segmented = defineComponent({
  directives: { radiogroup: vRadioGroup },
  setup() {
    const value = ref('b');
    return { value, options: ['a', 'b', 'c'] };
  },
  template: `
    <div class="segmented" role="radiogroup" v-radiogroup aria-label="test">
      <button
        v-for="option in options"
        :key="option"
        type="button"
        class="segment"
        role="radio"
        :aria-checked="value === option"
        @click="value = option"
      >{{ option }}</button>
    </div>
  `,
});

describe('nextRadioIndex', () => {
  it('wraps forward and backward', () => {
    expect(nextRadioIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextRadioIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextRadioIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextRadioIndex('ArrowUp', 1, 3)).toBe(0);
  });

  it('jumps to the ends and enters an unfocused group', () => {
    expect(nextRadioIndex('Home', 2, 3)).toBe(0);
    expect(nextRadioIndex('End', 0, 3)).toBe(2);
    expect(nextRadioIndex('ArrowRight', -1, 3)).toBe(0);
    expect(nextRadioIndex('ArrowLeft', -1, 3)).toBe(2);
  });

  it('ignores keys it does not own and empty groups', () => {
    expect(nextRadioIndex('Enter', 0, 3)).toBeNull();
    expect(nextRadioIndex(' ', 0, 3)).toBeNull();
    expect(nextRadioIndex('ArrowRight', 0, 0)).toBeNull();
  });
});

describe('v-radiogroup', () => {
  it('makes the checked option the only tab stop in the group', () => {
    const wrapper = mount(Segmented, { attachTo: document.body });
    const radios = wrapper.findAll('[role="radio"]');
    expect(radios.map((radio) => (radio.element as HTMLElement).tabIndex)).toEqual([-1, 0, -1]);
    wrapper.unmount();
  });

  it('moves the selection with the arrow keys and re-homes the tab stop', async () => {
    const wrapper = mount(Segmented, { attachTo: document.body });
    const group = wrapper.get('[role="radiogroup"]');
    (wrapper.findAll('[role="radio"]')[1].element as HTMLElement).focus();

    await group.trigger('keydown', { key: 'ArrowRight' });
    await nextTick();
    let radios = wrapper.findAll('[role="radio"]');
    expect(radios.map((radio) => radio.attributes('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
    ]);
    expect(radios.map((radio) => (radio.element as HTMLElement).tabIndex)).toEqual([-1, -1, 0]);

    // Wrapping forward lands back on the first option.
    await group.trigger('keydown', { key: 'ArrowRight' });
    await nextTick();
    radios = wrapper.findAll('[role="radio"]');
    expect(radios[0].attributes('aria-checked')).toBe('true');
    wrapper.unmount();
  });

  it('leaves keys it does not own to the component', async () => {
    const wrapper = mount(Segmented, { attachTo: document.body });
    const group = wrapper.get('[role="radiogroup"]');
    (wrapper.findAll('[role="radio"]')[1].element as HTMLElement).focus();

    await group.trigger('keydown', { key: 'Enter' });
    await nextTick();
    expect(wrapper.findAll('[role="radio"]')[1].attributes('aria-checked')).toBe('true');
    wrapper.unmount();
  });

  it('skips disabled options', async () => {
    const Disabled = defineComponent({
      directives: { radiogroup: vRadioGroup },
      setup() {
        const value = ref('a');
        return { value };
      },
      template: `
        <div role="radiogroup" v-radiogroup aria-label="test">
          <button type="button" role="radio" :aria-checked="value === 'a'" @click="value = 'a'">a</button>
          <button type="button" role="radio" disabled aria-checked="false">b</button>
          <button type="button" role="radio" :aria-checked="value === 'c'" @click="value = 'c'">c</button>
        </div>
      `,
    });
    const wrapper = mount(Disabled, { attachTo: document.body });
    const group = wrapper.get('[role="radiogroup"]');
    (wrapper.findAll('[role="radio"]')[0].element as HTMLElement).focus();

    await group.trigger('keydown', { key: 'ArrowRight' });
    await nextTick();
    expect(wrapper.findAll('[role="radio"]')[2].attributes('aria-checked')).toBe('true');
    wrapper.unmount();
  });
});
