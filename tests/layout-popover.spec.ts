import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import LayoutPopover from '@/components/score/LayoutPopover.vue';

describe('LayoutPopover', () => {
  it('does not emit an invalid grand-staff split pitch when its numeric input is cleared', async () => {
    const wrapper = mount(LayoutPopover, {
      props: {
        pageFormat: 'a4',
        landscape: false,
        pageMarginMm: 10,
        scalePercent: 100,
        spacingStaff: 8,
        barsPerSystem: 4,
        barsPerPage: 8,
        grandStaffSplitPitch: 60,
        transpose: 0,
      },
    });
    const splitInput = wrapper.find('input[min="0"][max="127"]');

    await splitInput.setValue('');

    expect(wrapper.emitted('update:grandStaffSplitPitch')).toBeUndefined();
  });
});
