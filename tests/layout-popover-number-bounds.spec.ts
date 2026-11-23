import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import LayoutPopover from '@/components/score/LayoutPopover.vue';

function mountPopover() {
  return mount(LayoutPopover, {
    props: {
      pageFormat: 'a4',
      landscape: false,
      pageMarginMm: 10,
      scalePercent: 50,
      spacingStaff: 8,
      barsPerSystem: 4,
      barsPerPage: 8,
      grandStaffSplitPitch: 60,
      transpose: 0,
    },
  });
}

const FIELDS = [
  { event: 'update:pageMarginMm', max: '40', valid: '12.5', invalid: ['', '41', '-1'] },
  { event: 'update:scalePercent', max: '100', valid: '75', invalid: ['', '10', '200', '55.5'] },
  { event: 'update:spacingStaff', max: '48', valid: '16', invalid: ['', '49', '3.5'] },
  { event: 'update:barsPerSystem', max: '12', valid: '6', invalid: ['', '13', '2.5'] },
] as const;

describe('LayoutPopover numeric layout fields', () => {
  for (const field of FIELDS) {
    it(`emits only in-range values for ${field.event}`, async () => {
      const wrapper = mountPopover();
      const input = wrapper.find(`input[max="${field.max}"]`);
      for (const value of field.invalid) await input.setValue(value);
      expect(wrapper.emitted(field.event)).toBeUndefined();
      await input.setValue(field.valid);
      expect(wrapper.emitted(field.event)).toEqual([[Number(field.valid)]]);
    });
  }

  it('emits only in-range values for bars per page', async () => {
    const wrapper = mountPopover();
    const input = wrapper.findAll('input[max="48"]')[1];
    for (const value of ['', '49', '1.5']) await input.setValue(value);
    expect(wrapper.emitted('update:barsPerPage')).toBeUndefined();
    await input.setValue('24');
    expect(wrapper.emitted('update:barsPerPage')).toEqual([[24]]);
  });
});
