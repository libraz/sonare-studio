import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import InsertRack from '@/components/mixer/InsertRack.vue';
import MixerKnob from '@/components/mixer/MixerKnob.vue';
import type { MeterSource } from '@/engine/meters';
import { addAudioTrack, addGroupTrack, addInsert, clearHistory, undo } from '@/project/commands';
import { createDefaultStrip, type InsertSlot } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import {
  addInsertSlot,
  adjustExpandedAfterRemove,
  type InsertRackCommands,
  removeInsertSlot,
  reorderInsertSlots,
  toggleInsertEnabled,
} from '@/ui/mixer/insert-rack';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

/** Builds a fully mocked command layer for rack assertions. */
function mockCommands(addReturn = 0): InsertRackCommands {
  return {
    addInsert: vi.fn(() => addReturn),
    removeInsert: vi.fn(),
    reorderInsert: vi.fn(),
    setInsertEnabled: vi.fn(),
    setInsertSidechain: vi.fn(),
  };
}

function slot(enabled: boolean): InsertSlot {
  return { processor: 'dynamics.compressor', params: {}, enabled };
}

describe('addInsertSlot', () => {
  it('adds the processor and returns the new slot index', () => {
    const commands = mockCommands(2);
    expect(addInsertSlot(5, 'saturation.tape', commands)).toBe(2);
    expect(commands.addInsert).toHaveBeenCalledWith(5, 'saturation.tape');
  });

  it('targets the master strip', () => {
    const commands = mockCommands();
    addInsertSlot('master', 'eq.parametric', commands);
    expect(commands.addInsert).toHaveBeenCalledWith('master', 'eq.parametric');
  });
});

describe('removeInsertSlot', () => {
  it('removes by target and index', () => {
    const commands = mockCommands();
    removeInsertSlot(7, 1, commands);
    expect(commands.removeInsert).toHaveBeenCalledWith(7, 1);
  });
});

describe('toggleInsertEnabled', () => {
  it('bypasses an enabled slot', () => {
    const commands = mockCommands();
    toggleInsertEnabled('master', 0, slot(true), commands);
    expect(commands.setInsertEnabled).toHaveBeenCalledWith('master', 0, false);
  });

  it('re-enables a bypassed slot', () => {
    const commands = mockCommands();
    toggleInsertEnabled(3, 2, slot(false), commands);
    expect(commands.setInsertEnabled).toHaveBeenCalledWith(3, 2, true);
  });
});

describe('adjustExpandedAfterRemove', () => {
  it('keeps null collapsed', () => {
    expect(adjustExpandedAfterRemove(null, 0)).toBeNull();
  });

  it('collapses when the expanded slot was removed', () => {
    expect(adjustExpandedAfterRemove(1, 1)).toBeNull();
  });

  it('shifts down when an earlier slot was removed', () => {
    expect(adjustExpandedAfterRemove(2, 0)).toBe(1);
  });

  it('keeps the index when a later slot was removed', () => {
    expect(adjustExpandedAfterRemove(1, 3)).toBe(1);
  });
});

describe('reorderInsertSlots', () => {
  /** Three inserts where the last carries a sidechain key source. */
  function chain(): InsertSlot[] {
    return [
      { processor: 'eq.parametric', params: { gain: 1 }, enabled: true },
      { processor: 'saturation.tape', params: {}, enabled: false },
      {
        processor: 'dynamics.duckingProcessor',
        params: {},
        enabled: true,
        sidechainSourceTrackId: 9,
      },
    ];
  }

  it('delegates reorder to the atomic command layer', () => {
    const commands = mockCommands();
    reorderInsertSlots(7, chain(), 2, 0, commands);
    expect(commands.reorderInsert).toHaveBeenCalledWith(7, 2, 0);
    expect(commands.removeInsert).not.toHaveBeenCalled();
    expect(commands.addInsert).not.toHaveBeenCalled();
    expect(commands.setInsertEnabled).not.toHaveBeenCalled();
    expect(commands.setInsertSidechain).not.toHaveBeenCalled();
  });

  it('is a no-op for an unchanged position', () => {
    const commands = mockCommands();
    reorderInsertSlots(7, chain(), 1, 1, commands);
    expect(commands.reorderInsert).not.toHaveBeenCalled();
    expect(commands.removeInsert).not.toHaveBeenCalled();
    expect(commands.addInsert).not.toHaveBeenCalled();
  });
});

