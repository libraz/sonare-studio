import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';
import { vRadioGroup } from '@/ui/accessibility/radiogroup';
import { nextRovingIndex } from '@/ui/accessibility/roving';
import { vTabList } from '@/ui/accessibility/tablist';

/**
 * Keyboard contract shared by segmented controls and tab strips: the widget is a
 * single tab stop whose options are reached with the arrow keys, not by tabbing
 * through every option.
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

/** Minimal three-tab strip wired the way the app wires them. */
const TabStrip = defineComponent({
  directives: { tablist: vTabList },
  setup() {
    const active = ref('b');
    return { active, tabs: ['a', 'b', 'c'] };
  },
  template: `
    <div role="tablist" v-tablist aria-label="test">
      <button
        v-for="tab in tabs"
        :key="tab"
        type="button"
        role="tab"
        :aria-selected="active === tab"
        @click="active = tab"
      >{{ tab }}</button>
      <span class="strip-caption">not a tab</span>
    </div>
  `,
});

describe('nextRovingIndex', () => {
  it('wraps forward and backward', () => {
    expect(nextRovingIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextRovingIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextRovingIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextRovingIndex('ArrowUp', 1, 3)).toBe(0);
  });

  it('jumps to the ends and enters an unfocused widget', () => {
    expect(nextRovingIndex('Home', 2, 3)).toBe(0);
    expect(nextRovingIndex('End', 0, 3)).toBe(2);
    expect(nextRovingIndex('ArrowRight', -1, 3)).toBe(0);
    expect(nextRovingIndex('ArrowLeft', -1, 3)).toBe(2);
  });

  it('ignores keys it does not own and empty widgets', () => {
    expect(nextRovingIndex('Enter', 0, 3)).toBeNull();
    expect(nextRovingIndex(' ', 0, 3)).toBeNull();
    expect(nextRovingIndex('ArrowRight', 0, 0)).toBeNull();
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

describe('v-tablist', () => {
  it('makes the selected tab the only tab stop in the strip', () => {
    const wrapper = mount(TabStrip, { attachTo: document.body });
    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs.map((tab) => (tab.element as HTMLElement).tabIndex)).toEqual([-1, 0, -1]);
    wrapper.unmount();
  });

  it('moves the selection with the arrow keys and follows focus', async () => {
    const wrapper = mount(TabStrip, { attachTo: document.body });
    const strip = wrapper.get('[role="tablist"]');
    (wrapper.findAll('[role="tab"]')[1].element as HTMLElement).focus();

    await strip.trigger('keydown', { key: 'ArrowRight' });
    await nextTick();
    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs.map((tab) => tab.attributes('aria-selected'))).toEqual(['false', 'false', 'true']);
    expect(document.activeElement).toBe(tabs[2].element);

    await strip.trigger('keydown', { key: 'Home' });
    await nextTick();
    expect(wrapper.findAll('[role="tab"]')[0].attributes('aria-selected')).toBe('true');
    wrapper.unmount();
  });

  it('ignores non-tab children of the strip', async () => {
    const wrapper = mount(TabStrip, { attachTo: document.body });
    const strip = wrapper.get('[role="tablist"]');
    (wrapper.findAll('[role="tab"]')[2].element as HTMLElement).focus();

    // Wrapping past the last tab reaches the first, not the trailing caption.
    await strip.trigger('keydown', { key: 'ArrowRight' });
    await nextTick();
    expect(document.activeElement).toBe(wrapper.findAll('[role="tab"]')[0].element);
    wrapper.unmount();
  });
});
