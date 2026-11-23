import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, ref } from 'vue';
import { vRadioGroup } from '@/ui/accessibility/radiogroup';

const Segmented = defineComponent({
  directives: { radiogroup: vRadioGroup },
  setup() {
    const value = ref('b');
    return { value, options: ['a', 'b', 'c'] };
  },
  template: `
    <div role="radiogroup" v-radiogroup aria-label="test">
      <button
        v-for="option in options"
        :key="option"
        type="button"
        role="radio"
        :aria-checked="value === option"
        @click="value = option"
      >{{ option }}</button>
    </div>
  `,
});

describe('roving option navigation', () => {
  it.each(['altKey', 'ctrlKey', 'metaKey'] as const)(
    'leaves %s+arrow to shortcuts',
    async (modifier) => {
      const wrapper = mount(Segmented, { attachTo: document.body });
      const selected = wrapper.findAll('[role="radio"]')[1];
      (selected.element as HTMLElement).focus();
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
        [modifier]: true,
      });
      selected.element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect((wrapper.vm as unknown as { value: string }).value).toBe('b');
      wrapper.unmount();
    },
  );

  it('still moves the selection on a plain arrow', () => {
    const wrapper = mount(Segmented, { attachTo: document.body });
    const selected = wrapper.findAll('[role="radio"]')[1];
    (selected.element as HTMLElement).focus();
    selected.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    expect((wrapper.vm as unknown as { value: string }).value).toBe('c');
    wrapper.unmount();
  });
});