describe('InsertRack sidechain source options', () => {
  it('passes logarithmic scale and a reset default to insert parameter knobs', async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    const targetId = store.tracks[0].id;
    addInsert(targetId, 'eq.tilt');
    const wrapper = mount(InsertRack, {
      props: { target: targetId },
      global: { directives: { tooltip: () => undefined } },
    });

    await wrapper.find('.insert-name').trigger('click');
    const pivot = wrapper
      .findAllComponents(MixerKnob)
      .find((knob) => knob.props('label') === 'Pivot Hz');
    expect(pivot?.props()).toMatchObject({ scale: 'log', defaultValue: 1000 });
  });

  it('renders compressor booleans and enums with typed controls', async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    const targetId = store.tracks[0].id;
    addInsert(targetId, 'dynamics.compressor');
    const wrapper = mount(InsertRack, {
      props: { target: targetId },
      global: { directives: { tooltip: () => undefined } },
    });

    await wrapper.find('.insert-name').trigger('click');
    expect(wrapper.findAll('.insert-param-toggle')).toHaveLength(2);
    expect(wrapper.find('.insert-param-select').exists()).toBe(true);

    await wrapper.find('.insert-param-toggle').trigger('click');
    expect(store.tracks[0].mixer?.inserts[0].params.autoMakeup).toBe(true);
  });

  it('removes the add-menu outside-click listener on unmount', async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const wrapper = mount(InsertRack, {
      props: { target: 'master' },
      global: {
        directives: {
          tooltip: () => undefined,
        },
        stubs: {
          MixerKnob: true,
          SelectMenu: true,
          Teleport: true,
        },
      },
    });

    await wrapper.find('.insert-add').trigger('click');

    expect(add).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    wrapper.unmount();
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
  });

  it('commits an active parameter gesture when unmounted', async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    await store.init();
    const targetId = store.tracks[0].id;
    store.tracks = store.tracks.map((track) =>
      track.id === targetId ? { ...track, mixer: createDefaultStrip() } : track,
    );
    addInsert(targetId, 'eq.tilt');
    clearHistory();

    const wrapper = mount(InsertRack, {
      props: { target: targetId },
      global: { directives: { tooltip: () => undefined } },
    });
    await wrapper.find('.insert-name').trigger('click');
    wrapper.findComponent({ name: 'MixerKnob' }).vm.$emit('change', 3.5, false);
    expect(store.tracks[0].mixer?.inserts[0].params.tiltDb).toBe(3.5);

    wrapper.unmount();
    undo();
    expect(store.tracks[0].mixer?.inserts[0].params.tiltDb).toBeUndefined();
  });

  it('lists group tracks as sidechain key sources for track inserts', async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    const targetId = store.tracks[0].id;
    const sourceId = addAudioTrack({ name: 'Kick' });
    const groupId = addGroupTrack({ name: 'Drum Bus' });
    store.tracks = store.tracks.map((track) =>
      track.id === targetId ? { ...track, mixer: createDefaultStrip() } : track,
    );
    addInsert(targetId, 'dynamics.sidechainRouter');

    const wrapper = mount(InsertRack, {
      props: { target: targetId },
      global: {
        directives: {
          tooltip: () => undefined,
        },
        stubs: {
          MixerKnob: true,
          Teleport: true,
        },
      },
    });

    await wrapper.find('.insert-name').trigger('click');
    await wrapper.find('.insert-sidechain-select .select-trigger').trigger('click');
    await wrapper.vm.$nextTick();

    const labels = wrapper.findAll('.select-option').map((option) => option.text());
    expect(labels).toEqual(['No key', 'Kick']);
    expect(labels).not.toContain(store.tracks.find((track) => track.id === targetId)?.name);
    expect(sourceId).not.toBe(groupId);
    wrapper.unmount();
  });

  it('disables sources the engine refuses and explains why', async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    const targetId = store.tracks[0].id;
    const kickId = addAudioTrack({ name: 'Kick' });
    addAudioTrack({ name: 'Snare' });
    store.tracks = store.tracks.map((track) =>
      track.id === targetId ? { ...track, mixer: createDefaultStrip() } : track,
    );
    addInsert(targetId, 'dynamics.sidechainRouter');
    const sidechainRefusal = vi.fn((_target, _index, source: { kind: string; trackId?: number }) =>
      source.trackId === kickId ? ('planRefused' as const) : null,
    );

    const wrapper = mount(InsertRack, {
      props: { target: targetId, sidechainRefusal },
      global: {
        directives: { tooltip: () => undefined },
        stubs: { MixerKnob: true, Teleport: true },
      },
    });
    await wrapper.find('.insert-name').trigger('click');
    await wrapper.find('.insert-sidechain-select .select-trigger').trigger('click');
    await wrapper.vm.$nextTick();

    const kick = wrapper.findAll('.select-option').find((option) => option.text().includes('Kick'));
    expect(kick?.attributes('aria-disabled')).toBe('true');
    expect(kick?.text()).toContain('The engine cannot align this key');
    const snare = wrapper
      .findAll('.select-option')
      .find((option) => option.text().includes('Snare'));
    expect(snare?.attributes('aria-disabled')).not.toBe('true');
    expect(sidechainRefusal).toHaveBeenCalledWith(targetId, 0, { kind: 'track', trackId: kickId });
    wrapper.unmount();
  });
});

