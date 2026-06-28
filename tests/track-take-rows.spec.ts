import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TrackTakeRows from '@/components/arrangement/track-header/TrackTakeRows.vue';

describe('TrackTakeRows', () => {
  it('renders one labelled row per take', () => {
    const wrapper = mount(TrackTakeRows, { props: { rowCount: 3, rowHeight: 40 } });
    const rows = wrapper.findAll('.take-label-row');
    expect(rows).toHaveLength(3);
    expect(rows[0].text()).toBe('Take 1');
    expect(rows[2].text()).toBe('Take 3');
  });

  it('marks the active take row and leaves the rest unmarked', () => {
    const wrapper = mount(TrackTakeRows, {
      props: { rowCount: 3, rowHeight: 40, activeTake: 1 },
    });
    const rows = wrapper.findAll('.take-label-row');
    expect(rows[0].classes()).not.toContain('take-active');
    expect(rows[1].classes()).toContain('take-active');
    expect(rows[2].classes()).not.toContain('take-active');
  });

  it('marks no row when no take is active', () => {
    const wrapper = mount(TrackTakeRows, {
      props: { rowCount: 2, rowHeight: 40, activeTake: -1 },
    });
    expect(wrapper.find('.take-active').exists()).toBe(false);
  });

  it('marks no row when the active take prop is absent', () => {
    const wrapper = mount(TrackTakeRows, { props: { rowCount: 2, rowHeight: 40 } });
    expect(wrapper.find('.take-active').exists()).toBe(false);
  });
});
