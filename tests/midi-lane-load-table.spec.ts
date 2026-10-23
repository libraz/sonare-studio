import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addRecordedMidiClip, clearHistory } from '@/project/commands';
import { loadProjectDocument, serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import type { EditorClip } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

type AnyRecord = Record<string, any>;

describe('loading clip lanes through the lane-kind table', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  async function loadWith(patch: (clip: AnyRecord) => void): Promise<EditorClip> {
    const clipId = addRecordedMidiClip({
      trackId: store.tracks[0].id,
      startPpq: 0,
      lengthPpq: 4,
      notes: [],
    });
    const doc = JSON.parse(JSON.stringify(serializeProject()));
    patch(doc.tracks[0].clips.find((c: AnyRecord) => c.name === `Clip ${clipId}`));
    await loadProjectDocument(doc);
    const clip = store.clips.find((entry) => entry.name === `Clip ${clipId}`);
    if (!clip) throw new Error('clip missing after load');
    return clip;
  }

  it('merges duplicate-key lanes and orders lanes by controller then channel', async () => {
    const clip = await loadWith((c) => {
      c.ccLanes = [
        { controller: 1, channel: 2, points: [{ ppq: 1, value: 10 }] },
        { controller: 1, channel: 0, points: [{ ppq: 0, value: 20 }] },
        { controller: 1, channel: 2, points: [{ ppq: 3, value: 30 }] },
      ];
      c.programChangeLanes = [
        { channel: 1, points: [{ ppq: 2, program: 4 }] },
        { channel: 1, points: [{ ppq: 0, program: 3 }] },
      ];
    });
    expect(clip.ccLanes).toEqual([
      { controller: 1, channel: 0, points: [{ ppq: 0, value: 20 }] },
      {
        controller: 1,
        channel: 2,
        points: [
          { ppq: 1, value: 10 },
          { ppq: 3, value: 30 },
        ],
      },
    ]);
    expect(clip.programChangeLanes).toEqual([
      {
        channel: 1,
        points: [
          { ppq: 0, program: 3 },
          { ppq: 2, program: 4 },
        ],
      },
    ]);
  });

  it('keeps the table order across a save and reload', async () => {
    const first = await loadWith((c) => {
      c.ccLanes = [
        { controller: 7, channel: 3, points: [{ ppq: 1, value: 1 }] },
        { controller: 7, channel: 1, points: [{ ppq: 1, value: 2 }] },
      ];
    });
    await loadProjectDocument(JSON.parse(JSON.stringify(serializeProject())));
    const reloaded = store.clips.find((entry) => entry.name === first.name);
    expect(reloaded?.ccLanes?.map((lane) => lane.channel)).toEqual([1, 3]);
  });
});
