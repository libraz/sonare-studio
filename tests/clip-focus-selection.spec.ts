import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addTrack,
  clearHistory,
  copyActiveClip,
  deleteClip,
  duplicateClip,
  pasteClipAt,
  setActiveClip,
  setActiveTrack,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** The editor focus a command leaves behind, as the arrangement and piano roll read it. */
function focus() {
  const store = useProjectStore();
  return {
    clipId: store.clipId,
    clipSelection: [...store.clipSelection],
    clipStartPpq: store.clipStartPpq,
  };
}

describe('a command that focuses a new clip', () => {
  let sourceId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    sourceId = store.clips[0].id;
    setActiveClip(sourceId);
  });

  it('selects the pasted clip and shows its window', () => {
    const store = useProjectStore();
    copyActiveClip();
    const pasted = pasteClipAt(store.tracks[0].id, 64) as number;
    expect(focus()).toEqual({ clipId: pasted, clipSelection: [pasted], clipStartPpq: 64 });
  });

  it('selects the duplicate and shows its window', () => {
    const copy = duplicateClip(sourceId, 64);
    expect(focus()).toEqual({ clipId: copy, clipSelection: [copy], clipStartPpq: 64 });
  });

  it('selects the clip a track switch focuses', () => {
    const store = useProjectStore();
    const other = addTrack();
    const copy = duplicateClip(sourceId, 64);
    setActiveClip(copy);
    setActiveTrack(other);
    setActiveTrack(store.tracks[0].id);
    expect(focus().clipSelection).toEqual([focus().clipId]);
  });

  it('selects the clip that takes over when the active clip is deleted', () => {
    const copy = duplicateClip(sourceId, 64);
    setActiveClip(copy);
    deleteClip(copy);
    expect(focus()).toEqual({ clipId: sourceId, clipSelection: [sourceId], clipStartPpq: 0 });
  });
});
