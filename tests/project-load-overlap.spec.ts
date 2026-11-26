import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getProject, useProjectStore } from '@/project/store';
import { createTemplate } from '@/project/templates';
import { FakeProject } from './fake-wasm';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

describe('overlapping document clips', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    await store.init();
  });

  it('allows a sub-nanobeat overlap that the native policy considers real', async () => {
    const doc = createTemplate('band');
    const track = doc.tracks[0];
    const first = { ...track.clips[0], lengthPpq: 1.0000000005 };
    track.clips = [first, { ...first, startPpq: 1, lengthPpq: 1 }];

    await store.loadDocument(doc);

    expect(getProject().overlapPolicy).toBe('allow');
    expect(store.clips.filter((clip) => clip.trackId === store.tracks[0].id)).toHaveLength(2);
  });

  it('omits an unusable tempo ramp target when hydrating the project', async () => {
    const setTempoSegments = vi.spyOn(FakeProject.prototype, 'setTempoSegments');
    const doc = createTemplate('band');
    doc.tempoSegments = [{ startPpq: 0, bpm: 120, endBpm: 0 }];

    await store.loadDocument(doc);

    expect(setTempoSegments.mock.calls.at(-1)?.[0]).toStrictEqual([{ startPpq: 0, bpm: 120 }]);
    setTempoSegments.mockRestore();
  });

  it('detects overlap after invalid lengths are normalized', async () => {
    const doc = createTemplate('band');
    const track = doc.tracks[0];
    const first = { ...track.clips[0], lengthPpq: -1 };
    track.clips = [first, { ...first, startPpq: 0.5, lengthPpq: 1 }];

    await store.loadDocument(doc);

    expect(getProject().overlapPolicy).toBe('allow');
  });
});