describe('InsertRack per-insert gain reduction', () => {
  function meterWith() {
    let listener: ((values: readonly number[]) => void) | null = null;
    const unsubscribe = vi.fn();
    const meter: MeterSource = {
      latest: {
        frame: 0,
        peakDbL: -120,
        peakDbR: -120,
        rmsDbL: -120,
        rmsDbR: -120,
        correlation: 0,
      },
      subscribe: () => () => {},
      subscribeInsertGainReduction: (next) => {
        listener = next;
        return unsubscribe;
      },
    };
    return { meter, emit: (values: readonly number[]) => listener?.(values), unsubscribe };
  }

  it('shows a readout only on slots that reduce and keeps it while idle', async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    const targetId = store.tracks[0].id;
    store.tracks = store.tracks.map((track) =>
      track.id === targetId ? { ...track, mixer: createDefaultStrip() } : track,
    );
    addInsert(targetId, 'eq.tilt');
    addInsert(targetId, 'dynamics.compressor');
    const { meter, emit, unsubscribe } = meterWith();
    const wrapper = mount(InsertRack, {
      props: { target: targetId, meter },
      global: { directives: { tooltip: () => undefined }, stubs: { MixerKnob: true } },
    });

    expect(wrapper.findAll('.insert-gr')).toHaveLength(0);
    emit([0, -3.24]);
    await wrapper.vm.$nextTick();
    const slots = wrapper.findAll('.insert-slot');
    expect(slots[0].find('.insert-gr').exists()).toBe(false);
    expect(slots[1].find('.insert-gr').text()).toBe('-3.2');
    expect(slots[1].find('.insert-gr').classes()).toContain('active');

    emit([0, 0]);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.insert-slot')[1].find('.insert-gr').text()).toBe('0.0');
    expect(wrapper.findAll('.insert-slot')[1].find('.insert-gr').classes()).not.toContain('active');

    await wrapper.setProps({ visible: false });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
