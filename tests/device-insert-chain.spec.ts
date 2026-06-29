import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import DeviceInsertChain from '@/components/devices/DeviceInsertChain.vue';
import type { InsertSlot } from '@/project/mixer';

/** Three distinct inserts to drag among. */
const inserts: InsertSlot[] = [
  { processor: 'dynamics.compressor', params: {}, enabled: true },
  { processor: 'eq.tilt', params: {}, enabled: true },
  { processor: 'saturation.tape', params: {}, enabled: true },
];

function mountChain() {
  return mount(DeviceInsertChain, {
    props: {
      inserts,
      selectedDevice: 'instrument' as const,
      addInsertValue: '',
      addInsertOptions: [],
    },
  });
}

describe('DeviceInsertChain reorder', () => {
  it('emits moveInsert with the dragged and dropped indices', async () => {
    const wrapper = mountChain();
    const rows = wrapper.findAll('.insert-row');
    await rows[2].trigger('dragstart');
    await rows[0].trigger('dragenter');
    await rows[0].trigger('drop');
    expect(wrapper.emitted('moveInsert')).toEqual([[2, 0]]);
  });

  it('does not emit when a row is dropped on itself', async () => {
    const wrapper = mountChain();
    const rows = wrapper.findAll('.insert-row');
    await rows[1].trigger('dragstart');
    await rows[1].trigger('drop');
    expect(wrapper.emitted('moveInsert')).toBeUndefined();
  });

  it('does not emit when nothing is being dragged', async () => {
    const wrapper = mountChain();
    await wrapper.findAll('.insert-row')[0].trigger('drop');
    expect(wrapper.emitted('moveInsert')).toBeUndefined();
  });
});
