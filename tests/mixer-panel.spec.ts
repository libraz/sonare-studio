import { shallowMount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MixerPanel from '@/components/mixer/MixerPanel.vue';
import { addTrack, clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('MixerPanel.vue', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('applies a built-in mixer template from the toolbar menu', async () => {
    addTrack({ name: 'Guest' });
    addTrack({ name: 'Music' });
    const wrapper = shallowMount(MixerPanel, {
      global: {
        directives: { tooltip: {} },
        stubs: {
          ChannelStrip: true,
          BusStrip: true,
          VcaStrip: true,
          MixerSnapshots: true,
          TransitionGroup: false,
        },
      },
    });

    const templateButton = wrapper
      .findAll('.toolbar-button')
      .find((button) => button.text().includes('Templates'));
    expect(templateButton).toBeTruthy();
    await templateButton!.trigger('click');

    const items = wrapper.findAll('.scene-menu .view-menu-action');
    expect(items.map((item) => item.text())).toContain('Commentary Ducking');
    const commentary = items.find((item) => item.text() === 'Commentary Ducking');
    expect(commentary).toBeTruthy();
    await commentary!.trigger('click');

    expect(store.mixer.vcaGroups).toEqual([{ id: 'voices', name: 'Voices', gainDb: 0 }]);
    expect(store.tracks[2].mixer?.inserts[0]).toMatchObject({
      processor: 'dynamics.sidechainRouter',
      sidechainSourceTrackId: store.tracks[0].id,
    });
    expect(wrapper.find('.scene-menu').exists()).toBe(false);
  });

  it('removes toolbar menu outside-click listeners on unmount', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const wrapper = shallowMount(MixerPanel, {
      global: {
        directives: { tooltip: {} },
        stubs: {
          ChannelStrip: true,
          BusStrip: true,
          VcaStrip: true,
          MixerSnapshots: true,
          TransitionGroup: false,
        },
      },
    });

    const templateButton = wrapper
      .findAll('.toolbar-button')
      .find((button) => button.text().includes('Templates'));
    await templateButton!.trigger('click');

    expect(add).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    wrapper.unmount();
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
  });

  it('changes the mixer solo audition mode from the toolbar', async () => {
    const wrapper = shallowMount(MixerPanel, {
      global: {
        directives: { tooltip: {} },
        stubs: {
          ChannelStrip: true,
          BusStrip: true,
          VcaStrip: true,
          MixerSnapshots: true,
          TransitionGroup: false,
        },
      },
    });

    const soloMode = wrapper.findComponent({ name: 'SelectMenu' });
    expect(soloMode.exists()).toBe(true);
    await soloMode.vm.$emit('update:modelValue', 'pfl');

    expect(store.mixer.soloMode).toBe('pfl');
  });
});
