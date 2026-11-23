import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import StepGrid from '@/components/step-sequencer/StepGrid.vue';
import { createDrumPattern } from '@/ui/step-sequencer/pattern';

function press(button: number) {
  const wrapper = mount(StepGrid, {
    props: { pattern: createDrumPattern(8), selectedRow: 0 },
    global: { directives: { tooltip: () => undefined } },
  });
  wrapper
    .get('[data-row="0"][data-step="1"]')
    .element.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button }),
    );
  return wrapper;
}

describe('StepGrid pointer buttons', () => {
  it('ignores the middle button', () => {
    const wrapper = press(1);
    expect(wrapper.emitted('set-step')).toBeUndefined();
    expect(wrapper.emitted('select-row')).toBeUndefined();
  });

  it('still paints with the primary button and erases with the secondary', () => {
    expect(press(0).emitted('set-step')).toBeDefined();
    expect(press(2).emitted('select-row')).toBeDefined();
  });
});
