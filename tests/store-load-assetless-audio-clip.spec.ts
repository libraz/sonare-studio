import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getProject, useProjectStore } from '@/project/store';
import { createTemplate } from '@/project/templates';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

describe('loadDocument audio clip without an asset', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    await useProjectStore().init();
  });

  it('is a MIDI clip in both the native project and the mirror', async () => {
    const store = useProjectStore();
    const doc = createTemplate('band');
    const track = doc.tracks[0];
    track.clips = [{ ...track.clips[0], kind: 'audio' }];
    delete track.clips[0].assetId;

    await store.loadDocument(doc);

    expect(
      getProject()
        .sources()
        .every((source) => source.kind === 'midi'),
    ).toBe(true);
    expect(store.clips.every((clip) => clip.kind !== 'audio')).toBe(true);
  });
});
