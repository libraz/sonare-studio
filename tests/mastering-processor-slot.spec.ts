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
        processorRuntime: 'unknown',
        controls: [
          {
            kind: 'number',
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

  it('renders boolean and enum processor controls with native-value intents', async () => {
    const wrapper = mount(ProcessorSlot, {
      props: {
        slot: { processor: 'dynamics.compressor', params: {}, enabled: true },
        index: 0,
        expanded: true,
        dragging: false,
        dropTarget: false,
        canMoveUp: false,
        canMoveDown: false,
        processorRuntime: 'unknown',
        controls: [
          {
            kind: 'boolean',
            id: 'autoMakeup',
            name: 'Auto Makeup',
            value: false,
            defaultValue: false,
          },
          {
            kind: 'enum',
            id: 'detector',
            name: 'Detector',
            value: 0,
            options: [
              { value: 0, label: 'Peak' },
              { value: 1, label: 'RMS' },
            ],
            defaultValue: 0,
          },
        ],
      },
      global: {
        directives: { tooltip: () => undefined },
        stubs: { SelectMenu: true },
      },
    });

    expect(wrapper.find('.chain-param-toggle').exists()).toBe(true);
    expect(wrapper.find('.chain-param-select').exists()).toBe(true);
    await wrapper.find('.chain-param-toggle').trigger('click');
    expect(wrapper.emitted('param-change')?.at(-1)).toEqual([0, expect.anything(), 1, true]);
  });
});
