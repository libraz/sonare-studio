import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MidiFxPanel from '@/components/piano-roll/MidiFxPanel.vue';

const bakeClipMidiFx = vi.fn();

vi.mock('@/project/commands', () => ({
  bakeClipMidiFx: (...args: unknown[]) => bakeClipMidiFx(...args),
}));

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  bakeClipMidiFx.mockReset();
});

/** Finds the chip button whose trimmed label matches `label`. */
function chip(w: VueWrapper, label: string) {
  return w.findAll('button.fx-chip').find((b) => b.text() === label);
}

/** Finds the Apply footer button. */
function applyButton(w: VueWrapper) {
  return w.findAll('button.fx-btn').find((b) => b.text() === 'Apply');
}

describe('MidiFxPanel', () => {
  it('disables Apply for an identity transform and enables it after a change', async () => {
    wrapper = mount(MidiFxPanel, { props: { clipId: 3 } });
    expect(applyButton(wrapper)?.attributes('disabled')).toBeDefined();

    await chip(wrapper, 'Major')?.trigger('click');
    expect(applyButton(wrapper)?.attributes('disabled')).toBeUndefined();
  });

  it('bakes the selected harmonize preset into the clip on Apply', async () => {
    wrapper = mount(MidiFxPanel, { props: { clipId: 7 } });
    await chip(wrapper, 'Major')?.trigger('click');
    await applyButton(wrapper)?.trigger('click');

    expect(bakeClipMidiFx).toHaveBeenCalledTimes(1);
    const [clipId, config] = bakeClipMidiFx.mock.calls[0];
    expect(clipId).toBe(7);
    expect(config.chordIntervals).toEqual([0, 4, 7]);
    // Apply closes the panel.
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('bakes the selected arpeggio pattern into the clip on Apply', async () => {
    wrapper = mount(MidiFxPanel, { props: { clipId: 9 } });
    await chip(wrapper, 'Up')?.trigger('click');
    await applyButton(wrapper)?.trigger('click');

    expect(bakeClipMidiFx).toHaveBeenCalledTimes(1);
    const [clipId, config] = bakeClipMidiFx.mock.calls[0];
    expect(clipId).toBe(9);
    expect(config.arpeggiatorIntervals).toEqual([0, 4, 7]);
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('does not bake a no-op transform on Apply', async () => {
    wrapper = mount(MidiFxPanel, { props: { clipId: 1 } });
    // Apply is disabled, but guard against a direct invocation too.
    await applyButton(wrapper)?.trigger('click');
    expect(bakeClipMidiFx).not.toHaveBeenCalled();
  });

  it('Reset returns every control to its identity value', async () => {
    wrapper = mount(MidiFxPanel, { props: { clipId: 1 } });
    await chip(wrapper, 'Octave')?.trigger('click');
    expect(applyButton(wrapper)?.attributes('disabled')).toBeUndefined();

    const reset = wrapper.findAll('button.fx-btn').find((b) => b.text() === 'Reset');
    await reset?.trigger('click');
    expect(applyButton(wrapper)?.attributes('disabled')).toBeDefined();
  });

  it('emits close from the header close button', async () => {
    wrapper = mount(MidiFxPanel, { props: { clipId: 1 } });
    await wrapper.find('button.fx-close').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
