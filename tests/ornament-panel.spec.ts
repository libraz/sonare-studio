import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OrnamentPanel from '@/components/piano-roll/OrnamentPanel.vue';
import { ORNAMENT_MARKS } from '@/compose/ornaments';
import { addNote, clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/**
 * The panel's one job beyond wiring is honesty about what Apply would do: the
 * count is what tells a writer that a technique has nothing to sit on here,
 * which is a property of the passage rather than of the setting.
 */
describe('OrnamentPanel', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  function mountPanel() {
    return mount(OrnamentPanel, {
      props: { clipId: store.clipId },
      global: { directives: { tooltip: () => undefined } },
    });
  }

  /** A run of eighths, which gives weak positions for a ghost to fall on. */
  function addEighths(count = 16): void {
    for (let index = 0; index < count; index += 1) {
      addNote({ pitch: 48 + (index % 4), startPpq: index * 0.5, durationPpq: 0.5 });
    }
  }

  it('offers every technique and marks the chosen one', async () => {
    addEighths();
    const wrapper = mountPanel();

    const segments = wrapper.findAll('.orn-segment');
    expect(segments).toHaveLength(ORNAMENT_MARKS.length);
    expect(segments[0].classes()).toContain('orn-segment-active');

    await segments[1].trigger('click');
    expect(segments[1].classes()).toContain('orn-segment-active');
    expect(segments[0].classes()).not.toContain('orn-segment-active');
    wrapper.unmount();
  });

  it('counts what Apply would mark before anything is written', () => {
    addEighths();
    const wrapper = mountPanel();

    expect(wrapper.find('.orn-preview').text()).toMatch(/\d+ of 16 notes/);
    // Reading the count must not have annotated anything.
    expect(store.scoreAnnotations).toEqual({});
    wrapper.unmount();
  });

  it('says so and refuses to apply when the technique has no position here', () => {
    // Whole notes on the downbeat: strong positions only, so a ghost has nowhere.
    for (let index = 0; index < 4; index += 1) {
      addNote({ pitch: 60, startPpq: index * 4, durationPpq: 4 });
    }
    const wrapper = mountPanel();

    expect(wrapper.find('.orn-preview').text()).toBe('Nothing this technique can sit on here');
    expect(wrapper.find('.orn-btn-primary').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('writes the counted marks on apply and closes', async () => {
    addEighths();
    const wrapper = mountPanel();
    const counted = Number(
      wrapper
        .find('.orn-preview')
        .text()
        .match(/(\d+) of/)?.[1],
    );
    expect(counted).toBeGreaterThan(0);

    await wrapper.find('.orn-btn-primary').trigger('click');

    const entries = store.scoreAnnotations[store.clipId] ?? {};
    expect(Object.keys(entries)).toHaveLength(counted);
    expect(Object.values(entries).every((entry) => entry.articulation === 'ghost')).toBe(true);
    expect(wrapper.emitted('close')).toHaveLength(1);
    wrapper.unmount();
  });
});
