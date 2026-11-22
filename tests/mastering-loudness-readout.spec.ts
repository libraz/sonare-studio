import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import MasteringLoudnessReadout from '@/components/mastering/MasteringLoudnessReadout.vue';
import type { LoudnessRow } from '@/ui/mastering/loudness';

const ROWS: LoudnessRow[] = [
  { label: 'Integrated', a: -9.4, b: -14.2, unit: 'LUFS', barScale: 'level' },
];

describe('MasteringLoudnessReadout', () => {
  it('shows why the preset missed its loudness target, apart from the clipping alert', () => {
    const wrapper = mount(MasteringLoudnessReadout, {
      props: {
        rows: ROWS,
        clipWarning: false,
        clipCensus: '',
        targetLimited: 'The preset stopped short of its loudness target',
      },
    });
    const note = wrapper.find('[role="status"]');
    expect(note.text()).toBe('The preset stopped short of its loudness target');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('shows nothing when the preset reached its target', () => {
    const wrapper = mount(MasteringLoudnessReadout, {
      props: { rows: ROWS, clipWarning: false, clipCensus: '', targetLimited: '' },
    });
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });
});
