import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveClip, setClipSelection } from '@/project/command/clips-state';
import { useProjectStore } from '@/project/store';
import { createTemplate } from '@/project/templates';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

describe('setActiveClip', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    await store.init();
    await store.loadDocument(createTemplate('band'));
  });

  it('collapses the selections to the active clip even when it is already active', () => {
    const store = useProjectStore();
    const [first, second] = store.clips;
    setClipSelection([first.id, second.id], first.id);
    store.selection = new Set([1]);
    expect(store.clipId).toBe(first.id);

    setActiveClip(first.id);

    expect([...store.clipSelection]).toEqual([first.id]);
    expect([...store.trackSelection]).toEqual([first.trackId]);
    expect(store.selection.size).toBe(0);
  });
});
