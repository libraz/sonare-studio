import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAudioAssetCache, computeAssetId, interleaveChannels } from '@/persistence/assets';
import { clearHistory, importExternalStems } from '@/project/commands';
import {
  loadProjectDocument,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { getProject, useProjectStore } from '@/project/store';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

interface FakeDoc {
  clips: Array<{ id: number; sourceId: number }>;
}

/** Source id and stored metadata behind each audio clip, in clip order. */
function audioUses(store: ReturnType<typeof useProjectStore>) {
  const doc = JSON.parse(getProject().toJson()) as FakeDoc;
  return store.clips
    .filter((clip) => clip.kind === 'audio')
    .map((clip) => {
      const sourceId = doc.clips.find((entry) => entry.id === clip.id)?.sourceId;
      const source = getProject()
        .sources()
        .find((entry) => entry.id === sourceId);
      return {
        role: clip.externalStemRole,
        sourceId,
        sourceRole: source?.externalStemRole,
        sourceHash: source?.contentHash,
      };
    });
}

describe('external stem role belongs to the clip that uses the stem', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    clearAudioAssetCache();
    installMockOpfs();
    await store.init();
  });

  afterEach(() => {
    uninstallMockOpfs();
    clearAudioAssetCache();
  });

  it('keeps each use its own role when identical stems share one source, before and after a reload', async () => {
    const channels = [new Float32Array([1, 2, 3, 4])];
    const assetId = computeAssetId(interleaveChannels(channels), 4, 1);
    await importExternalStems(
      [
        { channels, sampleRate: 4, name: 'Take as vocals', role: 'vocals' },
        { channels, sampleRate: 4, name: 'Take as bass', role: 'bass' },
      ],
      { startPpq: 0 },
    );

    const session = audioUses(store);
    expect(session.map((use) => use.role)).toEqual(['vocals', 'bass']);
    expect(session[0].sourceId).toBe(session[1].sourceId);
    for (const use of session) {
      expect(use.sourceRole).toBeUndefined();
      expect(use.sourceHash).toBe(assetId);
    }

    await loadProjectDocument(JSON.parse(JSON.stringify(serializeProject())) as ProjectDocument);
    expect(audioUses(store)).toEqual(
      session.map((use) => ({ ...use, sourceId: expect.any(Number) })),
    );
  });
});
