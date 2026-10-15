import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureMixerSnapshotSlots } from '@/project/command/mixer-snapshots';
import {
  addAudioTrack,
  clearHistory,
  clearMixerSnapshots,
  removeTrack,
  saveMixerSnapshot,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('captureMixerSnapshotSlots', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    clearMixerSnapshots();
    clearHistory();
    const store = useProjectStore();
    store.dispose();
    await store.init();
  });

  it('shares the stored snapshots instead of copying them', () => {
    addAudioTrack({ name: 'Kick' });
    saveMixerSnapshot('A');

    const first = captureMixerSnapshotSlots();
    const second = captureMixerSnapshotSlots();

    expect(first.snapshots.A).toBeDefined();
    expect(first.snapshots.A).toBe(second.snapshots.A);
    expect(first.active).toBe('A');
  });

  it('keeps a captured snapshot intact when the slot is later pruned', () => {
    const trackId = addAudioTrack({ name: 'Kick' });
    saveMixerSnapshot('A');
    clearHistory();
    const captured = captureMixerSnapshotSlots();
    const trackCount = captured.snapshots.A?.tracks.length;

    removeTrack(trackId);

    expect(captured.snapshots.A?.tracks.length).toBe(trackCount);
    expect(captureMixerSnapshotSlots().snapshots.A?.tracks.length).toBe((trackCount ?? 0) - 1);
  });
});
