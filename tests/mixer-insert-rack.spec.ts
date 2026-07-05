import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import InsertRack from '@/components/mixer/InsertRack.vue';
import { addAudioTrack, addGroupTrack, addInsert, clearHistory } from '@/project/commands';
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
  it('removes the add-menu outside-click listener on unmount', async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
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
    expect(labels).toEqual(['No key', 'Kick', 'Drum Bus']);
    expect(labels).not.toContain(store.tracks.find((track) => track.id === targetId)?.name);
    expect(sourceId).not.toBe(groupId);
    wrapper.unmount();
  });
});
