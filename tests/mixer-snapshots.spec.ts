import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MixerSnapshots from '@/components/mixer/MixerSnapshots.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { dialogQueue, resolveDialog } from '@/composables/useDialogs';
import {
  clearHistory,
  clearMixerSnapshots,
  exportMixerSnapshotSlots,
  saveMixerSnapshot,
  setStripGain,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('MixerSnapshots', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    clearMixerSnapshots();
    clearHistory();
    dialogQueue.splice(0);
    useAppSettings().reset();
    const store = useProjectStore();
    store.dispose();
    await store.init();
  });

  afterEach(() => {
    clearMixerSnapshots();
    dialogQueue.splice(0);
    document.body.innerHTML = '';
  });

  it('asks before replacing a populated slot and preserves it when cancelled', async () => {
    const store = useProjectStore();
    saveMixerSnapshot('A');
    const before = exportMixerSnapshotSlots();
    setStripGain(store.tracks[0].id, -6);
    clearHistory();
    const wrapper = mount(MixerSnapshots, {
      global: { directives: { tooltip: () => undefined } },
    });

    await wrapper.findAll<HTMLButtonElement>('.snapshot-store')[0].trigger('click');
    const request = dialogQueue[0];
    if (!request) throw new Error('expected overwrite confirmation');
    expect(request.title).toBe('Replace mixer snapshot?');
    expect(request.message).toContain('Snapshot A already contains a mix');

    resolveDialog(request.id, false);
    await flushPromises();
    expect(exportMixerSnapshotSlots()).toEqual(before);
  });

  it('replaces a populated slot without a prompt when confirmations are disabled', async () => {
    const store = useProjectStore();
    saveMixerSnapshot('A');
    setStripGain(store.tracks[0].id, -6);
    clearHistory();
    useAppSettings().set('confirmDestructive', false);
    const wrapper = mount(MixerSnapshots, {
      global: { directives: { tooltip: () => undefined } },
    });

    await wrapper.findAll<HTMLButtonElement>('.snapshot-store')[0].trigger('click');
    await flushPromises();

    expect(dialogQueue).toHaveLength(0);
    expect(exportMixerSnapshotSlots().snapshots.A?.tracks[0].mixer.gainDb).toBe(-6);
  });
});
