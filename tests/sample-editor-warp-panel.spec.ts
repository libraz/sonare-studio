import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SampleEditorWarpPanel from '@/components/sample-editor/SampleEditorWarpPanel.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(SampleEditorWarpPanel, {
    props: {
      warpBpmInput: '120',
      warpEnabled: true,
      warpAnchors: [
        { ppq: 0, sourceSeconds: 0 },
        { ppq: 960, sourceSeconds: 1.5 },
      ],
      warpRatioHint: '×1.00',
      warpOffBlocked: null,
      addAnchorBlocked: null,
      ...props,
    },
    global: { directives: { tooltip: () => {} }, stubs: { ToggleButton: true } },
  });
}

describe('SampleEditorWarpPanel', () => {
  it('emits one event per warp action', async () => {
    const wrapper = mountPanel();
    wrapper.findComponent(ToggleButton).vm.$emit('update:model-value', false);
    await wrapper.find('.warp-source-bpm').trigger('change');
    await wrapper.find('.warp-anchor-add').trigger('click');
    await wrapper.find('.warp-auto').trigger('click');
    await wrapper.findAll('.warp-anchor-remove')[1].trigger('click');

    expect(wrapper.emitted('toggle-warp')).toHaveLength(1);
    expect(wrapper.emitted('warp-bpm-change')).toHaveLength(1);
    expect(wrapper.emitted('add-anchor')).toHaveLength(1);
    expect(wrapper.emitted('auto-warp')).toHaveLength(1);
    expect(wrapper.emitted('remove-anchor')).toEqual([[1]]);
  });

  it('carries the change event of an anchor field with its index and field', async () => {
    const wrapper = mountPanel();
    const inputs = wrapper.findAll('.warp-anchor input');
    await inputs[2].trigger('change');
    await inputs[3].trigger('change');

    const edits = wrapper.emitted('anchor-edit') ?? [];
    expect(edits.map(([index, field]) => [index, field])).toEqual([
      [1, 'ppq'],
      [1, 'sourceSeconds'],
    ]);
    expect(edits[0][2]).toBeInstanceOf(Event);
  });

  it('writes the source BPM back through the model as a number', async () => {
    const wrapper = mountPanel();
    await wrapper.find('.warp-source-bpm').setValue('90');
    expect(wrapper.emitted('update:warpBpmInput')?.[0]).toEqual([90]);
  });

  it('disables the anchor controls with the blocked reason and hides an empty ratio hint', () => {
    const wrapper = mountPanel({
      warpOffBlocked: 'off',
      addAnchorBlocked: 'full',
      warpRatioHint: '',
    });
    expect(wrapper.find('.warp-source-bpm').attributes('disabled')).toBeDefined();
    expect(wrapper.find('.warp-anchor-add').attributes('disabled')).toBeDefined();
    expect(wrapper.find('.warp-anchor-remove').attributes('disabled')).toBeDefined();
    expect(wrapper.find('.warp-segments').exists()).toBe(false);
  });
});
