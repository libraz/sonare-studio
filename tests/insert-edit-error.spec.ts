import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import MixerKnob from '@/components/mixer/MixerKnob.vue';
import { InsertConfigurationRefusedError } from '@/project/processor-controls';
import { en } from '@/ui/i18n/en';
import { insertEditErrorMessage } from '@/ui/mixer/insert-edit-error';
import { vTooltip } from '@/ui/tooltip';

describe('insertEditErrorMessage', () => {
  it('names the coupled keys a refused edit runs into', () => {
    const refused = new InsertConfigurationRefusedError(
      'effects.reverb.room',
      'receiverSpacingM',
      ['lengthM', 'widthM'],
      'left receiver lies outside the room',
    );
    expect(insertEditErrorMessage(refused, en)).toBe(
      'Receiver Spacing M cannot take this value with the current Length M, Width M.',
    );
  });

  it('keeps any other error message', () => {
    expect(insertEditErrorMessage(new RangeError('bad value'), en)).toBe('bad value');
  });
});

describe('MixerKnob note', () => {
  it('appends a standing remark to the tooltip', () => {
    const wrapper = mount(MixerKnob, {
      props: {
        value: 7,
        min: 5,
        max: 20,
        label: 'Length M',
        display: '7 m',
        note: 'Range moves with Listener X',
      },
      global: { directives: { tooltip: vTooltip } },
    });
    expect(wrapper.find('[role="slider"]').attributes('aria-description')).toContain(
      'Range moves with Listener X',
    );
    wrapper.unmount();
  });
});
