import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addTrack, clearHistory, removeTrack, removeTracks } from '@/project/commands';
import { getProject, useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Fails the next mirror refresh, the last step of a track removal. */
function failNextRefresh(): void {
  vi.spyOn(useProjectStore(), 'refresh').mockImplementationOnce(() => {
    throw new Error('mirror failed');
  });
}

describe('a track removal whose mirror update fails', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('undoes the native removal along with the mirror', () => {
    const id = addTrack();
    failNextRefresh();
    expect(() => removeTrack(id)).toThrow('mirror failed');
    expect(
      getProject()
        .tracks()
        .map((track) => track.id),
    ).toContain(id);
    expect(useProjectStore().tracks.map((track) => track.id)).toContain(id);
  });

  it('undoes every native removal of a batch', () => {
    const first = addTrack();
    const second = addTrack();
    failNextRefresh();
    expect(() => removeTracks([first, second])).toThrow('mirror failed');
    expect(
      getProject()
        .tracks()
        .map((track) => track.id),
    ).toEqual(expect.arrayContaining([first, second]));
  });
});
