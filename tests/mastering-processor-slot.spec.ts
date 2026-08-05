import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ProcessorSlot from '@/components/mastering/ProcessorSlot.vue';
import MixerKnob from '@/components/mixer/MixerKnob.vue';

describe('ProcessorSlot', () => {
  it('passes control scale and reset defaults through to mastering knobs', () => {
    const wrapper = mount(ProcessorSlot, {
      props: {
        slot: { processor: 'eq.tilt', params: {}, enabled: true },
        index: 0,
        expanded: true,
        dragging: false,
        dropTarget: false,
        canMoveUp: false,
        canMoveDown: false,
        controls: [
          {
            id: 'pivotHz',
            name: 'Pivot Hz',
            value: 1000,
            min: 20,
            max: 20000,
            scale: 'log',
            defaultValue: 1000,
            unit: 'Hz',
          },
        ],
      },
      global: { directives: { tooltip: () => undefined } },
    });

    expect(wrapper.getComponent(MixerKnob).props()).toMatchObject({
      scale: 'log',
      defaultValue: 1000,
    });
  });
});
