import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import StepParamLane from '@/components/step-sequencer/StepParamLane.vue';
import type { PatternStep } from '@/ui/step-sequencer/pattern';

const STEPS: PatternStep[] = [
  { active: true, velocity: 64, gate: 0.5, offset: 0 },
  { active: false, velocity: 96, gate: 0.75, offset: 0.25 },
];

function mountLane(param: 'velocity' | 'gate' | 'offset') {
  return mount(StepParamLane, {
    props: { steps: STEPS, param, paramLabel: param, stepLabel: 'Step' },
  });
}

describe('StepParamLane accessibility', () => {
  it('exposes every step as a roving vertical slider', async () => {
    const wrapper = mountLane('velocity');
    const sliders = wrapper.findAll('[role="slider"]');

    expect(sliders).toHaveLength(2);
    expect(sliders[0].attributes()).toMatchObject({
      tabindex: '0',
      'aria-valuemin': '1',
      'aria-valuemax': '127',
      'aria-valuenow': '64',
      'aria-valuetext': '64',
    });
    expect(sliders[1].attributes('tabindex')).toBe('-1');

    await sliders[0].trigger('keydown', { key: 'ArrowUp' });
    expect(wrapper.emitted('set-value')).toEqual([[0, 65]]);
    await sliders[0].trigger('keydown', { key: 'ArrowRight' });
    expect(sliders[1].attributes('tabindex')).toBe('0');
  });

  it('uses parameter-specific bounds and keyboard increments for gate and offset', async () => {
    const gate = mountLane('gate');
    const gateSlider = gate.find('[role="slider"]');
    expect(gateSlider.attributes('aria-valuetext')).toBe('50%');
    await gateSlider.trigger('keydown', { key: 'PageUp' });
    expect(gate.emitted('set-value')).toEqual([[0, 0.75]]);

    const offset = mountLane('offset');
    const offsetSlider = offset.find('[role="slider"]');
    expect(offsetSlider.attributes('aria-valuetext')).toBe('+0.00');
    await offsetSlider.trigger('keydown', { key: 'Home' });
    expect(offset.emitted('set-value')).toEqual([[0, -0.5]]);
    await offsetSlider.trigger('keydown', { key: 'End' });
    expect(offset.emitted('set-value')).toEqual([
      [0, -0.5],
      [0, 0.5],
    ]);
  });
});
