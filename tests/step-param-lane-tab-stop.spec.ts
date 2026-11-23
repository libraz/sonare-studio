import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import StepParamLane from '@/components/step-sequencer/StepParamLane.vue';
import type { PatternStep } from '@/ui/step-sequencer/pattern';

function steps(count: number): PatternStep[] {
  return Array.from({ length: count }, () => ({
    active: true,
    velocity: 96,
    gate: 0.5,
    offset: 0,
  }));
}

describe('StepParamLane tab stop', () => {
  it('keeps exactly one tab stop when the row shrinks below the focused step', async () => {
    const wrapper = mount(StepParamLane, {
      props: { steps: steps(32), param: 'velocity', paramLabel: 'Velocity', stepLabel: 'Step' },
    });
    await wrapper.findAll('[role="slider"]')[20].trigger('focus');
    await wrapper.setProps({ steps: steps(8) });
    const stops = wrapper
      .findAll('[role="slider"]')
      .map((slider) => slider.attributes('tabindex'))
      .filter((tabindex) => tabindex === '0');
    expect(stops).toHaveLength(1);
    expect(wrapper.findAll('[role="slider"]')[7].attributes('tabindex')).toBe('0');
  });
});
